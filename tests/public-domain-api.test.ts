import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { startInstance, type DatabaseProbe, type RunningInstance } from "../src/instance.js";
import {
  WorkspaceProjectService,
  type MemberAccessResolver,
  type PortableIdentity,
  type PortableProjectProjection,
  type PortableWorkspaceProjection,
  type WorkspaceProjectRecord,
  type WorkspaceProjectRepository,
  type WorkspaceRecord,
} from "../src/workspaces-projects.js";

class PublicApiFake implements DatabaseProbe, WorkspaceProjectRepository {
  readonly workspaces = new Map<string, WorkspaceRecord>();
  failure: Error | undefined;

  async verifyConnection() {}
  async close() {}
  async findPortableMemberIdentity(memberId: string): Promise<PortableIdentity | undefined> {
    return memberId === "ada" ? { localAccountId: "ada", displayName: "Ada Lovelace" } : undefined;
  }
  async createWorkspace(record: WorkspaceRecord, createdBy: PortableIdentity) {
    if (this.failure) throw this.failure;
    if (record.owner.type === "organization") return { status: "organization_forbidden" as const };
    this.workspaces.set(record.id, record);
    const projection: PortableWorkspaceProjection = {
      schema: "stash.workspace.v1", id: record.id, name: record.name,
      owner: { type: "personal", identity: createdBy }, createdBy,
    };
    return { status: "created" as const, projection };
  }
  async createProject(_memberId: string, _record: WorkspaceProjectRecord, _projection: PortableProjectProjection) {
    return "workspace_not_found" as const;
  }
}

const access: MemberAccessResolver = {
  async authenticateBearer(authorization) {
    return authorization === "Bearer member-ada" ? { accountId: "ada", sessionId: "session-ada" } : undefined;
  },
};

describe("the versioned public domain API", () => {
  let instance: RunningInstance | undefined;
  afterEach(async () => { await instance?.close(); instance = undefined; });

  async function run() {
    const database = new PublicApiFake();
    instance = await startInstance({ database, host: "127.0.0.1", port: 0, instanceAdminToken: "instance-admin",
      workspaceProjects: new WorkspaceProjectService(database), memberAccess: access });
    const postWorkspace = (path: string, body: unknown, token = "member-ada") => fetch(`${instance!.url}${path}`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body),
    });
    return { database, postWorkspace };
  }

  it("documents its stable version and Member-session authentication contract", async () => {
    await run();
    const response = await fetch(`${instance!.url}/api/v1`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("stash-api-version"), "1");
    assert.deepEqual(await response.json(), {
      api: "stash.domain", version: "1", authentication: { scheme: "bearer", credential: "member_session" }, basePath: "/api/v1",
    });
    const unsupported = await fetch(`${instance!.url}/api/v1`, { method: "POST" });
    assert.equal(unsupported.status, 405);
    assert.equal(unsupported.headers.get("stash-api-version"), "1");
  });

  it("uses the same permission-aware Workspace capability as the application route", async () => {
    const { database, postWorkspace } = await run();
    const request = { name: "Private notes", owner: { type: "personal" } };
    const response = await postWorkspace("/api/v1/workspaces", request);
    assert.equal(response.status, 201);
    assert.equal(response.headers.get("stash-api-version"), "1");
    assert.equal(database.workspaces.size, 1);

    const legacy = await postWorkspace("/api/workspaces", request);
    assert.equal(legacy.status, 201);
    assert.equal(legacy.headers.get("stash-api-version"), null);
    assert.equal(database.workspaces.size, 2);

    const denied = await postWorkspace("/api/v1/workspaces", request, "not-a-session");
    assert.equal(denied.status, 401);
    assert.deepEqual(await denied.json(), { error: "unauthorized", message: "A valid Member session is required." });
    assert.equal(database.workspaces.size, 2);
  });

  it("returns visible permission, validation, and recoverable failures without leaking causes", async () => {
    const { database, postWorkspace } = await run();
    const forbidden = await postWorkspace("/api/v1/workspaces", {
      name: "Acme", owner: { type: "organization", organizationId: "11111111-1111-4111-8111-111111111111" },
    });
    assert.equal(forbidden.status, 403);
    assert.equal((await forbidden.json() as { error: string }).error, "organization_forbidden");

    const invalid = await postWorkspace("/api/v1/workspaces", { name: "", owner: { type: "personal" } });
    assert.equal(invalid.status, 422);
    assert.equal((await invalid.json() as { error: string }).error, "invalid_input");

    database.failure = new Error("postgres://member:secret@database/stash");
    const unavailable = await postWorkspace("/api/v1/workspaces", { name: "Safe failure", owner: { type: "personal" } });
    assert.equal(unavailable.status, 503);
    const unavailableBody = JSON.stringify(await unavailable.json());
    assert.match(unavailableBody, /workspace_unavailable/);
    assert.doesNotMatch(unavailableBody, /postgres|secret|database/);
  });

  it("does not expose authentication or Instance-administration routes as domain capabilities", async () => {
    await run();
    for (const path of ["/api/v1/auth/password/login", "/api/v1/admin/diagnostics", "/api/v1/unknown"]) {
      const response = await fetch(`${instance!.url}${path}`);
      assert.equal(response.status, 404);
      assert.equal(response.headers.get("stash-api-version"), "1");
      assert.equal((await response.json() as { error: string }).error, "not_found");
    }
  });
});

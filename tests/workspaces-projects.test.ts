import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { startInstance, type DatabaseProbe, type RunningInstance } from "../src/instance.js";
import {
  WorkspaceProjectService,
  type MemberAccessResolver,
  type WorkspaceProjectRecord,
  type WorkspaceProjectRepository,
  type WorkspaceRecord,
} from "../src/workspaces-projects.js";

class ProtocolCompatibleDatabase implements DatabaseProbe, WorkspaceProjectRepository {
  readonly organizationMembers = new Map<string, Set<string>>();
  readonly workspaces = new Map<string, WorkspaceRecord>();
  readonly projects = new Map<string, WorkspaceProjectRecord>();
  failure: Error | undefined;

  async verifyConnection(): Promise<void> {}
  async close(): Promise<void> {}

  async createWorkspace(record: WorkspaceRecord): Promise<"created" | "organization_forbidden"> {
    if (this.failure) throw this.failure;
    if (
      record.owner.type === "organization"
      && !this.organizationMembers.get(record.owner.id)?.has(record.createdByMemberId)
    ) return "organization_forbidden";
    this.workspaces.set(record.id, record);
    return "created";
  }

  async createProject(
    memberId: string,
    record: WorkspaceProjectRecord,
  ): Promise<"created" | "workspace_forbidden" | "workspace_not_found" | "key_conflict"> {
    if (this.failure) throw this.failure;
    const workspace = this.workspaces.get(record.workspaceId);
    if (!workspace) return "workspace_not_found";
    const allowed = workspace.owner.type === "personal"
      ? workspace.owner.id === memberId
      : this.organizationMembers.get(workspace.owner.id)?.has(memberId) === true;
    if (!allowed) return "workspace_forbidden";
    if ([...this.projects.values()].some(
      (project) => project.workspaceId === record.workspaceId && project.key === record.key,
    )) return "key_conflict";
    this.projects.set(record.id, record);
    return "created";
  }
}

const access: MemberAccessResolver = {
  async authenticateBearer(authorization) {
    const accountId = authorization?.match(/^Bearer member-(ada|grace)$/)?.[1];
    return accountId ? { accountId, sessionId: `session-${accountId}` } : undefined;
  },
};

describe("creating Workspaces and Projects", () => {
  let instance: RunningInstance | undefined;

  afterEach(async () => {
    await instance?.close();
    instance = undefined;
  });

  async function run() {
    const database = new ProtocolCompatibleDatabase();
    database.organizationMembers.set("org-acme", new Set(["ada"]));
    database.organizationMembers.set("org-other", new Set(["grace"]));
    instance = await startInstance({
      database,
      host: "127.0.0.1",
      port: 0,
      instanceAdminToken: "test-instance-admin-token",
      workspaceProjects: new WorkspaceProjectService(database),
      memberAccess: access,
    });
    return { database, baseUrl: instance.url };
  }

  function createWorkspace(baseUrl: string, token: string, body: unknown) {
    return fetch(`${baseUrl}/api/workspaces`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  function createProject(baseUrl: string, workspaceId: string, token: string, body: unknown) {
    return fetch(`${baseUrl}/api/workspaces/${workspaceId}/projects`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("lets a Member create a personal Workspace owned only by that Member", async () => {
    const { baseUrl } = await run();

    const response = await createWorkspace(baseUrl, "member-ada", {
      name: "Ada's Workspace",
      owner: { type: "personal" },
    });

    assert.equal(response.status, 201);
    const workspace = await response.json() as { id: string; name: string; owner: object };
    assert.equal(workspace.name, "Ada's Workspace");
    assert.deepEqual(workspace.owner, { type: "personal", id: "ada" });

    const denied = await createProject(baseUrl, workspace.id, "member-grace", {
      name: "Private Project",
      key: "PRIVATE",
    });
    assert.equal(denied.status, 403);
    assert.deepEqual(await denied.json(), {
      error: "workspace_forbidden",
      message: "This Member cannot create Projects in that Workspace.",
    });
  });

  it("lets an Organization Member create an Organization Workspace and Project", async () => {
    const { baseUrl } = await run();
    const workspaceResponse = await createWorkspace(baseUrl, "member-ada", {
      name: "Acme Product",
      owner: { type: "organization", organizationId: "org-acme" },
    });
    assert.equal(workspaceResponse.status, 201);
    const workspace = await workspaceResponse.json() as { id: string; owner: object };
    assert.deepEqual(workspace.owner, { type: "organization", id: "org-acme" });

    const projectResponse = await createProject(baseUrl, workspace.id, "member-ada", {
      name: "Launch",
      key: "LAUNCH",
    });
    assert.equal(projectResponse.status, 201);
    const project = await projectResponse.json() as Record<string, unknown>;
    assert.equal(project.workspaceId, workspace.id);
    assert.equal(project.name, "Launch");
    assert.equal(project.key, "LAUNCH");
  });

  it("does not reveal whether a Workspace belongs to another Organization", async () => {
    const { baseUrl } = await run();
    const workspaceResponse = await createWorkspace(baseUrl, "member-ada", {
      name: "Acme Product",
      owner: { type: "organization", organizationId: "org-acme" },
    });
    const workspace = await workspaceResponse.json() as { id: string };

    const crossOrganization = await createProject(
      baseUrl,
      workspace.id,
      "member-grace",
      { name: "Espionage", key: "SPY" },
    );
    assert.equal(crossOrganization.status, 403);
    assert.deepEqual(await crossOrganization.json(), {
      error: "workspace_forbidden",
      message: "This Member cannot create Projects in that Workspace.",
    });

    const foreignOwner = await createWorkspace(baseUrl, "member-grace", {
      name: "Not Grace's Organization",
      owner: { type: "organization", organizationId: "org-acme" },
    });
    assert.equal(foreignOwner.status, 403);
    assert.deepEqual(await foreignOwner.json(), {
      error: "organization_forbidden",
      message: "This Member cannot create Workspaces for that Organization.",
    });
  });

  it("makes missing access, invalid input, conflicts, and persistence failures visible and safe", async () => {
    const { baseUrl, database } = await run();
    const unauthorized = await createWorkspace(baseUrl, "unknown", {
      name: "Hidden",
      owner: { type: "personal" },
    });
    assert.equal(unauthorized.status, 401);

    const invalid = await createWorkspace(baseUrl, "member-ada", {
      name: " ",
      owner: { type: "personal" },
    });
    assert.equal(invalid.status, 422);
    assert.equal(database.workspaces.size, 0);

    const workspaceResponse = await createWorkspace(baseUrl, "member-ada", {
      name: "Ada's Workspace",
      owner: { type: "personal" },
    });
    const workspace = await workspaceResponse.json() as { id: string };
    assert.equal((await createProject(baseUrl, workspace.id, "member-ada", {
      name: "First",
      key: "CORE",
    })).status, 201);
    const conflict = await createProject(baseUrl, workspace.id, "member-ada", {
      name: "Duplicate key",
      key: "core",
    });
    assert.equal(conflict.status, 409);
    assert.equal(database.projects.size, 1);

    database.failure = new Error("postgres://stash:secret@database/stash");
    const unavailable = await createWorkspace(baseUrl, "member-ada", {
      name: "Never persisted",
      owner: { type: "personal" },
    });
    assert.equal(unavailable.status, 503);
    const text = await unavailable.text();
    assert.doesNotMatch(text, /postgres|secret/i);
    assert.equal(database.workspaces.size, 1);
  });
});

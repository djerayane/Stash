import assert from "node:assert/strict";
import { createServer } from "node:http";
import { afterEach, describe, it } from "node:test";

import { GitHubArtifactService, type DevelopmentArtifact, type GitHubArtifactProvider, type GitHubArtifactRepository } from "../src/github-artifacts.js";
import { startInstance, type DatabaseProbe, type RunningInstance } from "../src/instance.js";
import { publicDomainApiRoute } from "../src/public-domain-api.js";
import { RepositoryConnectionService, type GitHubApp, type RepositoryConnectionRecord, type RepositoryConnectionRepository } from "../src/repository-connections.js";
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

const organizationId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const connectionId = "33333333-3333-4333-8333-333333333333";

class ConnectionRepositoryFake implements RepositoryConnectionRepository {
  readonly records: RepositoryConnectionRecord[] = [];
  async organizationRole(organization: string, account: string) { return organization === organizationId && account === "ada" ? "Admin" as const : undefined; }
  async createRepositoryConnection(actorId: string, record: RepositoryConnectionRecord) {
    if (await this.organizationRole(record.organizationId, actorId) !== "Admin") return { status: "forbidden" as const };
    this.records.push(record); return { status: "created" as const, record };
  }
  async findRepositoryConnectionById(organization: string, id: string) { return this.records.find((record) => record.organizationId === organization && record.id === id); }
  async listRepositoryConnections(organization: string) { return this.records.filter((record) => record.organizationId === organization); }
  async attachRepositoryConnectionToProject() { return "not_found" as const; }
}

class ConnectionGitHubFake implements GitHubApp {
  inspections = 0;
  failure: Error | undefined;
  async inspectRepository(input: { installationId: number; owner: string; name: string }) {
    this.inspections++;
    if (this.failure) throw this.failure;
    return { installationId: input.installationId, repositoryId: "987", repositoryUrl: `https://github.com/${input.owner}/${input.name}` };
  }
  async verifyRepository() {}
}

class ArtifactRepositoryFake implements GitHubArtifactRepository {
  writable = true;
  readonly artifacts: DevelopmentArtifact[] = [];
  async resolveTask(memberId: string, project: string, key: string) {
    return ["ada", "grace"].includes(memberId) && project === projectId && key === "STASH-47"
      ? { id: "task-47", key, title: "Expose public API" } : undefined;
  }
  async resolveConnection(memberId: string, project: string, id: string) {
    return ["ada", "grace"].includes(memberId) && project === projectId && id === connectionId
      ? { installationId: 42, repositoryId: "987", repositoryUrl: "https://github.com/acme/stash" } : undefined;
  }
  async canLinkArtifact(memberId: string, project: string, key: string) {
    return memberId === "ada" && this.writable && Boolean(await this.resolveTask(memberId, project, key));
  }
  async linkArtifact(memberId: string, project: string, _key: string, artifact: DevelopmentArtifact) {
    if (!this.writable || memberId !== "ada" || project !== projectId) return "forbidden" as const;
    this.artifacts.push(artifact); return "linked" as const;
  }
  async listArtifacts(memberId: string, project: string) { return memberId === "ada" && project === projectId ? [...this.artifacts] : undefined; }
}

class ArtifactGitHubFake implements GitHubArtifactProvider {
  calls = 0;
  failure: Error | undefined;
  async createBranch(_repository: object, name: string) {
    this.calls++; if (this.failure) throw this.failure;
    return { kind: "branch" as const, providerId: name, url: `https://github.com/acme/stash/tree/${name}`, label: name };
  }
  async inspectArtifact(_repository: object, kind: "branch" | "commit" | "pull_request", reference: string) {
    this.calls++; if (this.failure) throw this.failure;
    const segment = kind === "pull_request" ? "pull" : kind === "commit" ? "commit" : "tree";
    return { kind, providerId: reference, url: `https://github.com/acme/stash/${segment}/${reference}`, label: reference };
  }
}

const access: MemberAccessResolver = {
  async authenticateBearer(authorization) {
    return ["Bearer member-ada", "Bearer admin-ada"].includes(authorization ?? "")
      ? { accountId: "ada", sessionId: "session-ada" } : authorization === "Bearer member-grace"
        ? { accountId: "grace", sessionId: "session-grace" } : undefined;
  },
};

describe("the versioned public domain API", () => {
  let instance: RunningInstance | undefined;
  afterEach(async () => { await instance?.close(); instance = undefined; });

  async function run() {
    const database = new PublicApiFake();
    const connections = new ConnectionRepositoryFake(); const connectionGitHub = new ConnectionGitHubFake();
    const artifacts = new ArtifactRepositoryFake(); const artifactGitHub = new ArtifactGitHubFake();
    instance = await startInstance({ database, host: "127.0.0.1", port: 0, instanceAdminToken: "instance-admin",
      workspaceProjects: new WorkspaceProjectService(database), memberAccess: access,
      repositoryConnections: new RepositoryConnectionService(connections, connectionGitHub),
      githubArtifacts: new GitHubArtifactService(artifacts, artifactGitHub) });
    const postWorkspace = (path: string, body: unknown, token = "member-ada") => fetch(`${instance!.url}${path}`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body),
    });
    return { database, connections, connectionGitHub, artifacts, artifactGitHub, postWorkspace };
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
    for (const path of ["/api/v1/auth/password/login", "/api/v1/admin/diagnostics", "/api/v1/health/live", "/api/v1/mobile/captures", "/api/v1/unknown"]) {
      const response = await fetch(`${instance!.url}${path}`);
      assert.equal(response.status, 404);
      assert.equal(response.headers.get("stash-api-version"), "1");
      assert.equal((await response.json() as { error: string }).error, "not_found");
    }
  });

  it("connects a repository and creates and manually links GitHub artifacts through the public boundary", async () => {
    const { connections, connectionGitHub, artifacts, artifactGitHub } = await run();
    const createConnection = await fetch(`${instance!.url}/api/v1/organizations/${organizationId}/repository-connections`, {
      method: "POST", headers: { authorization: "Bearer admin-ada", "content-type": "application/json" },
      body: JSON.stringify({ installationId: 42, owner: "acme", name: "stash" }),
    });
    assert.equal(createConnection.status, 201);
    assert.equal(createConnection.headers.get("stash-api-version"), "1");
    assert.equal(connectionGitHub.inspections, 1);
    assert.equal(connections.records.length, 1);
    const legacyConnections = await fetch(`${instance!.url}/api/organizations/${organizationId}/repository-connections`,
      { headers: { authorization: "Bearer admin-ada" } });
    assert.equal(legacyConnections.status, 200);
    assert.deepEqual((await legacyConnections.json() as { repositoryConnections: object[] }).repositoryConnections[0], await createConnection.clone().json());

    const endpoint = `${instance!.url}/api/v1/projects/${projectId}/tasks/STASH-47/development-artifacts`;
    const post = (body: object, token = "member-ada") => fetch(endpoint, { method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await post({ action: "create_branch", connectionId })).status, 201);
    assert.equal((await post({ action: "link", connectionId, kind: "pull_request", reference: "92" })).status, 201);
    assert.deepEqual(artifacts.artifacts.map(({ kind }) => kind), ["branch", "pull_request"]);
    assert.equal(artifactGitHub.calls, 2);
    const listed = await fetch(endpoint, { headers: { authorization: "Bearer member-ada" } });
    assert.equal(listed.status, 200);
    const publicBody = await listed.json() as { artifacts: DevelopmentArtifact[] };
    assert.deepEqual(publicBody.artifacts, artifacts.artifacts);
    const legacyListed = await fetch(endpoint.replace("/api/v1/", "/api/"), { headers: { authorization: "Bearer member-ada" } });
    assert.equal(legacyListed.status, 200);
    assert.deepEqual(await legacyListed.json(), publicBody);
  });

  it("denies artifact writes before provider effects and safely reports provider failures", async () => {
    const { artifacts, artifactGitHub } = await run();
    const endpoint = `${instance!.url}/api/v1/projects/${projectId}/tasks/STASH-47/development-artifacts`;
    const post = (token: string) => fetch(endpoint, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ action: "create_branch", connectionId }) });
    const unauthorized = await post("member-grace");
    assert.equal(unauthorized.status, 403);
    assert.equal(artifactGitHub.calls, 0);
    assert.deepEqual(artifacts.artifacts, []);

    artifactGitHub.failure = new Error("provider detail github-secret-token");
    const unavailable = await post("member-ada");
    assert.equal(unavailable.status, 502);
    const text = await unavailable.text();
    assert.deepEqual(JSON.parse(text), { error: "github_unavailable", message: "GitHub could not complete that operation. Try again." });
    assert.doesNotMatch(text, /provider detail|secret-token/);
    assert.deepEqual(artifacts.artifacts, []);
  });

  it("rewrites every documented Member-domain family through one version adapter", async () => {
    const examples = [
      "/api/member/localization", "/api/workspaces", "/api/organizations/org/roles", "/api/organizations/org/invitations",
      "/api/notes/note", "/api/notes/note/links", "/api/projects/project/tasks/TASK-1", "/api/projects/project/workflow",
      "/api/projects/project/boards", "/api/workspaces/workspace/attachments", "/api/discussions/discussion",
      "/api/workspaces/workspace/export", "/api/workspaces/workspace/activity", "/api/organizations/org/repository-connections",
      "/api/projects/project/tasks/TASK-1/development-artifacts",
      "/api/notifications", "/api/projects/project/notification-settings",
    ];
    const delegates = examples.map((pathname) => ({ matches: (_request: object, url: URL) => url.pathname === pathname,
      handle: (_request: object, response: import("node:http").ServerResponse) => { response.writeHead(204); response.end(); return true; } }));
    const route = publicDomainApiRoute(delegates);
    const server = createServer(async (request, response) => {
      const url = new URL(request.url ?? "/", "http://stash.invalid");
      if (route.matches(request, url) && await route.handle(request, response, url)) return;
      response.writeHead(404); response.end();
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address(); assert.ok(address && typeof address !== "string");
    try {
      for (const legacyPath of examples) {
        const fetched: Response = await fetch(`http://127.0.0.1:${address.port}${legacyPath.replace("/api/", "/api/v1/")}`);
        assert.equal(fetched.status, 204, legacyPath);
        assert.equal(fetched.headers.get("stash-api-version"), "1", legacyPath);
      }
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  });
});

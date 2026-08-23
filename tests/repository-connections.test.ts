import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { startInstance, type DatabaseProbe, type RunningInstance } from "../src/instance.js";
import {
  RepositoryConnectionService,
  type GitHubApp,
  type GitHubRepositorySelection,
  type GitHubRepositoryIdentity,
  type PortableRepositoryConnectionProjection,
  type RepositoryConnectionRecord,
  type RepositoryConnectionRepository,
} from "../src/repository-connections.js";

const acme = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const projectOne = "33333333-3333-4333-8333-333333333333";
const projectTwo = "44444444-4444-4444-8444-444444444444";
const otherProject = "55555555-5555-4555-8555-555555555555";

class DatabaseFake implements DatabaseProbe, RepositoryConnectionRepository {
  readonly records: RepositoryConnectionRecord[] = [];
  readonly portable: PortableRepositoryConnectionProjection[] = [];
  demoted = false;
  projectionFailure = false;
  beforeAttach: (() => void) | undefined;
  readonly legacyCredentials = new Map<string, string>();
  migrationFailure = false;
  async verifyConnection() {
    const pending = this.records.filter((record) => this.legacyCredentials.has(record.id)
      && !this.portable.some((event) => event.id === record.id));
    const events = pending.map((record) => projection(record));
    if (this.migrationFailure && pending.length) throw new Error("projection unavailable");
    this.portable.push(...events);
    for (const record of pending) this.legacyCredentials.delete(record.id);
  }
  async close() {}
  seedLegacy(record: RepositoryConnectionRecord, protectedCredential: string) { this.records.push(record); this.legacyCredentials.set(record.id, protectedCredential); }
  async organizationRole(organizationId: string, accountId: string) {
    if (accountId === "admin" && organizationId === acme && !this.demoted) return "Admin" as const;
    if (accountId === "other-admin" && organizationId === other) return "Admin" as const;
    return undefined;
  }
  async createRepositoryConnection(actorId: string, record: RepositoryConnectionRecord) {
    if (await this.organizationRole(record.organizationId, actorId) !== "Admin") return { status: "forbidden" as const };
    const existing = this.records.find((candidate) => candidate.organizationId === record.organizationId && candidate.repositoryId === record.repositoryId);
    if (existing) return { status: "existing" as const, record: existing };
    if (this.projectionFailure) throw new Error("outbox unavailable");
    this.records.push(record);
    this.portable.push(projection(record));
    return { status: "created" as const, record };
  }
  async findRepositoryConnectionById(organizationId: string, connectionId: string) { return this.records.find((record) => record.organizationId === organizationId && record.id === connectionId); }
  async listRepositoryConnections(organizationId: string) { return this.records.filter((record) => record.organizationId === organizationId); }
  async attachRepositoryConnectionToProject(actorId: string, organizationId: string, connectionId: string, projectId: string) {
    this.beforeAttach?.();
    if (await this.organizationRole(organizationId, actorId) !== "Admin") return "forbidden" as const;
    const record = this.records.find((candidate) => candidate.id === connectionId && candidate.organizationId === organizationId);
    if (!record || record.state === "degraded" || ![projectOne, projectTwo].includes(projectId)) return "not_found" as const;
    if (this.projectionFailure) throw new Error("outbox unavailable");
    if (!record.projectIds.includes(projectId)) record.projectIds.push(projectId);
    this.portable.push(projection(record));
    return "attached" as const;
  }
  async replaceDegradedRepositoryConnection(actorId: string, organizationId: string, connectionId: string,
    replacement: GitHubRepositoryIdentity) {
    if (await this.organizationRole(organizationId, actorId) !== "Admin") return "forbidden" as const;
    const record = this.records.find((candidate) => candidate.id === connectionId && candidate.organizationId === organizationId && candidate.state === "degraded");
    if (!record) return "not_found" as const;
    Object.assign(record, replacement, { createdByMemberId: actorId, createdByAttribution: "recorded", ownership: "organization", state: "active" });
    this.portable.push(projection(record));
    return "repaired" as const;
  }
}
function projection(record: RepositoryConnectionRecord): PortableRepositoryConnectionProjection { return { schema: "stash.repository-connection.v1", id: record.id, provider: "github", repositoryUrl: record.repositoryUrl, organization: { localOrganizationId: record.organizationId, displayName: "Acme" }, createdBy: { localAccountId: record.createdByMemberId, displayName: "Ada", attribution: record.createdByAttribution }, projectIds: [...record.projectIds] }; }

class GitHubFake implements GitHubApp {
  calls = 0;
  minted = 0;
  readonly issuedTokens: string[] = [];
  failure: Error | undefined;
  afterInspect: (() => void) | undefined;
  async inspectRepository(input: GitHubRepositorySelection) {
    this.calls++;
    this.minted++;
    this.issuedTokens.push(`expired-after-operation-${this.minted}`);
    if (this.failure) throw this.failure;
    const result = {
      installationId: input.installationId,
      repositoryId: "987654",
      repositoryUrl: `https://github.com/${input.owner}/${input.name}`,
    };
    this.afterInspect?.();
    return result;
  }
  async verifyRepository(_input: GitHubRepositoryIdentity) { this.minted++; this.issuedTokens.push(`expired-after-operation-${this.minted}`); if (this.failure) throw this.failure; }
}

describe("Organization Repository Connections", () => {
  let instance: RunningInstance | undefined;
  afterEach(async () => { await instance?.close(); instance = undefined; });

  async function run() {
    const database = new DatabaseFake();
    const github = new GitHubFake();
    instance = await startInstance({
      database,
      host: "127.0.0.1",
      port: 0,
      instanceAdminToken: "instance-admin",
      memberAccess: { async authenticateBearer(value) {
        if (value === "Bearer admin-session") return { accountId: "admin", sessionId: "admin-session" };
        if (value === "Bearer other-admin-session") return { accountId: "other-admin", sessionId: "other-admin-session" };
        return undefined;
      } },
      repositoryConnections: new RepositoryConnectionService(database, github),
    });
    return { baseUrl: instance.url, database, github };
  }

  it("connects through the Instance GitHub App and reuses the connection in its Organization", async () => {
    const { baseUrl, database, github } = await run();
    const create = () => fetch(`${baseUrl}/api/organizations/${acme}/repository-connections`, {
      method: "POST",
      headers: { authorization: "Bearer admin-session", "content-type": "application/json" },
      body: JSON.stringify({ installationId: 42, owner: "acme", name: "platform" }),
    });

    const created = await create();
    assert.equal(created.status, 201);
    const projection = await created.json() as { id: string; organizationId: string; repositoryUrl: string };
    assert.equal(projection.organizationId, acme);
    assert.equal(projection.repositoryUrl, "https://github.com/acme/platform");
    assert.equal(database.records.length, 1);
    assert.doesNotMatch(JSON.stringify(database.records[0]), /secret|credential|token/i);
    assert.deepEqual(database.portable[0], {
      schema: "stash.repository-connection.v1", id: projection.id, provider: "github", repositoryUrl: "https://github.com/acme/platform",
      organization: { localOrganizationId: acme, displayName: "Acme" }, createdBy: { localAccountId: "admin", displayName: "Ada", attribution: "recorded" }, projectIds: [],
    });
    assert.doesNotMatch(JSON.stringify(database.portable), /installationId|repositoryId|token|private/i);
    assert.doesNotMatch(JSON.stringify(projection), /secret|credential|token/i);

    const reused = await create();
    assert.equal(reused.status, 200);
    assert.deepEqual(await reused.json(), projection);
    assert.equal(database.records.length, 1);
    assert.equal(github.calls, 2);

    for (let attempt = 0; attempt < 2; attempt++) {
      const verified = await fetch(`${baseUrl}/api/organizations/${acme}/repository-connections/${projection.id}/verify`, { method: "POST", headers: { authorization: "Bearer admin-session" } });
      assert.equal(verified.status, 204);
    }
    assert.equal(github.minted, 4, "each operation mints a fresh installation token");
    assert.equal(new Set(github.issuedTokens).size, 4, "expired installation tokens are never reused");

    for (const projectId of [projectOne, projectTwo]) {
      const attached = await fetch(`${baseUrl}/api/organizations/${acme}/repository-connections/${projection.id}/projects/${projectId}`, {
        method: "POST", headers: { authorization: "Bearer admin-session" },
      });
      assert.equal(attached.status, 204);
    }
    const listed = await fetch(`${baseUrl}/api/organizations/${acme}/repository-connections`, { headers: { authorization: "Bearer admin-session" } });
    const body = await listed.json() as { repositoryConnections: Array<{ projectIds: string[] }> };
    assert.deepEqual(body.repositoryConnections[0]!.projectIds, [projectOne, projectTwo]);

    const crossOrganizationProject = await fetch(`${baseUrl}/api/organizations/${acme}/repository-connections/${projection.id}/projects/${otherProject}`, {
      method: "POST", headers: { authorization: "Bearer admin-session" },
    });
    assert.equal(crossOrganizationProject.status, 404);
    assert.deepEqual(database.portable.at(-1)!.projectIds, [projectOne, projectTwo]);
    assert.doesNotMatch(JSON.stringify(database.portable), /installationId|repositoryId|token|private/i);
  });

  it("keeps departed personal authority revoked until an Admin supplies a verified Organization replacement", async () => {
    const { baseUrl, database, github } = await run();
    const created = await fetch(`${baseUrl}/api/organizations/${acme}/repository-connections`, {
      method: "POST", headers: { authorization: "Bearer admin-session", "content-type": "application/json" },
      body: JSON.stringify({ installationId: 42, owner: "acme", name: "personal-repo", ownership: "personal" }),
    });
    assert.equal(created.status, 201);
    const connection = await created.json() as { id: string; ownership: string; state: string };
    assert.equal(connection.ownership, "personal"); assert.equal(connection.state, "active");

    database.records[0]!.projectIds.push(projectOne);
    database.records[0]!.state = "degraded";
    const listed = await fetch(`${baseUrl}/api/organizations/${acme}/repository-connections`, { headers: { authorization: "Bearer admin-session" } });
    assert.deepEqual((await listed.json() as any).repositoryConnections[0].state, "degraded");
    const oldAuthority = await fetch(`${baseUrl}/api/organizations/${acme}/repository-connections/${connection.id}/projects/${projectOne}`, {
      method: "POST", headers: { authorization: "Bearer admin-session" },
    });
    assert.equal(oldAuthority.status, 404);
    const emptyRepair = await fetch(`${baseUrl}/api/organizations/${acme}/repository-connections/${connection.id}/repair`, {
      method: "PUT", headers: { authorization: "Bearer admin-session" },
    });
    assert.equal(emptyRepair.status, 400);
    assert.equal(database.records[0]!.ownership, "personal"); assert.equal(database.records[0]!.state, "degraded");

    github.failure = new Error("replacement denied");
    const rejectedRepair = await fetch(`${baseUrl}/api/organizations/${acme}/repository-connections/${connection.id}/repair`, {
      method: "PUT", headers: { authorization: "Bearer admin-session", "content-type": "application/json" },
      body: JSON.stringify({ installationId: 84, owner: "acme", name: "personal-repo" }),
    });
    assert.equal(rejectedRepair.status, 502);
    assert.equal(database.records[0]!.ownership, "personal"); assert.equal(database.records[0]!.state, "degraded");

    github.failure = undefined;
    const repaired = await fetch(`${baseUrl}/api/organizations/${acme}/repository-connections/${connection.id}/repair`, {
      method: "PUT", headers: { authorization: "Bearer admin-session", "content-type": "application/json" },
      body: JSON.stringify({ installationId: 84, owner: "acme", name: "personal-repo" }),
    });
    assert.equal(repaired.status, 204);
    assert.equal(database.records[0]!.ownership, "organization"); assert.equal(database.records[0]!.state, "active");
    assert.equal(database.records[0]!.installationId, 84);
    assert.equal(database.records[0]!.repositoryUrl, "https://github.com/acme/personal-repo");
    const replacementAuthority = await fetch(`${baseUrl}/api/organizations/${acme}/repository-connections/${connection.id}/projects/${projectOne}`, {
      method: "POST", headers: { authorization: "Bearer admin-session" },
    });
    assert.equal(replacementAuthority.status, 204);
    assert.equal(github.calls, 3);
    assert.equal(github.minted, 4, "successful replacement is separately verified before activation");
  });

  it("rechecks authority atomically after provider calls and before Project attachment", async () => {
    const { baseUrl, database, github } = await run();
    github.afterInspect = () => { database.demoted = true; };
    const racedCreate = await fetch(`${baseUrl}/api/organizations/${acme}/repository-connections`, { method: "POST", headers: { authorization: "Bearer admin-session", "content-type": "application/json" }, body: JSON.stringify({ installationId: 42, owner: "acme", name: "platform" }) });
    assert.equal(racedCreate.status, 403);
    assert.equal(database.records.length, 0);
    database.demoted = false; github.afterInspect = undefined;
    const created = await fetch(`${baseUrl}/api/organizations/${acme}/repository-connections`, { method: "POST", headers: { authorization: "Bearer admin-session", "content-type": "application/json" }, body: JSON.stringify({ installationId: 42, owner: "acme", name: "platform" }) });
    const connection = await created.json() as { id: string };
    database.beforeAttach = () => { database.demoted = true; };
    const racedAttach = await fetch(`${baseUrl}/api/organizations/${acme}/repository-connections/${connection.id}/projects/${projectOne}`, { method: "POST", headers: { authorization: "Bearer admin-session" } });
    assert.equal(racedAttach.status, 403);
    assert.deepEqual(database.records[0]!.projectIds, []);
  });

  it("rolls back operational creation when its portable projection cannot be recorded", async () => {
    const { baseUrl, database } = await run(); database.projectionFailure = true;
    const response = await fetch(`${baseUrl}/api/organizations/${acme}/repository-connections`, { method: "POST", headers: { authorization: "Bearer admin-session", "content-type": "application/json" }, body: JSON.stringify({ installationId: 42, owner: "acme", name: "platform" }) });
    assert.equal(response.status, 503); assert.equal(database.records.length, 0); assert.equal(database.portable.length, 0);
  });

  it("rolls back a Project attachment when its portable projection cannot be recorded", async () => {
    const { baseUrl, database } = await run();
    const created = await fetch(`${baseUrl}/api/organizations/${acme}/repository-connections`, { method: "POST", headers: { authorization: "Bearer admin-session", "content-type": "application/json" }, body: JSON.stringify({ installationId: 42, owner: "acme", name: "platform" }) });
    const connection = await created.json() as { id: string };
    database.projectionFailure = true;
    const response = await fetch(`${baseUrl}/api/organizations/${acme}/repository-connections/${connection.id}/projects/${projectOne}`, { method: "POST", headers: { authorization: "Bearer admin-session" } });
    assert.equal(response.status, 503); assert.deepEqual(database.records[0]!.projectIds, []); assert.equal(database.portable.length, 1);
  });

  it("migrates unattached and attached legacy connections atomically and idempotently", async () => {
    const { baseUrl, database } = await run();
    database.seedLegacy({ id: "66666666-6666-4666-8666-666666666666", organizationId: acme, provider: "github", installationId: 40, repositoryId: "100", repositoryUrl: "https://github.com/acme/one", createdByMemberId: "admin", createdByAttribution: "inferred-during-upgrade", projectIds: [] }, "old-token-one");
    database.seedLegacy({ id: "77777777-7777-4777-8777-777777777777", organizationId: acme, provider: "github", installationId: 41, repositoryId: "101", repositoryUrl: "https://github.com/acme/two", createdByMemberId: "admin", createdByAttribution: "inferred-during-upgrade", projectIds: [projectOne, projectTwo] }, "old-token-two");
    database.migrationFailure = true;
    assert.equal((await fetch(`${baseUrl}/health/ready`)).status, 503);
    assert.equal(database.portable.length, 0);
    assert.equal(database.legacyCredentials.size, 2, "failed projection keeps the whole migration retryable");

    database.migrationFailure = false;
    assert.equal((await fetch(`${baseUrl}/health/ready`)).status, 200);
    assert.equal(database.legacyCredentials.size, 0);
    assert.deepEqual(database.portable.map((event) => event.projectIds), [[], [projectOne, projectTwo]]);
    assert.ok(database.portable.every((event) => event.createdBy.attribution === "inferred-during-upgrade"));
    assert.doesNotMatch(JSON.stringify(database.portable), /installationId|repositoryId|old-token/);

    assert.equal((await fetch(`${baseUrl}/health/ready`)).status, 200);
    assert.equal(database.portable.length, 2, "repeated initialization does not duplicate revision-1 events");
  });

  it("does not expose or reuse a Repository Connection across Organizations", async () => {
    const { baseUrl } = await run();
    await fetch(`${baseUrl}/api/organizations/${acme}/repository-connections`, {
      method: "POST", headers: { authorization: "Bearer admin-session", "content-type": "application/json" },
      body: JSON.stringify({ installationId: 42, owner: "acme", name: "platform" }),
    });
    const list = await fetch(`${baseUrl}/api/organizations/${other}/repository-connections`, {
      headers: { authorization: "Bearer other-admin-session" },
    });
    assert.equal(list.status, 200);
    assert.deepEqual(await list.json(), { repositoryConnections: [] });

    const forbidden = await fetch(`${baseUrl}/api/organizations/${other}/repository-connections`, {
      headers: { authorization: "Bearer admin-session" },
    });
    assert.equal(forbidden.status, 403);
    assert.deepEqual(await forbidden.json(), { error: "organization_forbidden", message: "Organization Owner or Admin permission is required." });
  });

  it("makes invalid input and recoverable GitHub failures safe and visible", async () => {
    const { baseUrl, github } = await run();
    const request = (body: object) => fetch(`${baseUrl}/api/organizations/${acme}/repository-connections`, {
      method: "POST", headers: { authorization: "Bearer admin-session", "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const invalid = await request({ installationId: 0, owner: "acme", name: "platform" });
    assert.equal(invalid.status, 422);
    github.failure = new Error("provider details containing github-installation-secret");
    const unavailable = await request({ installationId: 42, owner: "acme", name: "platform" });
    assert.equal(unavailable.status, 502);
    const text = await unavailable.text();
    assert.deepEqual(JSON.parse(text), { error: "github_unavailable", message: "GitHub could not authorize that repository. Try again." });
    assert.doesNotMatch(text, /installation-secret|provider details/);

    const malformedOrganization = await fetch(`${baseUrl}/api/organizations/%/repository-connections`, {
      headers: { authorization: "Bearer admin-session" },
    });
    assert.equal(malformedOrganization.status, 422);
    const malformedConnection = await fetch(`${baseUrl}/api/organizations/${acme}/repository-connections/%/projects/${projectOne}`, {
      method: "POST", headers: { authorization: "Bearer admin-session" },
    });
    assert.equal(malformedConnection.status, 422);
  });
});

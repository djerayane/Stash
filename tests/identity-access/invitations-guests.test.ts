import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createAuthenticationSecretCodec } from "../../src/authentication-secrets.js";

import { startInstance, type DatabaseProbe, type RunningInstance } from "../support/start-test-instance.js";
import {
  InvitationService,
  type InvitationRecord,
  type InvitationRepository,
  type ProjectAccessSummary,
} from "../../src/invitations.js";
import type { BuiltInOrganizationRole } from "../../src/organization-roles.js";
import type { MemberAccessResolver } from "../../src/workspaces-projects.js";

const organizationId = "11111111-1111-4111-8111-111111111111";
const otherOrganizationId = "22222222-2222-4222-8222-222222222222";
const launchProjectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const secretProjectId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const foreignProjectId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

class ProtocolCompatibleDatabase implements DatabaseProbe, InvitationRepository {
  readonly secrets = createAuthenticationSecretCodec(Buffer.alloc(32, 7).toString("base64"));
  readonly roles = new Map<string, Map<string, BuiltInOrganizationRole>>([
    [organizationId, new Map([["owner", "Owner"], ["admin", "Admin"], ["member", "Member"]])],
    [otherOrganizationId, new Map([["foreign-admin", "Admin"]])],
  ]);
  readonly projects = new Map<string, ProjectAccessSummary>([
    [launchProjectId, { id: launchProjectId, organizationId, name: "Launch", key: "LAUNCH", createdBy: { localAccountId: "owner", displayName: "Ada" } }],
    [secretProjectId, { id: secretProjectId, organizationId, name: "Secret", key: "SECRET", createdBy: { localAccountId: "owner", displayName: "Ada" } }],
    [foreignProjectId, { id: foreignProjectId, organizationId: otherOrganizationId, name: "Foreign", key: "FOREIGN", createdBy: { localAccountId: "foreign-admin", displayName: "Grace" } }],
  ]);
  readonly invitations = new Map<string, { record: InvitationRecord; tokenSecret: string }>();
  readonly guestProjects = new Map<string, Set<string>>();
  readonly portableProjectionOutbox: object[] = [];
  readonly names = new Map([["guest", "Katherine Johnson"], ["owner", "Ada"], ["admin", "Linus"]]);
  failure: Error | undefined;
  projectionFailure: Error | undefined;
  beforeCreate: (() => void) | undefined;

  async verifyConnection() {}
  async close() {}
  async createInvitation(record: InvitationRecord, token: string) {
    if (this.failure) throw this.failure;
    this.beforeCreate?.();
    const actorRole = this.roles.get(record.organizationId)?.get(record.invitedByAccountId);
    if (actorRole !== "Owner" && actorRole !== "Admin") return "forbidden" as const;
    if (actorRole === "Admin" && record.access.kind === "member" && record.access.role !== "Member") return "forbidden" as const;
    if (record.access.kind === "guest" && record.access.projectIds.some((id) => this.projects.get(id)?.organizationId !== record.organizationId)) return "project_forbidden" as const;
    const lookup = this.secrets.blindIndex(token, "invitation-v1");
    this.invitations.set(lookup, { record, tokenSecret: this.secrets.encrypt(token, "invitation-v1") });
    return "created" as const;
  }
  async acceptInvitation(token: string, accountId: string, acceptedAt: string) {
    if (this.failure) throw this.failure;
    const stored = this.invitations.get(this.secrets.blindIndex(token, "invitation-v1"));
    if (!stored || this.secrets.decrypt(stored.tokenSecret, "invitation-v1") !== token || stored.record.acceptedAt || stored.record.expiresAt <= acceptedAt) return "invalid_invitation" as const;
    const invitation = stored.record;
    if (invitation.access.kind === "guest" && this.projectionFailure) throw this.projectionFailure;
    invitation.acceptedAt = acceptedAt; invitation.acceptedByAccountId = accountId;
    this.invitations.delete(this.secrets.blindIndex(token, "invitation-v1"));
    if (invitation.access.kind === "member") {
      const rank = { Member: 0, Admin: 1, Owner: 2 } as const;
      const existing = this.roles.get(invitation.organizationId)!.get(accountId);
      const role = existing && rank[existing] >= rank[invitation.access.role] ? existing : invitation.access.role;
      this.roles.get(invitation.organizationId)!.set(accountId, role);
      return { status: "accepted" as const, access: { kind: "member" as const, organizationId: invitation.organizationId, role } };
    }
    this.guestProjects.set(accountId, new Set(invitation.access.projectIds));
    this.portableProjectionOutbox.push({ schema: "stash.guest-project-access.v1", organizationId: invitation.organizationId, guest: { localAccountId: accountId, displayName: this.names.get(accountId) ?? accountId }, projects: invitation.access.projectIds.map((projectId) => ({ projectId })), invitedBy: { localAccountId: invitation.invitedByAccountId, displayName: this.names.get(invitation.invitedByAccountId) ?? invitation.invitedByAccountId } });
    return { status: "accepted" as const, access: { kind: "guest" as const, organizationId: invitation.organizationId, projectIds: invitation.access.projectIds } };
  }
  async readProject(accountId: string, projectId: string) {
    const project = this.projects.get(projectId);
    if (!project) return undefined;
    return this.roles.get(project.organizationId)?.has(accountId) || this.guestProjects.get(accountId)?.has(projectId) ? project : undefined;
  }
  async canWriteProject(accountId: string, projectId: string) {
    const project = this.projects.get(projectId);
    return !!project && this.roles.get(project.organizationId)?.has(accountId) === true;
  }
}

const memberAccess: MemberAccessResolver = {
  async authenticateBearer(authorization) {
    const accountId = authorization?.match(/^Bearer account-(.+)$/)?.[1];
    return accountId ? { accountId, sessionId: `session-${accountId}` } : undefined;
  },
};

describe("inviting Members and Project Guests", () => {
  let instance: RunningInstance | undefined;
  afterEach(async () => { await instance?.close(); instance = undefined; });

  async function run() {
    const database = new ProtocolCompatibleDatabase();
    instance = await startInstance({ database, host: "127.0.0.1", port: 0, instanceAdminToken: "operator", memberAccess, invitations: new InvitationService(database) });
    return { database, baseUrl: instance.url };
  }
  function request(baseUrl: string, path: string, account: string, init: RequestInit = {}) {
    return fetch(`${baseUrl}${path}`, { ...init, headers: { authorization: `Bearer account-${account}`, "content-type": "application/json", ...init.headers } });
  }
  async function invite(baseUrl: string, account: string, body: unknown) {
    return request(baseUrl, `/api/organizations/${organizationId}/invitations`, account, { method: "POST", body: JSON.stringify(body) });
  }

  it("lets an Admin invite a Member with a default Role through a one-time secret", async () => {
    const { baseUrl, database } = await run();
    const created = await invite(baseUrl, "admin", { kind: "member", role: "Member" });
    assert.equal(created.status, 201);
    const invitation = await created.json() as { token: string; expiresAt: string };
    assert.match(invitation.token, /^[A-Za-z0-9_-]{40,}$/);
    assert.ok(database.invitations.has(database.secrets.blindIndex(invitation.token, "invitation-v1")));
    assert.doesNotMatch(JSON.stringify([...database.invitations.values()]), new RegExp(invitation.token));

    const accepted = await request(baseUrl, "/api/invitations/accept", "new-member", { method: "POST", body: JSON.stringify({ token: invitation.token }) });
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), { kind: "member", organizationId, role: "Member" });
    assert.equal(database.roles.get(organizationId)?.get("new-member"), "Member");
    assert.equal(database.invitations.size, 0);
    assert.equal((await request(baseUrl, "/api/invitations/accept", "attacker", { method: "POST", body: JSON.stringify({ token: invitation.token }) })).status, 410);
  });

  it("gives a Guest read-only access only to the selected Projects", async () => {
    const { baseUrl, database } = await run();
    const created = await invite(baseUrl, "admin", { kind: "guest", projectIds: [launchProjectId] });
    const { token } = await created.json() as { token: string };
    const accepted = await request(baseUrl, "/api/invitations/accept", "guest", { method: "POST", body: JSON.stringify({ token }) });
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), { kind: "guest", organizationId, projectIds: [launchProjectId] });
    assert.equal(database.roles.get(organizationId)?.has("guest"), false);
    assert.deepEqual(database.portableProjectionOutbox, [{ schema: "stash.guest-project-access.v1", organizationId, guest: { localAccountId: "guest", displayName: "Katherine Johnson" }, projects: [{ projectId: launchProjectId }], invitedBy: { localAccountId: "admin", displayName: "Linus" } }]);

    const visible = await request(baseUrl, `/api/projects/${launchProjectId}`, "guest");
    assert.equal(visible.status, 200);
    assert.deepEqual(await visible.json(), { id: launchProjectId, name: "Launch", key: "LAUNCH", createdBy: { localAccountId: "owner", displayName: "Ada" }, access: "read" });
    for (const projectId of [secretProjectId, foreignProjectId]) assert.equal((await request(baseUrl, `/api/projects/${projectId}`, "guest")).status, 404);
    const write = await request(baseUrl, `/api/projects/${launchProjectId}`, "guest", { method: "PATCH", body: JSON.stringify({ name: "Taken over" }) });
    assert.equal(write.status, 403);
    assert.equal(database.projects.get(launchProjectId)?.name, "Launch");
  });

  it("preserves stronger existing membership and the sole Owner when invitations race", async () => {
    const { baseUrl, database } = await run();
    const adminInvite = await invite(baseUrl, "owner", { kind: "member", role: "Admin" });
    const { token: adminToken } = await adminInvite.json() as { token: string };
    assert.equal((await request(baseUrl, "/api/invitations/accept", "owner", { method: "POST", body: JSON.stringify({ token: adminToken }) })).status, 200);
    assert.equal(database.roles.get(organizationId)?.get("owner"), "Owner");

    const memberInvite = await invite(baseUrl, "admin", { kind: "member", role: "Member" });
    const { token: memberToken } = await memberInvite.json() as { token: string };
    await request(baseUrl, "/api/invitations/accept", "admin", { method: "POST", body: JSON.stringify({ token: memberToken }) });
    assert.equal(database.roles.get(organizationId)?.get("admin"), "Admin");

    database.beforeCreate = () => database.roles.get(organizationId)!.set("admin", "Member");
    assert.equal((await invite(baseUrl, "admin", { kind: "guest", projectIds: [launchProjectId] })).status, 403);
  });

  it("rolls back Guest acceptance when its portable projection cannot be recorded", async () => {
    const { baseUrl, database } = await run();
    const created = await invite(baseUrl, "admin", { kind: "guest", projectIds: [launchProjectId] });
    const { token } = await created.json() as { token: string };
    database.projectionFailure = new Error("outbox unavailable");
    assert.equal((await request(baseUrl, "/api/invitations/accept", "guest", { method: "POST", body: JSON.stringify({ token }) })).status, 503);
    assert.equal(database.guestProjects.has("guest"), false);
    database.projectionFailure = undefined;
    assert.equal((await request(baseUrl, "/api/invitations/accept", "guest", { method: "POST", body: JSON.stringify({ token }) })).status, 200);
  });

  it("keeps Organization boundaries and permission, input, and persistence failures visible", async () => {
    const { baseUrl, database } = await run();
    assert.equal((await invite(baseUrl, "member", { kind: "member", role: "Member" })).status, 403);
    assert.equal((await invite(baseUrl, "admin", { kind: "member", role: "Owner" })).status, 403);
    assert.equal((await invite(baseUrl, "admin", { kind: "guest", projectIds: [foreignProjectId] })).status, 403);
    assert.equal((await invite(baseUrl, "admin", { kind: "guest", projectIds: [] })).status, 422);
    assert.equal((await fetch(`${baseUrl}/api/organizations/${organizationId}/invitations`, { method: "POST" })).status, 401);
    database.failure = new Error("postgres://secret-token");
    const unavailable = await invite(baseUrl, "admin", { kind: "member", role: "Member" });
    assert.equal(unavailable.status, 503);
    assert.doesNotMatch(await unavailable.text(), /postgres|secret-token/i);
  });

  it("rejects malformed invitation and Guest Project path encoding before access or persistence", async () => {
    const { baseUrl, database } = await run();
    const invitationCount = database.invitations.size;
    const guestGrantCount = database.guestProjects.size;

    const malformedInvitation = await fetch(`${baseUrl}/api/organizations/%ZZ/invitations`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "member", role: "Member" }),
    });
    assert.equal(malformedInvitation.status, 422);
    assert.deepEqual(await malformedInvitation.json(), { error: "invalid_input", message: "Invitation and Project values must be valid." });

    const malformedProject = await fetch(`${baseUrl}/api/projects/%ZZ`);
    assert.equal(malformedProject.status, 422);
    assert.deepEqual(await malformedProject.json(), { error: "invalid_input", message: "Invitation and Project values must be valid." });
    assert.equal(database.invitations.size, invitationCount);
    assert.equal(database.guestProjects.size, guestGrantCount);
  });
});

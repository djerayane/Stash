import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { startInstance, type DatabaseProbe, type RunningInstance } from "../src/instance.js";
import {
  OrganizationRoleService,
  type BuiltInOrganizationRole,
  type OrganizationRoleRepository,
} from "../src/organization-roles.js";
import type { MemberAccessResolver } from "../src/workspaces-projects.js";

const organizationId = "11111111-1111-4111-8111-111111111111";
const otherOrganizationId = "22222222-2222-4222-8222-222222222222";
const adaId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const graceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const linusId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const margaretId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const missingMemberId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

class ProtocolCompatibleDatabase implements DatabaseProbe, OrganizationRoleRepository {
  readonly memberships = new Map<string, Map<string, BuiltInOrganizationRole>>([
    [organizationId, new Map([[adaId, "Owner"], [graceId, "Admin"], [linusId, "Member"]])],
    [otherOrganizationId, new Map([[margaretId, "Owner"]])],
  ]);
  failure: Error | undefined;
  readonly activeSessions = new Set([adaId, linusId, graceId, margaretId]);
  readonly personalTokens = new Set([linusId]);
  readonly passkeys = new Set([linusId]);
  readonly recoveryCodes = new Set([linusId]);
  readonly activeAgentGrants = new Set([linusId]);
  readonly authoredNotes = new Map([[linusId, ["note-by-linus"]]]);
  readonly taskAssignments = new Map([["task-assigned-to-linus", { assigneeIds: [linusId], formerAssigneeIds: [] as string[] }]]);
  readonly repositoryConnections = new Map([
    ["organization-github-connection", { owner: "organization", state: "active" }],
    ["personal-github-connection", { owner: linusId, state: "active" }],
  ]);
  readonly operatorAudit: Array<{ actorId: string; memberId: string; action: string }> = [];

  async verifyConnection() {}
  async close() {}

  async organizationRole(orgId: string, accountId: string) {
    return this.memberships.get(orgId)?.get(accountId);
  }

  async assignBuiltInRole(
    orgId: string,
    actorId: string,
    accountId: string,
    role: BuiltInOrganizationRole,
  ) {
    if (this.failure) throw this.failure;
    const members = this.memberships.get(orgId);
    if (members?.get(actorId) !== "Owner") return "forbidden" as const;
    if (!members?.has(accountId)) return "member_not_found" as const;
    if (members.get(accountId) === "Owner" && role !== "Owner"
      && [...members.values()].filter((candidate) => candidate === "Owner").length === 1) {
      return "final_owner" as const;
    }
    members.set(accountId, role);
    return "updated" as const;
  }

  async removeOrganizationMember(orgId: string, actorId: string, accountId: string) {
    if (this.failure) throw this.failure;
    const members = this.memberships.get(orgId);
    if (members?.get(actorId) !== "Owner") return "forbidden" as const;
    if (!members?.has(accountId)) return "member_not_found" as const;
    if (members.get(accountId) === "Owner"
      && [...members.values()].filter((candidate) => candidate === "Owner").length === 1) {
      return "final_owner" as const;
    }
    members.delete(accountId);
    this.activeSessions.delete(accountId);
    this.personalTokens.delete(accountId);
    const revokedAgentGrants = this.activeAgentGrants.delete(accountId) ? 1 : 0;
    const affectedTaskIds: string[] = [];
    for (const [taskId, assignment] of this.taskAssignments) {
      if (!assignment.assigneeIds.includes(accountId)) continue;
      assignment.formerAssigneeIds.push(accountId);
      affectedTaskIds.push(taskId);
    }
    const degradedRepositoryConnectionIds: string[] = [];
    for (const [connectionId, connection] of this.repositoryConnections) {
      if (connection.owner !== accountId) continue;
      connection.state = "degraded";
      degradedRepositoryConnectionIds.push(connectionId);
    }
    this.operatorAudit.push({ actorId, memberId: accountId, action: "organization_member_departed" });
    return {
      status: "removed" as const,
      departure: { memberId: accountId, affectedTaskIds, revokedSessions: 1, revokedCredentials: 1, revokedAgentGrants,
        degradedRepositoryConnectionIds },
    };
  }
}

const access: MemberAccessResolver = {
  async authenticateBearer(authorization) {
    const accountId = authorization?.match(/^Bearer member-(.+)$/)?.[1];
    return accountId ? { accountId, sessionId: `session-${accountId}` } : undefined;
  },
};

describe("managing built-in Organization Roles", () => {
  let instance: RunningInstance | undefined;

  afterEach(async () => {
    await instance?.close();
    instance = undefined;
  });

  async function run() {
    const database = new ProtocolCompatibleDatabase();
    instance = await startInstance({
      database,
      host: "127.0.0.1",
      port: 0,
      instanceAdminToken: "instance-admin",
      memberAccess: {
        async authenticateBearer(authorization) {
          const authenticated = await access.authenticateBearer(authorization);
          const accountId = authorization?.match(/^Bearer personal-(.+)$/)?.[1];
          if (accountId) return database.personalTokens.has(accountId) ? { accountId, sessionId: `personal-token:${accountId}` } : undefined;
          return authenticated && database.activeSessions.has(authenticated.accountId) ? authenticated : undefined;
        },
      },
      organizationRoles: new OrganizationRoleService(database),
    });
    return { database, baseUrl: instance.url };
  }

  function request(baseUrl: string, path: string, token: string, init: RequestInit = {}) {
    return fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers },
    });
  }

  it("lets an Owner inspect the immutable permission baseline and assign its Roles", async () => {
    const { baseUrl, database } = await run();
    const roles = await request(baseUrl, `/api/organizations/${organizationId}/roles`, `member-${adaId}`);
    assert.equal(roles.status, 200);
    assert.deepEqual(await roles.json(), {
      roles: [
        {
          name: "Owner",
          immutable: true,
          permissions: [
            "organization.roles.manage",
            "organization.members.manage",
            "workspace.create",
            "project.create",
          ],
        },
        {
          name: "Admin",
          immutable: true,
          permissions: ["organization.members.manage", "workspace.create", "project.create"],
        },
        { name: "Member", immutable: true, permissions: ["workspace.create", "project.create"] },
      ],
    });

    const promoted = await request(
      baseUrl,
      `/api/organizations/${organizationId}/members/${linusId}/role`,
      `member-${adaId}`,
      { method: "PUT", body: JSON.stringify({ role: "Admin" }) },
    );
    assert.equal(promoted.status, 200);
    assert.deepEqual(await promoted.json(), { organizationId, memberId: linusId, role: "Admin" });
    assert.equal(database.memberships.get(organizationId)?.get(linusId), "Admin");
  });

  it("protects the final Owner until ownership transfers", async () => {
    const { baseUrl, database } = await run();
    for (const [path, init] of [
      [`/api/organizations/${organizationId}/members/${adaId}/role`, { method: "PUT", body: JSON.stringify({ role: "Admin" }) }],
      [`/api/organizations/${organizationId}/members/${adaId}`, { method: "DELETE" }],
    ] as const) {
      const denied = await request(baseUrl, path, `member-${adaId}`, init);
      assert.equal(denied.status, 409);
      assert.deepEqual(await denied.json(), {
        error: "final_owner",
        message: "Transfer ownership before removing or reassigning the final Owner.",
      });
      assert.equal(database.memberships.get(organizationId)?.get(adaId), "Owner");
    }

    assert.equal((await request(baseUrl, `/api/organizations/${organizationId}/members/${graceId}/role`, `member-${adaId}`, {
      method: "PUT", body: JSON.stringify({ role: "Owner" }),
    })).status, 200);
    assert.equal((await request(baseUrl, `/api/organizations/${organizationId}/members/${adaId}`, `member-${adaId}`, {
      method: "DELETE",
    })).status, 200);
    assert.equal(database.memberships.get(organizationId)?.has(adaId), false);
  });

  it("revokes a departed Member immediately while preserving attribution and marking former assignments", async () => {
    const { baseUrl, database } = await run();

    const removed = await request(baseUrl, `/api/organizations/${organizationId}/members/${linusId}`, `member-${adaId}`, {
      method: "DELETE",
    });

    assert.equal(removed.status, 200);
    assert.deepEqual(await removed.json(), {
      memberId: linusId,
      affectedTaskIds: ["task-assigned-to-linus"],
      degradedRepositoryConnectionIds: ["personal-github-connection"],
      authorityRevoked: true,
    });
    assert.deepEqual(database.authoredNotes.get(linusId), ["note-by-linus"]);
    assert.deepEqual(database.taskAssignments.get("task-assigned-to-linus"), {
      assigneeIds: [linusId],
      formerAssigneeIds: [linusId],
    });
    assert.deepEqual(database.repositoryConnections.get("organization-github-connection"), { owner: "organization", state: "active" });
    assert.deepEqual(database.repositoryConnections.get("personal-github-connection"), { owner: linusId, state: "degraded" });
    assert.equal(database.activeSessions.has(linusId), false);
    assert.equal(database.personalTokens.has(linusId), false);
    assert.equal(database.passkeys.has(linusId), true);
    assert.equal(database.recoveryCodes.has(linusId), true);
    assert.equal(database.activeAgentGrants.has(linusId), false);
    assert.deepEqual(database.operatorAudit, [{ actorId: adaId, memberId: linusId, action: "organization_member_departed" }]);

    const departedSession = await request(baseUrl, `/api/organizations/${organizationId}/roles`, `member-${linusId}`);
    assert.equal(departedSession.status, 401);
    const departedPersonalToken = await request(baseUrl, `/api/organizations/${organizationId}/roles`, `personal-${linusId}`);
    assert.equal(departedPersonalToken.status, 401);
  });

  it("invalidates sessions without deleting account recovery material when a Member belongs elsewhere", async () => {
    const { baseUrl, database } = await run();
    database.memberships.get(otherOrganizationId)!.set(linusId, "Member");

    const removed = await request(baseUrl, `/api/organizations/${organizationId}/members/${linusId}`, `member-${adaId}`, {
      method: "DELETE",
    });

    assert.equal(removed.status, 200);
    assert.equal(database.activeSessions.has(linusId), false);
    assert.equal(database.personalTokens.has(linusId), false);
    assert.equal(database.passkeys.has(linusId), true);
    assert.equal(database.recoveryCodes.has(linusId), true);
    const oldOrganization = await request(baseUrl, `/api/organizations/${organizationId}/roles`, `member-${linusId}`);
    assert.equal(oldOrganization.status, 401);
  });

  it("rejects non-Owners, invalid Roles, and attempts to mutate built-in definitions", async () => {
    const { baseUrl, database } = await run();
    const denied = await request(baseUrl, `/api/organizations/${organizationId}/members/${linusId}/role`, `member-${graceId}`, {
      method: "PUT", body: JSON.stringify({ role: "Admin" }),
    });
    assert.equal(denied.status, 403);
    assert.equal(database.memberships.get(organizationId)?.get(linusId), "Member");

    const crossOrganization = await request(baseUrl, `/api/organizations/${otherOrganizationId}/roles`, `member-${adaId}`);
    assert.equal(crossOrganization.status, 403);
    const invalid = await request(baseUrl, `/api/organizations/${organizationId}/members/${linusId}/role`, `member-${adaId}`, {
      method: "PUT", body: JSON.stringify({ role: "SuperAdmin" }),
    });
    assert.equal(invalid.status, 422);
    const immutable = await request(baseUrl, `/api/organizations/${organizationId}/roles/Admin`, `member-${adaId}`, {
      method: "DELETE",
    });
    assert.equal(immutable.status, 409);
    assert.deepEqual(await immutable.json(), {
      error: "built_in_role_immutable",
      message: "Owner, Admin, and Member Roles cannot be edited or deleted.",
    });

    for (const roleName of ["SuperAdmin", "%E0%A4%A"]) {
      const unknownRole = await request(
        baseUrl,
        `/api/organizations/${organizationId}/roles/${roleName}`,
        `member-${adaId}`,
        { method: "DELETE" },
      );
      assert.equal(unknownRole.status, 422, roleName);
      assert.equal((await unknownRole.json() as { error: string }).error, "invalid_input", roleName);
    }
  });

  it("makes missing sessions, members, and recoverable persistence failures visible", async () => {
    const { baseUrl, database } = await run();
    assert.equal((await request(baseUrl, `/api/organizations/${organizationId}/roles`, "unknown")).status, 401);
    const missing = await request(baseUrl, `/api/organizations/${organizationId}/members/${missingMemberId}/role`, `member-${adaId}`, {
      method: "PUT", body: JSON.stringify({ role: "Member" }),
    });
    assert.equal(missing.status, 404);
    database.failure = new Error("postgres://secret");
    const unavailable = await request(baseUrl, `/api/organizations/${organizationId}/members/${linusId}/role`, `member-${adaId}`, {
      method: "PUT", body: JSON.stringify({ role: "Admin" }),
    });
    assert.equal(unavailable.status, 503);
    assert.doesNotMatch(await unavailable.text(), /postgres|secret/i);
    assert.equal(database.memberships.get(organizationId)?.get(linusId), "Member");
    const removalUnavailable = await request(baseUrl, `/api/organizations/${organizationId}/members/${linusId}`, `member-${adaId}`, {
      method: "DELETE",
    });
    assert.equal(removalUnavailable.status, 503);
    assert.doesNotMatch(await removalUnavailable.text(), /postgres|secret/i);
    assert.equal(database.memberships.get(organizationId)?.get(linusId), "Member");
    assert.equal(database.activeSessions.has(linusId), true);
    assert.equal(database.personalTokens.has(linusId), true);
    assert.equal(database.repositoryConnections.get("personal-github-connection")?.state, "active");
  });

  it("rejects malformed Organization and Member identifiers before repository access", async () => {
    const { baseUrl, database } = await run();
    const originalMemberships = structuredClone([...database.memberships.entries()].map(
      ([id, members]) => [id, [...members.entries()]],
    ));

    for (const path of [
      "/api/organizations/not-a-uuid/roles",
      "/api/organizations/%E0%A4%A/roles",
      `/api/organizations/${organizationId}/members/not-a-uuid/role`,
      `/api/organizations/${organizationId}/members/%E0%A4%A/role`,
    ]) {
      const response = await request(baseUrl, path, `member-${adaId}`, {
        method: path.endsWith("/role") ? "PUT" : "GET",
        ...(path.endsWith("/role") ? { body: JSON.stringify({ role: "Admin" }) } : {}),
      });
      assert.equal(response.status, 422, path);
      assert.equal((await response.json() as { error: string }).error, "invalid_input", path);
    }
    assert.deepEqual(
      [...database.memberships.entries()].map(([id, members]) => [id, [...members.entries()]]),
      originalMemberships,
    );
  });
});

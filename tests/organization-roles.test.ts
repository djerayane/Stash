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

class ProtocolCompatibleDatabase implements DatabaseProbe, OrganizationRoleRepository {
  readonly memberships = new Map<string, Map<string, BuiltInOrganizationRole>>([
    [organizationId, new Map([["ada", "Owner"], ["grace", "Admin"], ["linus", "Member"]])],
    [otherOrganizationId, new Map([["margaret", "Owner"]])],
  ]);
  failure: Error | undefined;

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
    return "removed" as const;
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
      memberAccess: access,
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
    const roles = await request(baseUrl, `/api/organizations/${organizationId}/roles`, "member-ada");
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
      `/api/organizations/${organizationId}/members/linus/role`,
      "member-ada",
      { method: "PUT", body: JSON.stringify({ role: "Admin" }) },
    );
    assert.equal(promoted.status, 200);
    assert.deepEqual(await promoted.json(), { organizationId, memberId: "linus", role: "Admin" });
    assert.equal(database.memberships.get(organizationId)?.get("linus"), "Admin");
  });

  it("protects the final Owner until ownership transfers", async () => {
    const { baseUrl, database } = await run();
    for (const [path, init] of [
      [`/api/organizations/${organizationId}/members/ada/role`, { method: "PUT", body: JSON.stringify({ role: "Admin" }) }],
      [`/api/organizations/${organizationId}/members/ada`, { method: "DELETE" }],
    ] as const) {
      const denied = await request(baseUrl, path, "member-ada", init);
      assert.equal(denied.status, 409);
      assert.deepEqual(await denied.json(), {
        error: "final_owner",
        message: "Transfer ownership before removing or reassigning the final Owner.",
      });
      assert.equal(database.memberships.get(organizationId)?.get("ada"), "Owner");
    }

    assert.equal((await request(baseUrl, `/api/organizations/${organizationId}/members/grace/role`, "member-ada", {
      method: "PUT", body: JSON.stringify({ role: "Owner" }),
    })).status, 200);
    assert.equal((await request(baseUrl, `/api/organizations/${organizationId}/members/ada`, "member-ada", {
      method: "DELETE",
    })).status, 204);
    assert.equal(database.memberships.get(organizationId)?.has("ada"), false);
  });

  it("rejects non-Owners, invalid Roles, and attempts to mutate built-in definitions", async () => {
    const { baseUrl, database } = await run();
    const denied = await request(baseUrl, `/api/organizations/${organizationId}/members/linus/role`, "member-grace", {
      method: "PUT", body: JSON.stringify({ role: "Admin" }),
    });
    assert.equal(denied.status, 403);
    assert.equal(database.memberships.get(organizationId)?.get("linus"), "Member");

    const crossOrganization = await request(baseUrl, `/api/organizations/${otherOrganizationId}/roles`, "member-ada");
    assert.equal(crossOrganization.status, 403);
    const invalid = await request(baseUrl, `/api/organizations/${organizationId}/members/linus/role`, "member-ada", {
      method: "PUT", body: JSON.stringify({ role: "SuperAdmin" }),
    });
    assert.equal(invalid.status, 422);
    const immutable = await request(baseUrl, `/api/organizations/${organizationId}/roles/Admin`, "member-ada", {
      method: "DELETE",
    });
    assert.equal(immutable.status, 409);
    assert.deepEqual(await immutable.json(), {
      error: "built_in_role_immutable",
      message: "Owner, Admin, and Member Roles cannot be edited or deleted.",
    });
  });

  it("makes missing sessions, members, and recoverable persistence failures visible", async () => {
    const { baseUrl, database } = await run();
    assert.equal((await request(baseUrl, `/api/organizations/${organizationId}/roles`, "unknown")).status, 401);
    const missing = await request(baseUrl, `/api/organizations/${organizationId}/members/missing/role`, "member-ada", {
      method: "PUT", body: JSON.stringify({ role: "Member" }),
    });
    assert.equal(missing.status, 404);
    database.failure = new Error("postgres://secret");
    const unavailable = await request(baseUrl, `/api/organizations/${organizationId}/members/linus/role`, "member-ada", {
      method: "PUT", body: JSON.stringify({ role: "Admin" }),
    });
    assert.equal(unavailable.status, 503);
    assert.doesNotMatch(await unavailable.text(), /postgres|secret/i);
    assert.equal(database.memberships.get(organizationId)?.get("linus"), "Member");
  });
});

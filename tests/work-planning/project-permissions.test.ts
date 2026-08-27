import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { startInstance, type DatabaseProbe, type RunningInstance } from "../support/start-test-instance.js";
import { createAuthenticationSecretCodec } from "../../src/authentication-secrets.js";
import { EmbeddedInstanceStore } from "../../src/embedded-instance-store.js";
import { builtInProjectCreationPermissions, OrganizationRoleService } from "../../src/organization-roles.js";
import {
  WorkspaceProjectService,
  type MemberAccessResolver,
  type PortableIdentity,
  type PortableProjectProjection,
  type WorkspaceProjectRecord,
  type WorkspaceProjectRepository,
} from "../../src/workspaces-projects.js";

const personalWorkspaceId = "11111111-1111-4111-8111-111111111111";
const organizationWorkspaceId = "22222222-2222-4222-8222-222222222222";

class ProjectPermissionRepository implements DatabaseProbe, WorkspaceProjectRepository {
  readonly identities = new Map<string, PortableIdentity>([
    ["owner", { localAccountId: "owner", displayName: "Personal Owner" }],
    ["admin", { localAccountId: "admin", displayName: "Admin" }],
    ["member", { localAccountId: "member", displayName: "Member" }],
    ["custom", { localAccountId: "custom", displayName: "Custom Role Member" }],
  ]);
  readonly permissions = new Set([
    `owner:${personalWorkspaceId}`,
    `admin:${organizationWorkspaceId}`,
    `custom:${organizationWorkspaceId}`,
  ]);
  readonly projects: WorkspaceProjectRecord[] = [];
  createAttempts = 0;

  async verifyConnection() {}
  async close() {}
  async findPortableMemberIdentity(memberId: string) { return this.identities.get(memberId); }
  async canCreateProject(memberId: string, workspaceId: string) {
    return this.permissions.has(`${memberId}:${workspaceId}`);
  }
  async listAccessibleWorkspaces(memberId: string) {
    if (!this.identities.has(memberId)) return [];
    return [
      { id: personalWorkspaceId, name: "Personal", ownerType: "personal" as const, projects: this.projects.filter(({ workspaceId }) => workspaceId === personalWorkspaceId) },
      { id: organizationWorkspaceId, name: "Organization", ownerType: "organization" as const, projects: this.projects.filter(({ workspaceId }) => workspaceId === organizationWorkspaceId) },
    ];
  }
  async createWorkspace(): Promise<{ status: "organization_forbidden" }> { return { status: "organization_forbidden" }; }
  async createProject(_memberId: string, record: WorkspaceProjectRecord, _projection: PortableProjectProjection) {
    this.createAttempts += 1;
    this.projects.push(record);
    return "created" as const;
  }
}

const memberAccess: MemberAccessResolver = {
  async authenticateBearer(authorization) {
    const accountId = authorization?.match(/^Bearer member-(owner|admin|member|custom)$/)?.[1];
    return accountId ? { accountId, sessionId: `session-${accountId}` } : undefined;
  },
};

describe("Project creation permission", () => {
  let instance: RunningInstance | undefined;
  const directories: string[] = [];
  afterEach(async () => { await instance?.close(); instance = undefined;
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

  it("defaults create_project to Owner and Admin, not Member, while custom Roles may include it", () => {
    assert.deepEqual(builtInProjectCreationPermissions, {
      Owner: ["create_project"],
      Admin: ["create_project"],
      Member: [],
    });
  });

  it("keeps personal Workspace owners authorized and applies explicit Organization Role grants", async () => {
    const repository = new ProjectPermissionRepository();
    const service = new WorkspaceProjectService(repository);
    assert.equal(await service.canCreateProject("owner", personalWorkspaceId), true);
    assert.equal(await service.canCreateProject("admin", organizationWorkspaceId), true);
    assert.equal(await service.canCreateProject("member", organizationWorkspaceId), false);
    assert.equal(await service.canCreateProject("custom", organizationWorkspaceId), true);
  });

  it("enforces built-in and custom Role grants in the real permission adapter", async () => {
    const directory = await mkdtemp(join(tmpdir(), "stash-project-permission-"));
    directories.push(directory);
    const store = await EmbeddedInstanceStore.open(directory,
      createAuthenticationSecretCodec(randomBytes(32).toString("base64")));
    const organizationId = randomUUID();
    const ownerId = randomUUID();
    const adminId = randomUUID();
    const memberId = randomUUID();
    const customId = randomUUID();
    const workspaceId = randomUUID();
    const personalId = randomUUID();
    assert.equal(await store.database.createFirstOrganizationOwner({ organizationId, organizationName: "Acme",
      ownerId, ownerName: "Owner", ownerEmail: "owner@example.test", passwordHash: "test-only", role: "Owner",
      workspaceId, workspaceName: "Acme Workspace" }), true);
    for (const [id, name, role] of [[adminId, "Admin", "Admin"], [memberId, "Member", "Member"], [customId, "Custom", "Member"]] as const) {
      await store.upgradeDatabase.query("INSERT INTO stash_accounts(id,name,email,password_hash) VALUES($1,$2,$3,'test-only')",
        [id, name, `${name.toLowerCase()}@example.test`]);
      await store.upgradeDatabase.query("INSERT INTO stash_organization_memberships(organization_id,account_id,role) VALUES($1,$2,$3)",
        [organizationId, id, role]);
    }
    const service = new WorkspaceProjectService(store.database.identityAccessRepositories());
    await store.upgradeDatabase.query(`INSERT INTO stash_workspaces
      (id,name,owner_type,personal_owner_id,organization_owner_id,created_by_account_id)
      VALUES($1,'Owner personal','personal',$2,NULL,$2)`, [personalId, ownerId]);
    assert.equal(await service.canCreateProject(ownerId, personalId), true);
    assert.equal(await service.canCreateProject(adminId, personalId), false);
    assert.equal(await service.canCreateProject(ownerId, workspaceId), true);
    assert.equal(await service.canCreateProject(adminId, workspaceId), true);
    assert.equal(await service.canCreateProject(memberId, workspaceId), false);
    const roles = new OrganizationRoleService(store.database.identityAccessRepositories());
    const created = await roles.createCustom(organizationId, ownerId, { name: "Project lead", permissions: ["create_project"] });
    assert.equal(created.result, "created");
    const customRoleId = created.role.id;
    assert.equal(await roles.assignCustom(organizationId, ownerId, customRoleId, customId), "updated");
    assert.equal(await service.canCreateProject(customId, workspaceId), true);
    assert.equal(await roles.updateCustom(organizationId, ownerId, customRoleId,
      { name: "Project lead", permissions: [] }), "updated");
    assert.equal(await service.canCreateProject(customId, workspaceId), false);
    assert.equal(await roles.updateCustom(organizationId, ownerId, customRoleId,
      { name: "Project lead", permissions: ["create_project"] }), "updated");
    assert.equal(await roles.assignCustom(organizationId, ownerId, customRoleId, randomUUID()), "member_not_found");
    await store.upgradeDatabase.query("DELETE FROM stash_organization_memberships WHERE organization_id=$1 AND account_id=$2",
      [organizationId, customId]);
    assert.equal(await service.canCreateProject(customId, workspaceId), false, "an orphan assignment cannot grant access");
    await store.close();
  });

  it("uses the same decision for discovery and mutation without revealing inaccessible content", async () => {
    const repository = new ProjectPermissionRepository();
    instance = await startInstance({ database: repository, host: "127.0.0.1", port: 0,
      instanceAdminToken: "test-admin-token", workspaceProjects: new WorkspaceProjectService(repository), memberAccess });

    const deniedDiscovery = await fetch(`${instance.url}/api/workspaces`, { headers: { authorization: "Bearer member-member" } });
    assert.equal(deniedDiscovery.status, 200);
    const workspaces = (await deniedDiscovery.json() as { workspaces: Array<{ projectCreation: object }> }).workspaces;
    assert.deepEqual(workspaces.map(({ projectCreation }) => projectCreation), [
      { allowed: false, reason: "Only the personal Workspace owner can create Projects here." },
      { allowed: false, reason: "Your Organization Role does not include Project creation." },
    ]);
    const denied = await createProject(instance.url, organizationWorkspaceId, "member", { name: "Hidden", key: "HIDE" });
    assert.equal(denied.status, 403);
    assert.deepEqual(await denied.json(), {
      error: "project_creation_forbidden",
      message: "Your Organization Role does not include Project creation.",
    });
    assert.equal(repository.createAttempts, 0);

    const allowedDiscovery = await fetch(`${instance.url}/api/workspaces`, { headers: { authorization: "Bearer member-custom" } });
    const allowed = (await allowedDiscovery.json() as { workspaces: Array<{ projectCreation: object }> }).workspaces;
    assert.deepEqual(allowed.map(({ projectCreation }) => projectCreation), [
      { allowed: false, reason: "Only the personal Workspace owner can create Projects here." },
      { allowed: true },
    ]);
    const created = await createProject(instance.url, organizationWorkspaceId, "custom", { name: "Launch", key: "LAUNCH" });
    assert.equal(created.status, 201);
    assert.equal(repository.createAttempts, 1);
  });
});

function createProject(baseUrl: string, workspaceId: string, member: string, body: unknown) {
  return fetch(`${baseUrl}/api/workspaces/${workspaceId}/projects`, { method: "POST",
    headers: { authorization: `Bearer member-${member}`, "content-type": "application/json" }, body: JSON.stringify(body) });
}

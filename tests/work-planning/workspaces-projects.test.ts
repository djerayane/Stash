import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { startInstance, type DatabaseProbe, type RunningInstance } from "../support/start-test-instance.js";
import {
  WorkspaceProjectService,
  type MemberAccessResolver,
  type PortableIdentity,
  type PortableOrganizationIdentity,
  type PortableProjectProjection,
  type PortableWorkspaceProjection,
  type WorkspaceProjectRecord,
  type WorkspaceProjectRepository,
  type WorkspaceRecord,
} from "../../src/workspaces-projects.js";
import type { ProjectWorkflow } from "../../src/project-workflows.js";

const acmeOrganizationId = "11111111-1111-4111-8111-111111111111";
const otherOrganizationId = "22222222-2222-4222-8222-222222222222";

class ProtocolCompatibleDatabase implements DatabaseProbe, WorkspaceProjectRepository {
  readonly members = new Map<string, PortableIdentity>([
    ["ada", { localAccountId: "ada", displayName: "Ada Lovelace" }],
    ["grace", { localAccountId: "grace", displayName: "Grace Hopper" }],
  ]);
  readonly organizations = new Map<string, PortableOrganizationIdentity>([
    [acmeOrganizationId, { localOrganizationId: acmeOrganizationId, displayName: "Acme" }],
    [otherOrganizationId, { localOrganizationId: otherOrganizationId, displayName: "Other Org" }],
  ]);
  readonly organizationMembers = new Map<string, Set<string>>();
  readonly workspaces = new Map<string, WorkspaceRecord>();
  readonly projects = new Map<string, WorkspaceProjectRecord>();
  readonly workflows = new Map<string, ProjectWorkflow>();
  readonly portableProjectionOutbox: object[] = [];
  readonly organizationAuthorizationAttempts: string[] = [];
  failure: Error | undefined;
  projectionFailure: Error | undefined;

  async verifyConnection(): Promise<void> {}
  async close(): Promise<void> {}

  async findPortableMemberIdentity(memberId: string) {
    return this.members.get(memberId);
  }

  async listAccessibleWorkspaces(memberId: string) {
    return [...this.workspaces.values()].filter((workspace) => workspace.owner.type === "personal" ? workspace.owner.id === memberId : this.organizationMembers.get(workspace.owner.id)?.has(memberId)).map((workspace) => ({ id: workspace.id, name: workspace.name, ownerType: workspace.owner.type, projects: [...this.projects.values()].filter((project) => project.workspaceId === workspace.id).map((project) => ({ id: project.id, name: project.name, key: project.key })) }));
  }

  async canCreateProject(memberId: string, workspaceId: string) {
    const workspace = this.workspaces.get(workspaceId);
    return workspace?.owner.type === "personal" ? workspace.owner.id === memberId
      : workspace?.owner.type === "organization" && memberId === "ada";
  }

  async createWorkspace(
    record: WorkspaceRecord,
    createdBy: PortableIdentity,
  ): Promise<
    | { status: "created"; projection: PortableWorkspaceProjection }
    | { status: "organization_forbidden" }
  > {
    if (this.failure) throw this.failure;
    let owner: PortableWorkspaceProjection["owner"];
    if (record.owner.type === "organization") {
      this.organizationAuthorizationAttempts.push(record.owner.id);
      const authorized = this.organizationMembers.get(record.owner.id)?.has(
        record.createdByMemberId,
      ) === true;
      const identity = authorized ? this.organizations.get(record.owner.id) : undefined;
      if (!identity) return { status: "organization_forbidden" };
      owner = { type: "organization", identity };
    } else {
      owner = { type: "personal", identity: createdBy };
    }
    const projection: PortableWorkspaceProjection = {
      schema: "stash.workspace.v1",
      id: record.id,
      name: record.name,
      owner,
      createdBy,
    };
    if (this.projectionFailure) throw this.projectionFailure;
    this.portableProjectionOutbox.push(projection);
    this.workspaces.set(record.id, record);
    return { status: "created", projection };
  }

  async createProject(
    memberId: string,
    record: WorkspaceProjectRecord,
    projection: PortableProjectProjection,
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
    if (this.projectionFailure) throw this.projectionFailure;
    const workflow: ProjectWorkflow = { schema: "stash.workflow.v1", projectId: record.id, revision: 1, statuses: [
      { id: "55555555-5555-4555-8555-555555555555", name: "Backlog", category: "unstarted", position: 0, archived: false },
      { id: "66666666-6666-4666-8666-666666666666", name: "Ready", category: "unstarted", position: 1, archived: false },
      { id: "77777777-7777-4777-8777-777777777777", name: "In Progress", category: "started", position: 2, archived: false },
      { id: "88888888-8888-4888-8888-888888888888", name: "In Review", category: "started", position: 3, archived: false },
      { id: "99999999-9999-4999-8999-999999999999", name: "Done", category: "completed", position: 4, archived: false },
    ] };
    this.portableProjectionOutbox.push(projection);
    this.portableProjectionOutbox.push(workflow);
    this.projects.set(record.id, record);
    this.workflows.set(record.id, workflow);
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
    database.organizationMembers.set(acmeOrganizationId, new Set(["ada"]));
    database.organizationMembers.set(otherOrganizationId, new Set(["grace"]));
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

  it("lists only the Member's accessible Workspaces and Projects for discovery", async () => {
    const { baseUrl, database } = await run();
    const workspace = await (await createWorkspace(baseUrl, "member-ada", { name: "Engine Room", owner: { type: "personal" } })).json() as { id: string };
    await createProject(baseUrl, workspace.id, "member-ada", { name: "Launch", key: "LAUNCH" });
    const response = await fetch(`${baseUrl}/api/workspaces`, { headers: { authorization: "Bearer member-ada" } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { workspaces: [{ id: workspace.id, name: "Engine Room", projects: [{ id: [...database.projects.keys()][0], name: "Launch", key: "LAUNCH" }], projectCreation: { allowed: true } }] });
  });

  it("lets a Member create a personal Workspace owned only by that Member", async () => {
    const { baseUrl } = await run();

    const response = await createWorkspace(baseUrl, "member-ada", {
      name: "Ada's Workspace",
      owner: { type: "personal" },
    });

    assert.equal(response.status, 201);
    const workspace = await response.json() as {
      id: string;
      name: string;
      owner: object;
      portableProjection: object;
    };
    assert.equal(workspace.name, "Ada's Workspace");
    assert.deepEqual(workspace.owner, { type: "personal", id: "ada" });
    assert.deepEqual(workspace.portableProjection, {
      format: "stash.workspace.v1",
      state: "recorded",
      createdBy: { localAccountId: "ada", displayName: "Ada Lovelace" },
      owner: {
        type: "personal",
        identity: { localAccountId: "ada", displayName: "Ada Lovelace" },
      },
    });

    const denied = await createProject(baseUrl, workspace.id, "member-grace", {
      name: "Private Project",
      key: "PRIVATE",
    });
    assert.equal(denied.status, 403);
    assert.deepEqual(await denied.json(), {
      error: "project_creation_forbidden",
      message: "Your Organization Role does not include Project creation.",
    });
  });

  it("lets an authorized Organization Member create an Organization Workspace and Project", async () => {
    const { baseUrl, database } = await run();
    const workspaceResponse = await createWorkspace(baseUrl, "member-ada", {
      name: "Acme Product",
      owner: { type: "organization", organizationId: acmeOrganizationId },
    });
    assert.equal(workspaceResponse.status, 201);
    const workspace = await workspaceResponse.json() as {
      id: string;
      owner: object;
      portableProjection: object;
    };
    assert.deepEqual(workspace.owner, { type: "organization", id: acmeOrganizationId });
    assert.deepEqual(workspace.portableProjection, {
      format: "stash.workspace.v1",
      state: "recorded",
      createdBy: { localAccountId: "ada", displayName: "Ada Lovelace" },
      owner: {
        type: "organization",
        identity: { localOrganizationId: acmeOrganizationId, displayName: "Acme" },
      },
    });

    const projectResponse = await createProject(baseUrl, workspace.id, "member-ada", {
      name: "Launch",
      key: "LAUNCH",
    });
    assert.equal(projectResponse.status, 201);
    const project = await projectResponse.json() as Record<string, unknown>;
    assert.equal(project.workspaceId, workspace.id);
    assert.equal(project.name, "Launch");
    assert.equal(project.key, "LAUNCH");
    assert.deepEqual(project.portableProjection, {
      format: "stash.project.v1",
      state: "recorded",
      createdBy: { localAccountId: "ada", displayName: "Ada Lovelace" },
    });
    const workflow = database.workflows.get(project.id as string);
    assert.ok(workflow, "Project creation must initialize its Workflow before any Workflow or Task request");
    assert.equal(workflow.revision, 1);
    assert.deepEqual(workflow.statuses.map(({ name, category, position }) => ({ name, category, position })), [
      { name: "Backlog", category: "unstarted", position: 0 },
      { name: "Ready", category: "unstarted", position: 1 },
      { name: "In Progress", category: "started", position: 2 },
      { name: "In Review", category: "started", position: 3 },
      { name: "Done", category: "completed", position: 4 },
    ]);
    assert.deepEqual(database.portableProjectionOutbox.slice(-2).map((item) => (item as { schema: string }).schema),
      ["stash.project.v1", "stash.workflow.v1"]);
  });

  it("does not reveal whether a Workspace belongs to another Organization", async () => {
    const { baseUrl, database } = await run();
    const workspaceResponse = await createWorkspace(baseUrl, "member-ada", {
      name: "Acme Product",
      owner: { type: "organization", organizationId: acmeOrganizationId },
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
      error: "project_creation_forbidden",
      message: "Your Organization Role does not include Project creation.",
    });

    const authorizationWorkBeforeDeniedRequests = database.organizationAuthorizationAttempts.length;
    const foreignOwner = await createWorkspace(baseUrl, "member-grace", {
      name: "Not Grace's Organization",
      owner: { type: "organization", organizationId: acmeOrganizationId },
    });
    assert.equal(foreignOwner.status, 403);
    assert.deepEqual(await foreignOwner.json(), {
      error: "organization_forbidden",
      message: "This Member cannot create Workspaces for that Organization.",
    });

    const missingOwner = await createWorkspace(baseUrl, "member-grace", {
      name: "Missing Organization",
      owner: {
        type: "organization",
        organizationId: "33333333-3333-4333-8333-333333333333",
      },
    });
    assert.equal(missingOwner.status, 403);
    assert.deepEqual(await missingOwner.json(), {
      error: "organization_forbidden",
      message: "This Member cannot create Workspaces for that Organization.",
    });
    assert.deepEqual(
      database.organizationAuthorizationAttempts.slice(authorizationWorkBeforeDeniedRequests),
      [acmeOrganizationId, "33333333-3333-4333-8333-333333333333"],
    );
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

  it("rejects malformed Workspace identifiers instead of reporting a persistence outage", async () => {
    const { baseUrl } = await run();

    for (const workspaceId of ["not-a-uuid", "%E0%A4%A"]) {
      const response = await createProject(baseUrl, workspaceId, "member-ada", {
        name: "Invalid target",
        key: "INVALID",
      });
      assert.equal(response.status, 422);
      assert.deepEqual(await response.json(), {
        error: "invalid_input",
        message: "A Project requires a valid Workspace id, name, and 2-20 character key.",
      });
    }
  });

  it("rejects a malformed Organization identifier before persistence", async () => {
    const { baseUrl, database } = await run();

    const response = await createWorkspace(baseUrl, "member-ada", {
      name: "Invalid Organization Workspace",
      owner: { type: "organization", organizationId: "not-a-uuid" },
    });

    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), {
      error: "invalid_input",
      message: "A Workspace requires a valid name and personal or Organization owner.",
    });
    assert.equal(database.workspaces.size, 0);
    assert.equal(database.portableProjectionOutbox.length, 0);
  });

  it("does not persist creation when its portable projection cannot be recorded", async () => {
    const { baseUrl, database } = await run();
    database.projectionFailure = new Error("projection unavailable");

    const response = await createWorkspace(baseUrl, "member-ada", {
      name: "Must stay atomic",
      owner: { type: "personal" },
    });

    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: "workspace_unavailable",
      message: "The Workspace or Project could not be created. Try again.",
    });
    assert.equal(database.workspaces.size, 0);
    assert.equal(database.portableProjectionOutbox.length, 0);
  });
});

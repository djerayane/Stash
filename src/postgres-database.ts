import { randomUUID, timingSafeEqual } from "node:crypto";
import { Pool, type PoolClient } from "pg";

import type { DatabaseProbe } from "./instance.js";
import { noteOperationDigest, type NoteConflictResolution, type NoteEditBatch, type NoteEditConflict, type NoteRecord, type NoteRepository, type NoteTriageChange, type NoteTriageResult, type PortableNoteProjection, type PortableTaskProjection, type TaskCreation } from "./notes.js";
import { richTextToMarkdown } from "./rich-text.js";
import type { BootstrapRecord, OwnerBootstrapRepository } from "./owner-bootstrap.js";
import type { AccountAuthenticationRecord, PasswordAuthRepository, SessionRecord } from "./password-auth.js";
import type { OidcAuthRepository, OidcIdentityKey, OidcIdentityRecord, OidcOrganizationConfiguration } from "./oidc-auth.js";
import type { AccountRecoveryRepository, ClaimedEmailRecoveryDelivery, EmailRecoveryDeliveryClaim, EmailRecoveryDeliveryJob, EmailRecoveryRecord, PasskeyRecord, RecoveryCodeRecord } from "./account-recovery.js";
import type { BuiltInOrganizationRole, OrganizationRoleRepository } from "./organization-roles.js";
import type { InvitationRecord, InvitationRepository, ProjectAccessSummary } from "./invitations.js";
import {
  createAuthenticationKeyCheck,
  verifyAuthenticationKeyCheck,
  type AuthenticationSecretCodec,
} from "./authentication-secrets.js";
import type {
  PortableIdentity,
  PortableProjectProjection,
  PortableWorkspaceProjection,
  WorkspaceProjectRecord,
  WorkspaceProjectRepository,
  WorkspaceRecord,
} from "./workspaces-projects.js";
import type { MemberLocalizationPreferences, MemberLocalizationRepository } from "./member-localization.js";
import type { PortableRepositoryConnectionProjection, RepositoryConnectionRecord, RepositoryConnectionRepository } from "./repository-connections.js";
import type { CreateTaskFromBlockDraft, LinkedTaskReadModel, TaskFromBlockRepository, TaskSourceBlockReference } from "./tasks.js";
import type { AttachmentRecord, AttachmentRepository, PortableAttachmentProjection } from "./attachments.js";

// First 31 bits of SHA-256("stash:authentication-key-check:v1"); reserved in Stash's
// PostgreSQL advisory-lock ID domain for serializing only the authentication key-check transaction.
const authenticationKeyCheckLockId = 795_541_992;
const portableProjectionObjectKinds = ["Workspace", "Project", "Note", "NoteLink", "Task", "GuestProjectAccess", "RepositoryConnection", "Attachment"] as const;
const portableProjectionObjectKindSql = portableProjectionObjectKinds.map((kind) => `'${kind}'`).join(", ");
const repositoryConnectionSelect = `SELECT connection.id, connection.organization_id, connection.provider, connection.installation_id,
  connection.repository_id, connection.repository_url, connection.created_by_account_id, connection.created_by_attribution,
  ARRAY(SELECT project_id FROM stash_repository_connection_projects link WHERE link.connection_id = connection.id ORDER BY project_id) AS project_ids
  FROM stash_repository_connections connection`;

export class PostgresDatabase implements
  DatabaseProbe,
  OwnerBootstrapRepository,
  PasswordAuthRepository,
  WorkspaceProjectRepository,
  NoteRepository,
  OidcAuthRepository,
  AccountRecoveryRepository,
  OrganizationRoleRepository,
  MemberLocalizationRepository,
  InvitationRepository,
  RepositoryConnectionRepository,
  TaskFromBlockRepository,
  AttachmentRepository
{
  readonly #pool: Pool;
  readonly #authenticationSecrets: AuthenticationSecretCodec;

  constructor(connectionString: string, authenticationSecrets: AuthenticationSecretCodec) {
    this.#pool = new Pool({ connectionString, connectionTimeoutMillis: 2_000 });
    this.#authenticationSecrets = authenticationSecrets;
  }

  async verifyConnection(): Promise<void> {
    await this.#pool.query("SELECT 1");
    await this.#verifyAuthenticationKey();
  }

  async createFirstOrganizationOwner(record: BootstrapRecord): Promise<boolean> {
    const client = await this.#pool.connect();
    try {
      await this.#ensureBootstrapSchema(client);
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(2080289093)");
      const existing = await client.query("SELECT 1 FROM stash_instance_bootstrap WHERE singleton = TRUE");
      if (existing.rowCount) {
        await client.query("ROLLBACK");
        return false;
      }

      await client.query("INSERT INTO stash_organizations (id, name) VALUES ($1, $2)", [
        record.organizationId,
        record.organizationName,
      ]);
      await client.query(
        "INSERT INTO stash_accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)",
        [record.ownerId, record.ownerName, record.ownerEmail, this.#authenticationSecrets.encrypt(record.passwordHash)],
      );
      await client.query(
        "INSERT INTO stash_organization_memberships (organization_id, account_id, role) VALUES ($1, $2, $3)",
        [record.organizationId, record.ownerId, record.role],
      );
      await client.query("INSERT INTO stash_instance_bootstrap (singleton) VALUES (TRUE)");
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async findPortableMemberIdentity(memberId: string): Promise<PortableIdentity | undefined> {
    const client = await this.#pool.connect();
    try {
      await this.#ensureBootstrapSchema(client);
      const result = await client.query<{ id: string; name: string }>(
        "SELECT id, name FROM stash_accounts WHERE id = $1",
        [memberId],
      );
      const member = result.rows[0];
      return member
        ? { localAccountId: member.id, displayName: member.name }
        : undefined;
    } finally {
      client.release();
    }
  }

  async findMemberLocalizationPreferences(memberId: string): Promise<MemberLocalizationPreferences | undefined> {
    await this.#ensureMemberLocalizationSchema();
    const result = await this.#pool.query<MemberLocalizationRow>(
      `SELECT locale, time_zone, date_format, week_starts_on, updated_at
       FROM stash_member_localization_preferences WHERE account_id = $1`,
      [memberId],
    );
    const row = result.rows[0];
    return row ? {
      locale: row.locale,
      timeZone: row.time_zone,
      dateFormat: row.date_format,
      weekStartsOn: row.week_starts_on,
      updatedAt: new Date(row.updated_at).toISOString(),
    } : undefined;
  }

  async saveMemberLocalizationPreferences(memberId: string, preferences: MemberLocalizationPreferences): Promise<void> {
    await this.#ensureMemberLocalizationSchema();
    await this.#pool.query(
      `INSERT INTO stash_member_localization_preferences
         (account_id, locale, time_zone, date_format, week_starts_on, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (account_id) DO UPDATE SET
         locale = EXCLUDED.locale,
         time_zone = EXCLUDED.time_zone,
         date_format = EXCLUDED.date_format,
         week_starts_on = EXCLUDED.week_starts_on,
         updated_at = EXCLUDED.updated_at`,
      [memberId, preferences.locale, preferences.timeZone, preferences.dateFormat, preferences.weekStartsOn, preferences.updatedAt],
    );
  }

  async createWorkspace(
    record: WorkspaceRecord,
    createdBy: PortableIdentity,
  ): Promise<
    | { status: "created"; projection: PortableWorkspaceProjection }
    | { status: "organization_forbidden" }
  > {
    return this.#withTransaction(async (client) => {
      await this.#ensureWorkspaceProjectSchema(client);
      let owner: PortableWorkspaceProjection["owner"];
      if (record.owner.type === "organization") {
        const authorizedOrganization = await client.query<{ id: string; name: string }>(
          `SELECT organization.id, organization.name
           FROM stash_organization_memberships membership
           JOIN stash_organizations organization ON organization.id = membership.organization_id
           WHERE membership.organization_id = $1 AND membership.account_id = $2`,
          [record.owner.id, record.createdByMemberId],
        );
        const organization = authorizedOrganization.rows[0];
        if (!organization) return { status: "organization_forbidden" };
        owner = {
          type: "organization",
          identity: {
            localOrganizationId: organization.id,
            displayName: organization.name,
          },
        };
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
      await client.query(
        `INSERT INTO stash_workspaces
          (id, name, owner_type, personal_owner_id, organization_owner_id, created_by_account_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          record.id,
          record.name,
          record.owner.type,
          record.owner.type === "personal" ? record.owner.id : null,
          record.owner.type === "organization" ? record.owner.id : null,
          record.createdByMemberId,
        ],
      );
      await this.#recordPortableProjection(
        client,
        "Workspace",
        record.id,
        "stash.workspace.v1",
        projection,
      );
      return { status: "created", projection };
    });
  }

  async createProject(
    memberId: string,
    record: WorkspaceProjectRecord,
    projection: PortableProjectProjection,
  ): Promise<"created" | "workspace_forbidden" | "workspace_not_found" | "key_conflict"> {
    return this.#withTransaction(async (client) => {
      await this.#ensureWorkspaceProjectSchema(client);
      const access = await client.query<{ allowed: boolean }>(
        `SELECT (
           (owner_type = 'personal' AND personal_owner_id = $2)
           OR (owner_type = 'organization' AND EXISTS (
             SELECT 1 FROM stash_organization_memberships membership
             WHERE membership.organization_id = stash_workspaces.organization_owner_id
               AND membership.account_id = $2
           ))
         ) AS allowed
         FROM stash_workspaces WHERE id = $1`,
        [record.workspaceId, memberId],
      );
      if (!access.rowCount) return "workspace_not_found";
      if (!access.rows[0]!.allowed) return "workspace_forbidden";
      const inserted = await client.query(
        `INSERT INTO stash_projects (id, workspace_id, name, project_key, created_by_account_id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (workspace_id, project_key) DO NOTHING
         RETURNING id`,
        [record.id, record.workspaceId, record.name, record.key, record.createdByMemberId],
      );
      if (!inserted.rowCount) return "key_conflict";
      await this.#recordPortableProjection(
        client,
        "Project",
        record.id,
        "stash.project.v1",
        projection,
      );
      return "created";
    });
  }

  async createNote(
    memberId: string,
    note: NoteRecord,
    projection: PortableNoteProjection,
  ): Promise<"created" | "workspace_forbidden" | "project_forbidden"> {
    return this.#withTransaction(async (client) => {
      await this.#ensureNoteSchema(client);
      const access = await client.query<{ allowed: boolean }>(
        `SELECT (
           (owner_type = 'personal' AND personal_owner_id = $2)
           OR (owner_type = 'organization' AND EXISTS (
             SELECT 1 FROM stash_organization_memberships membership
             WHERE membership.organization_id = stash_workspaces.organization_owner_id
               AND membership.account_id = $2
           ))
         ) AS allowed
         FROM stash_workspaces WHERE id = $1`,
        [note.workspaceId, memberId],
      );
      if (!access.rows[0]?.allowed) return "workspace_forbidden";
      if (note.projectId) {
        const project = await client.query(
          "SELECT 1 FROM stash_projects WHERE id = $1 AND workspace_id = $2",
          [note.projectId, note.workspaceId],
        );
        if (!project.rowCount) return "project_forbidden";
      }
      await client.query(
        `INSERT INTO stash_notes
          (id, workspace_id, project_id, content, document, revision, tags, reminder_at, created_by_account_id, created_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8, $9, $10)`,
        [
          note.id,
          note.workspaceId,
          note.projectId ?? null,
          note.content,
          JSON.stringify(note.document),
          note.revision,
          JSON.stringify(note.tags),
          note.reminder?.at ?? null,
          note.createdByMemberId,
          note.createdAt,
        ],
      );
      await this.#recordPortableProjection(client, "Note", note.id, "stash.note.v1", projection);
      return "created";
    });
  }

  async listInboxNotes(memberId: string, workspaceId: string) {
    const client = await this.#pool.connect();
    try {
      await this.#ensureNoteSchema(client);
      const access = await client.query(`SELECT 1 FROM stash_workspaces workspace WHERE workspace.id = $1 AND (
        (workspace.owner_type = 'personal' AND workspace.personal_owner_id = $2) OR
        (workspace.owner_type = 'organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
          WHERE membership.organization_id = workspace.organization_owner_id AND membership.account_id = $2)))`, [workspaceId, memberId]);
      if (!access.rowCount) return { status: "workspace_forbidden" as const };
      const result = await client.query<any>(`SELECT id, workspace_id, project_id, content, document, revision, tags, reminder_at,
        created_by_account_id, created_at, archived_at FROM stash_notes
        WHERE workspace_id = $1 AND project_id IS NULL AND archived_at IS NULL ORDER BY created_at, id`, [workspaceId]);
      return { status: "found" as const, notes: result.rows.map((row: any) => ({ id: row.id, workspaceId: row.workspace_id,
        content: row.content, document: row.document, revision: row.revision, tags: row.tags, createdByMemberId: row.created_by_account_id,
        createdAt: new Date(row.created_at).toISOString(), ...(row.project_id ? { projectId: row.project_id } : {}),
        ...(row.reminder_at ? { reminder: { at: new Date(row.reminder_at).toISOString() } } : {}),
        ...(row.archived_at ? { archivedAt: new Date(row.archived_at).toISOString() } : {}) })) };
    } finally { client.release(); }
  }

  async createAttachment(memberId: string, record: AttachmentRecord, projection: PortableAttachmentProjection): Promise<"created" | "workspace_forbidden"> {
    return this.#withTransaction(async (client) => {
      await this.#ensureAttachmentSchema(client);
      const access = await client.query(`SELECT 1 FROM stash_workspaces workspace WHERE workspace.id = $1 AND ((workspace.owner_type = 'personal' AND workspace.personal_owner_id = $2) OR EXISTS (SELECT 1 FROM stash_organization_memberships membership WHERE membership.organization_id = workspace.organization_owner_id AND membership.account_id = $2))`, [record.workspaceId, memberId]);
      if (!access.rowCount) return "workspace_forbidden";
      await client.query(`INSERT INTO stash_attachments (id, workspace_id, filename, content_type, byte_size, relative_path, storage_key, source, created_by_account_id, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [record.id, record.workspaceId, record.filename, record.contentType, record.size, record.relativePath, record.storageKey, record.source, memberId, record.createdAt]);
      await this.#recordPortableProjection(client, "Attachment", record.id, projection.schema, projection);
      return "created";
    });
  }

  async canCreateAttachment(memberId: string, workspaceId: string): Promise<boolean> {
    const client = await this.#pool.connect();
    try {
      await this.#ensureWorkspaceProjectSchema(client);
      const access = await client.query(`SELECT 1 FROM stash_workspaces workspace WHERE workspace.id = $1 AND ((workspace.owner_type = 'personal' AND workspace.personal_owner_id = $2) OR EXISTS (SELECT 1 FROM stash_organization_memberships membership WHERE membership.organization_id = workspace.organization_owner_id AND membership.account_id = $2))`, [workspaceId, memberId]);
      return access.rowCount === 1;
    } finally { client.release(); }
  }

  async findAttachmentForMember(memberId: string, attachmentId: string): Promise<AttachmentRecord | undefined> {
    const client = await this.#pool.connect();
    try {
      await this.#ensureAttachmentSchema(client);
      const result = await client.query<AttachmentRow>(`SELECT attachment.* FROM stash_attachments attachment JOIN stash_workspaces workspace ON workspace.id = attachment.workspace_id WHERE attachment.id = $1 AND ((workspace.owner_type = 'personal' AND workspace.personal_owner_id = $2) OR EXISTS (SELECT 1 FROM stash_organization_memberships membership WHERE membership.organization_id = workspace.organization_owner_id AND membership.account_id = $2))`, [attachmentId, memberId]);
      const row = result.rows[0];
      return row ? { id: row.id, workspaceId: row.workspace_id, filename: row.filename, contentType: row.content_type, size: Number(row.byte_size), relativePath: row.relative_path, storageKey: row.storage_key, source: row.source, createdByMemberId: row.created_by_account_id, createdAt: new Date(row.created_at).toISOString() } : undefined;
    } finally { client.release(); }
  }

  async triageNote(memberId: string, workspaceId: string, noteId: string, change: NoteTriageChange) {
    return this.#withTransaction(async (client) => {
      await this.#ensureNoteSchema(client);
      const source = await client.query(`SELECT 1 FROM stash_notes note JOIN stash_workspaces workspace ON workspace.id = note.workspace_id
        WHERE note.id = $1 AND note.workspace_id = $2 AND note.project_id IS NULL AND note.archived_at IS NULL
        AND ((workspace.owner_type = 'personal' AND workspace.personal_owner_id = $3)
        OR (workspace.owner_type = 'organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
          WHERE membership.organization_id = workspace.organization_owner_id AND membership.account_id = $3))) FOR UPDATE`, [noteId, workspaceId, memberId]);
      if (!source.rowCount) return { status: "note_not_found" as const };
      const applied = await this.#applyTriageChange(client, memberId, workspaceId, noteId, change);
      if ("status" in applied) return applied;
      const result = applied.result;
      for (const projection of result.projections) await this.#recordPortableProjection(client,
        triageObjectKind(result), triageObjectId(result, noteId),
        projection.schema, projection);
      return { status: "updated" as const, result };
    });
  }

  async createTaskFromBlock(memberId: string, noteId: string, blockKey: string, draft: CreateTaskFromBlockDraft) {
    return this.#withTransaction(async (client) => {
      await this.#ensureNoteSchema(client);
      const source = await client.query<any>(`SELECT note.workspace_id, note.content, note.document, note.revision,
        note.tags, note.project_id, note.reminder_at, note.created_by_account_id, note.created_at, note.archived_at
        , creator.name AS created_by_name FROM stash_notes note JOIN stash_workspaces workspace ON workspace.id = note.workspace_id
        JOIN stash_accounts creator ON creator.id = note.created_by_account_id
        WHERE note.id = $1 AND note.archived_at IS NULL AND ((workspace.owner_type = 'personal' AND workspace.personal_owner_id = $2)
        OR (workspace.owner_type = 'organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
          WHERE membership.organization_id = workspace.organization_owner_id AND membership.account_id = $2))) FOR UPDATE`,
      [noteId, memberId]);
      const row = source.rows[0];
      if (!row) return { status: "note_not_found" as const };
      const project = await client.query("SELECT 1 FROM stash_projects WHERE id = $1 AND workspace_id = $2", [draft.projectId, row.workspace_id]);
      if (!project.rowCount) return { status: "project_forbidden" as const };
      const blocks = row.document.blocks as Array<{ blockKey?: string; id?: string }>;
      const matches = blocks.filter((block) => block.blockKey === blockKey);
      if (matches.length !== 1) return { status: "block_not_found" as const };
      const block = matches[0]!;
      const blockId = block.id ?? randomUUID();
      const noteProjection = () => ({ schema: "stash.note.v1" as const, id: noteId, workspaceId: row.workspace_id,
        content: row.content, tags: row.tags, createdAt: new Date(row.created_at).toISOString(),
        createdBy: { localAccountId: row.created_by_account_id, displayName: row.created_by_name },
        ...(row.project_id ? { projectId: row.project_id } : {}), ...(row.reminder_at ? { reminder: { at: new Date(row.reminder_at).toISOString() } } : {}) });
      if (!block.id) {
        block.id = blockId;
        const content = richTextToMarkdown(row.document);
        await client.query("UPDATE stash_notes SET document = $2::jsonb, content = $3, revision = revision + 1 WHERE id = $1",
          [noteId, JSON.stringify(row.document), content]);
        row.content = content;
        await this.#recordPortableProjection(client, "Note", noteId, "stash.note.v1", noteProjection());
      }
      const task = await this.#createTask(client, { ...draft, workspaceId: row.workspace_id, sourceNoteIds: [noteId],
        sourceBlocks: [{ noteId, blockId }] });
      await client.query("INSERT INTO stash_tasks (id, workspace_id, project_id, task_key, workflow_status_id, title, created_by_account_id, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
        [task.id, row.workspace_id, task.projectId, task.key, task.status.id, task.title, memberId, task.createdAt]);
      await client.query("INSERT INTO stash_task_note_sources (task_id, note_id) VALUES ($1,$2)", [task.id, noteId]);
      await client.query("INSERT INTO stash_task_block_sources (task_id, note_id, block_id) VALUES ($1,$2,$3)", [task.id, noteId, blockId]);
      await this.#recordPortableProjection(client, "Task", task.id, task.schema, task);
      const sourceBlock: TaskSourceBlockReference = { noteId, blockId };
      return { status: "created" as const, task, sourceBlock };
    });
  }

  async listLinkedTasks(memberId: string, noteId: string) {
    const client = await this.#pool.connect();
    try {
      await this.#ensureNoteSchema(client);
      const result = await client.query<any>(`SELECT task.id, task.task_key, task.title, status.id AS status_id,
        status.name AS status_name, status.category, source.block_id
        FROM stash_notes note JOIN stash_workspaces workspace ON workspace.id = note.workspace_id
        LEFT JOIN stash_task_block_sources source ON source.note_id = note.id
        LEFT JOIN stash_tasks task ON task.id = source.task_id
        LEFT JOIN stash_workflow_statuses status ON status.id = task.workflow_status_id
        WHERE note.id = $1 AND note.archived_at IS NULL AND ((workspace.owner_type = 'personal' AND workspace.personal_owner_id = $2)
        OR (workspace.owner_type = 'organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
          WHERE membership.organization_id = workspace.organization_owner_id AND membership.account_id = $2)))
        ORDER BY task.created_at NULLS FIRST, task.id NULLS FIRST`, [noteId, memberId]);
      if (!result.rowCount) return { status: "note_not_found" as const };
      const tasks: LinkedTaskReadModel[] = result.rows.filter((row: any) => row.id !== null).map((row: any) => ({ id: row.id, key: row.task_key, title: row.title,
        status: { id: row.status_id, name: row.status_name, category: row.category }, sourceBlock: { noteId, blockId: row.block_id } }));
      return { status: "found" as const, tasks };
    } finally { client.release(); }
  }

  async #applyTriageChange(client: PoolClient, memberId: string, workspaceId: string, noteId: string, change: NoteTriageChange): Promise<
    { result: NoteTriageResult } | { status: "project_forbidden" | "target_note_not_found" }
  > {
    switch (change.kind) {
      case "organized": return this.#organizeInboxNote(client, workspaceId, noteId, change);
      case "archived": return this.#archiveInboxNote(client, noteId, change);
      case "linked": return this.#linkInboxNote(client, workspaceId, noteId, change);
      case "task_created": return this.#createTaskFromInbox(client, memberId, workspaceId, noteId, change);
    }
  }

  async #organizeInboxNote(client: PoolClient, workspaceId: string, noteId: string, change: Extract<NoteTriageChange, { kind: "organized" }>) {
    const project = await client.query("SELECT 1 FROM stash_projects WHERE id = $1 AND workspace_id = $2", [change.note.projectId, workspaceId]);
    if (!project.rowCount) return { status: "project_forbidden" as const };
    await client.query("UPDATE stash_notes SET project_id = $2, tags = $3::jsonb WHERE id = $1", [noteId, change.note.projectId, JSON.stringify(change.note.tags)]);
    return { result: change };
  }

  async #archiveInboxNote(client: PoolClient, noteId: string, change: Extract<NoteTriageChange, { kind: "archived" }>) {
    await client.query("UPDATE stash_notes SET archived_at = $2 WHERE id = $1", [noteId, change.note.archivedAt]);
    return { result: change };
  }

  async #linkInboxNote(client: PoolClient, workspaceId: string, noteId: string, change: Extract<NoteTriageChange, { kind: "linked" }>) {
    const target = await client.query("SELECT 1 FROM stash_notes WHERE id = $1 AND workspace_id = $2", [change.link.targetNoteId, workspaceId]);
    if (!target.rowCount) return { status: "target_note_not_found" as const };
    await client.query("INSERT INTO stash_note_links (id, workspace_id, source_note_id, target_note_id) VALUES ($1, $2, $3, $4)",
      [change.link.id, workspaceId, noteId, change.link.targetNoteId]);
    return { result: change };
  }

  async #createTaskFromInbox(client: PoolClient, memberId: string, workspaceId: string, noteId: string, change: Extract<NoteTriageChange, { kind: "task_created" }>) {
    const project = await client.query("SELECT 1 FROM stash_projects WHERE id = $1 AND workspace_id = $2", [change.task.projectId, workspaceId]);
    if (!project.rowCount) return { status: "project_forbidden" as const };
    const task = await this.#createTask(client, change.task);
    await client.query("INSERT INTO stash_tasks (id, workspace_id, project_id, task_key, workflow_status_id, title, created_by_account_id, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [task.id, workspaceId, task.projectId, task.key, task.status.id, task.title, memberId, task.createdAt]);
    await client.query("INSERT INTO stash_task_note_sources (task_id, note_id) VALUES ($1,$2)", [change.task.id, noteId]);
    return { result: { kind: "task_created" as const, task, projections: [task] as [PortableTaskProjection] } };
  }

  async #createTask(client: PoolClient, draft: TaskCreation): Promise<PortableTaskProjection> {
    await client.query("SELECT id FROM stash_projects WHERE id = $1 FOR UPDATE", [draft.projectId]);
    await this.#ensureDefaultWorkflow(client, draft.projectId);
    const status = await client.query<{ id: string; name: string; category: "unstarted" }>(
      "SELECT id, name, category FROM stash_workflow_statuses WHERE project_id = $1 AND name = 'Backlog'",
      [draft.projectId],
    );
    const allocation = await client.query<{ project_key: string; task_number: number }>(
      `UPDATE stash_projects SET next_task_number = next_task_number + 1 WHERE id = $1
       RETURNING project_key, next_task_number - 1 AS task_number`, [draft.projectId],
    );
    const workflowStatus = status.rows[0];
    const key = allocation.rows[0];
    if (!workflowStatus || !key) throw new Error("task_project_unavailable");
    return { schema: "stash.task.v1", ...draft, key: `${key.project_key}-${key.task_number}`, status: workflowStatus };
  }

  async #ensureDefaultWorkflow(client: PoolClient, projectId: string): Promise<void> {
    const statuses = [
      [randomUUID(), projectId, "Backlog", "unstarted", 0],
      [randomUUID(), projectId, "Ready", "unstarted", 1],
      [randomUUID(), projectId, "In Progress", "started", 2],
      [randomUUID(), projectId, "In Review", "started", 3],
      [randomUUID(), projectId, "Done", "completed", 4],
    ] as const;
    await client.query(`INSERT INTO stash_workflow_statuses (id, project_id, name, category, position)
      VALUES ${statuses.map((_, index) => `($${index * 5 + 1}, $${index * 5 + 2}, $${index * 5 + 3}, $${index * 5 + 4}, $${index * 5 + 5})`).join(", ")}
      ON CONFLICT DO NOTHING`, statuses.flat());
  }

  async findNoteForMember(memberId: string, noteId: string): Promise<NoteRecord | undefined> {
    await this.#ensureNoteSchemaForPool();
    const result = await this.#pool.query<{
      id: string; workspace_id: string; project_id: string | null; content: string; document: NoteRecord["document"];
      revision: number; tags: string[]; reminder_at: Date | null; created_by_account_id: string; created_at: Date;
    }>(`SELECT note.* FROM stash_notes note JOIN stash_workspaces workspace ON workspace.id = note.workspace_id
       WHERE note.id = $1 AND ((workspace.owner_type = 'personal' AND workspace.personal_owner_id = $2)
       OR (workspace.owner_type = 'organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
       WHERE membership.organization_id = workspace.organization_owner_id AND membership.account_id = $2)))`, [noteId, memberId]);
    const row = result.rows[0];
    return row ? {
      id: row.id, workspaceId: row.workspace_id, content: row.content, document: row.document, revision: row.revision,
      tags: row.tags, createdByMemberId: row.created_by_account_id, createdAt: row.created_at.toISOString(),
      ...(row.project_id ? { projectId: row.project_id } : {}),
      ...(row.reminder_at ? { reminder: { at: row.reminder_at.toISOString() } } : {}),
    } : undefined;
  }

  async applyNoteOperations(memberId: string, noteId: string, batch: NoteEditBatch) {
    return this.#withTransaction(async (client) => {
      await this.#ensureNoteSchema(client);
      const access = await client.query<any>(`SELECT note.*, creator.name AS creator_name FROM stash_notes note JOIN stash_workspaces workspace ON workspace.id = note.workspace_id
        JOIN stash_accounts creator ON creator.id = note.created_by_account_id
        WHERE note.id = $1 AND ((workspace.owner_type = 'personal' AND workspace.personal_owner_id = $2)
        OR (workspace.owner_type = 'organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
        WHERE membership.organization_id = workspace.organization_owner_id AND membership.account_id = $2))) FOR UPDATE OF note`, [noteId, memberId]);
      const row = access.rows[0];
      if (!row) return { status: "not_found" as const };
      const createdBy = { localAccountId: row.created_by_account_id, displayName: row.creator_name };
      const existing = await client.query<{ operation_id: string; operation_digest: string | null }>("SELECT operation_id, operation_digest FROM stash_note_operations WHERE note_id = $1 AND operation_id = ANY($2::uuid[])", [noteId, batch.operations.map(({ id }) => id)]);
      const knownDigests = new Map(existing.rows.map(({ operation_id, operation_digest }) => [operation_id, operation_digest]));
      const acknowledged = await client.query<{ operation_id: string; operation_digest: string }>("SELECT operation_id, operation_digest FROM stash_note_acknowledged_operations WHERE note_id = $1 AND operation_id = ANY($2::uuid[])", [noteId, batch.operations.map(({ id }) => id)]);
      for (const { operation_id, operation_digest } of acknowledged.rows) if (!knownDigests.has(operation_id)) knownDigests.set(operation_id, operation_digest);
      const reused = batch.operations.find((operation) => knownDigests.has(operation.id) && knownDigests.get(operation.id) !== noteOperationDigest(operation));
      if (reused) {
        await client.query("INSERT INTO stash_note_edit_conflicts (id,note_id,base_revision,document,markdown,operations,created_by_account_id,kind) VALUES ($1,$2,$3,$4::jsonb,$5,$6::jsonb,$7,'invalid_operation_id')", [randomUUID(),noteId,batch.baseRevision,JSON.stringify(row.document),row.content,JSON.stringify([reused]),memberId]);
        return { status: "invalid_reference" as const };
      }
      const applied = new Set([...existing.rows, ...acknowledged.rows].map(({ operation_id }) => operation_id));
      const conflicted = await client.query<{ operation_id: string; operation_digest: string | null; conflict_id: string }>("SELECT operation_id, operation_digest, conflict_id FROM stash_note_conflict_operations WHERE note_id = $1 AND operation_id = ANY($2::uuid[])", [noteId, batch.operations.map(({ id }) => id)]);
      const conflictDigests = new Map(conflicted.rows.map(({ operation_id, operation_digest }) => [operation_id, operation_digest]));
      const reusedConflict = batch.operations.find((operation) => conflictDigests.has(operation.id) && conflictDigests.get(operation.id) !== noteOperationDigest(operation));
      if (reusedConflict) {
        await client.query("INSERT INTO stash_note_edit_conflicts (id,note_id,base_revision,document,markdown,operations,created_by_account_id,kind) VALUES ($1,$2,$3,$4::jsonb,$5,$6::jsonb,$7,'invalid_operation_id')", [randomUUID(),noteId,batch.baseRevision,JSON.stringify(row.document),row.content,JSON.stringify([reusedConflict]),memberId]);
        return { status: "invalid_reference" as const };
      }
      const conflictIds = new Set(conflicted.rows.map(({ operation_id }) => operation_id));
      const pending = batch.operations.filter(({ id }) => !applied.has(id) && !conflictIds.has(id));
      const current: NoteRecord = { id: row.id, workspaceId: row.workspace_id, content: row.content, document: row.document,
        revision: row.revision, tags: row.tags, createdByMemberId: row.created_by_account_id, createdAt: new Date(row.created_at).toISOString(),
        ...(row.project_id ? { projectId: row.project_id } : {}), ...(row.reminder_at ? { reminder: { at: new Date(row.reminder_at).toISOString() } } : {}),
        ...(row.archived_at ? { archivedAt: new Date(row.archived_at).toISOString() } : {}) };
      const projectionFor = (note: NoteRecord): PortableNoteProjection => ({ schema: "stash.note.v1", id: note.id,
        workspaceId: note.workspaceId, content: note.content, tags: note.tags, createdAt: note.createdAt, createdBy,
        ...(note.projectId ? { projectId: note.projectId } : {}), ...(note.reminder ? { reminder: note.reminder } : {}) });
      if (!pending.length) return conflictIds.size ? { status: "conflict_preserved" as const, conflictId: conflicted.rows[0]!.conflict_id }
        : { status: "duplicate" as const, note: current, projection: projectionFor(current) };
      const changed = await client.query<{ block_key: string }>("SELECT block_key FROM stash_note_operations WHERE note_id = $1 AND applied_revision > $2", [noteId, batch.baseRevision]);
      const changedKeys = new Set(changed.rows.map(({ block_key }) => block_key));
      if (pending.some((operation) => changedKeys.has(operation.blockKey)
        || (operation.type === "insert_block" && operation.afterBlockKey !== null && changedKeys.has(operation.afterBlockKey)))) {
        const conflictId = randomUUID();
        await client.query("INSERT INTO stash_note_edit_conflicts (id, note_id, base_revision, document, markdown, operations, created_by_account_id) VALUES ($1,$2,$3,$4::jsonb,$5,$6::jsonb,$7)",
          [conflictId, noteId, batch.baseRevision, JSON.stringify(current.document), current.content, JSON.stringify(pending), memberId]);
        for (const operation of pending) await client.query("INSERT INTO stash_note_conflict_operations (note_id,operation_id,conflict_id,operation_digest) VALUES ($1,$2,$3,$4)", [noteId, operation.id, conflictId, noteOperationDigest(operation)]);
        return { status: "conflict_preserved" as const, conflictId };
      }
      const blocks = [...current.document.blocks];
      for (const operation of pending) {
        const index = blocks.findIndex(({ blockKey }) => blockKey === operation.blockKey);
        if (operation.type === "insert_block") {
          if (index >= 0 || operation.block.id) return { status: "invalid_reference" as const };
          const after = operation.afterBlockKey === null ? -1 : blocks.findIndex(({ blockKey }) => blockKey === operation.afterBlockKey);
          if (operation.afterBlockKey !== null && after < 0) return { status: "invalid_reference" as const };
          blocks.splice(after + 1, 0, operation.block);
        } else if (operation.type === "delete_block") {
          if (index < 0 || blocks[index]!.id) return { status: "invalid_reference" as const };
          blocks.splice(index, 1);
        } else {
          if (index < 0 || blocks[index]!.id !== operation.block.id) return { status: "invalid_reference" as const };
          blocks[index] = operation.block;
        }
      }
      if (!blocks.length) return { status: "invalid_reference" as const };
      const document = { type: "doc" as const, blocks };
      const note = { ...current, document, content: richTextToMarkdown(document), revision: current.revision + 1 };
      const projection = projectionFor(note);
      await client.query("UPDATE stash_notes SET content=$2, document=$3::jsonb, revision=$4 WHERE id=$1", [noteId, note.content, JSON.stringify(document), note.revision]);
      for (const operation of pending) await client.query("INSERT INTO stash_note_operations (note_id,operation_id,base_revision,applied_revision,block_key,operation_digest) VALUES ($1,$2,$3,$4,$5,$6)", [noteId, operation.id, batch.baseRevision, note.revision, operation.blockKey, noteOperationDigest(operation)]);
      await this.#recordPortableProjection(client, "Note", note.id, "stash.note.v1", projection);
      return { status: "updated" as const, note, projection };
    });
  }

  async listNoteEditConflicts(memberId: string, noteId: string) {
    await this.#ensureNoteSchemaForPool();
    const result = await this.#pool.query<{
      id: string; note_id: string; base_revision: number; document: NoteRecord["document"]; markdown: string;
      operations: NoteEditBatch["operations"] | null; created_at: Date; resolved_at: Date | null; resolution: NoteConflictResolution | null;
      kind: "concurrent_edit" | "invalid_operation_id"; current_revision: number; creator_name: string;
    }>(`SELECT conflict.id, conflict.note_id, conflict.base_revision, conflict.document, conflict.markdown,
        conflict.operations, conflict.created_at, conflict.resolved_at, conflict.resolution, conflict.kind,
        note.revision AS current_revision, creator.name AS creator_name
      FROM stash_note_edit_conflicts conflict
      JOIN stash_notes note ON note.id = conflict.note_id
      JOIN stash_workspaces workspace ON workspace.id = note.workspace_id
      JOIN stash_accounts creator ON creator.id = conflict.created_by_account_id
      WHERE conflict.note_id = $1 AND conflict.resolved_at IS NULL
        AND ((workspace.owner_type = 'personal' AND workspace.personal_owner_id = $2)
          OR (workspace.owner_type = 'organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
            WHERE membership.organization_id = workspace.organization_owner_id AND membership.account_id = $2)))
      ORDER BY conflict.created_at, conflict.id`, [noteId, memberId]);
    if (!result.rowCount) {
      const note = await this.findNoteForMember(memberId, noteId);
      if (!note) return { status: "not_found" as const };
    }
    const conflicts: NoteEditConflict[] = result.rows.map((row) => ({ id: row.id, noteId: row.note_id,
      baseRevision: row.base_revision, preservedDocument: row.document, preservedMarkdown: row.markdown,
      operations: row.operations ?? [], kind: row.kind, currentRevision: row.current_revision,
      createdBy: { displayName: row.creator_name, attribution: "recorded" }, createdAt: row.created_at.toISOString(),
      ...(row.resolved_at ? { resolvedAt: row.resolved_at.toISOString() } : {}), ...(row.resolution ? { resolution: row.resolution } : {}) }));
    return { status: "found" as const, conflicts };
  }

  async resolveNoteEditConflict(memberId: string, noteId: string, conflictId: string, resolution: NoteConflictResolution, expectedRevision: number) {
    return this.#withTransaction(async (client) => {
      await this.#ensureNoteSchema(client);
      const access = await client.query<any>(`SELECT note.*, creator.name AS creator_name
        FROM stash_notes note JOIN stash_workspaces workspace ON workspace.id = note.workspace_id
        JOIN stash_accounts creator ON creator.id = note.created_by_account_id
        WHERE note.id = $1 AND ((workspace.owner_type = 'personal' AND workspace.personal_owner_id = $2)
          OR (workspace.owner_type = 'organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
            WHERE membership.organization_id = workspace.organization_owner_id AND membership.account_id = $2)))
        FOR UPDATE OF note`, [noteId, memberId]);
      const row = access.rows[0];
      if (!row) return { status: "not_found" as const };
      const found = await client.query<{ operations: NoteEditBatch["operations"] | null; resolved_at: Date | null; base_revision: number;
        document: NoteRecord["document"]; markdown: string; created_at: Date; resolution: NoteConflictResolution | null;
        kind: "concurrent_edit" | "invalid_operation_id"; creator_name: string }>(`SELECT conflict.operations, conflict.resolved_at,
          conflict.base_revision, conflict.document, conflict.markdown, conflict.created_at, conflict.resolution, conflict.kind,
          creator.name AS creator_name FROM stash_note_edit_conflicts conflict JOIN stash_accounts creator
          ON creator.id = conflict.created_by_account_id WHERE conflict.id = $1 AND conflict.note_id = $2 FOR UPDATE OF conflict`, [conflictId, noteId]);
      const conflict = found.rows[0];
      if (!conflict) return { status: "conflict_not_found" as const };
      if (conflict.resolved_at) return { status: "already_resolved" as const };
      if (row.revision !== expectedRevision) return { status: "conflict_changed" as const, conflict: {
        id: conflictId, noteId, baseRevision: conflict.base_revision, preservedDocument: conflict.document,
        preservedMarkdown: conflict.markdown, operations: conflict.operations ?? [], kind: conflict.kind,
        currentRevision: row.revision, createdBy: { displayName: conflict.creator_name, attribution: "recorded" as const },
        createdAt: conflict.created_at.toISOString(), ...(conflict.resolution ? { resolution: conflict.resolution } : {}) } };
      if (resolution === "apply_contribution" && conflict.kind === "invalid_operation_id") return { status: "invalid_operation_identity" as const };
      const current: NoteRecord = { id: row.id, workspaceId: row.workspace_id, content: row.content, document: row.document,
        revision: row.revision, tags: row.tags, createdByMemberId: row.created_by_account_id, createdAt: new Date(row.created_at).toISOString(),
        ...(row.project_id ? { projectId: row.project_id } : {}), ...(row.reminder_at ? { reminder: { at: new Date(row.reminder_at).toISOString() } } : {}),
        ...(row.archived_at ? { archivedAt: new Date(row.archived_at).toISOString() } : {}) };
      const projectionFor = (note: NoteRecord): PortableNoteProjection => ({ schema: "stash.note.v1", id: note.id,
        workspaceId: note.workspaceId, content: note.content, tags: note.tags, createdAt: note.createdAt,
        createdBy: { localAccountId: row.created_by_account_id, displayName: row.creator_name },
        ...(note.projectId ? { projectId: note.projectId } : {}), ...(note.reminder ? { reminder: note.reminder } : {}) });
      let note = current;
      if (resolution === "apply_contribution") {
        const operations = conflict.operations ?? [];
        const blocks = [...current.document.blocks];
        for (const operation of operations) {
          const index = blocks.findIndex(({ blockKey }) => blockKey === operation.blockKey);
          if (operation.type === "insert_block") {
            if (index >= 0 || operation.block.id) return { status: "invalid_reference" as const };
            const after = operation.afterBlockKey === null ? -1 : blocks.findIndex(({ blockKey }) => blockKey === operation.afterBlockKey);
            if (operation.afterBlockKey !== null && after < 0) return { status: "invalid_reference" as const };
            blocks.splice(after + 1, 0, operation.block);
          } else if (operation.type === "delete_block") {
            if (index < 0 || blocks[index]!.id) return { status: "invalid_reference" as const };
            blocks.splice(index, 1);
          } else {
            if (index < 0 || blocks[index]!.id !== operation.block.id) return { status: "invalid_reference" as const };
            blocks[index] = operation.block;
          }
        }
        if (!blocks.length) return { status: "invalid_reference" as const };
        const document = { type: "doc" as const, blocks };
        note = { ...current, document, content: richTextToMarkdown(document), revision: current.revision + 1 };
        await client.query("UPDATE stash_notes SET content=$2, document=$3::jsonb, revision=$4 WHERE id=$1", [noteId, note.content, JSON.stringify(document), note.revision]);
        for (const operation of operations) await client.query(`INSERT INTO stash_note_operations
          (note_id,operation_id,base_revision,applied_revision,block_key,operation_digest) VALUES ($1,$2,$3,$4,$5,$6)
          ON CONFLICT (note_id, operation_id) DO NOTHING`, [noteId, operation.id, conflict.base_revision, note.revision, operation.blockKey, noteOperationDigest(operation)]);
        await client.query("DELETE FROM stash_note_conflict_operations WHERE conflict_id = $1 AND note_id = $2", [conflictId, noteId]);
        await this.#recordPortableProjection(client, "Note", note.id, "stash.note.v1", projectionFor(note));
      } else {
        for (const operation of conflict.operations ?? []) await client.query(`INSERT INTO stash_note_acknowledged_operations
          (note_id,operation_id,operation_digest) VALUES ($1,$2,$3) ON CONFLICT (note_id, operation_id) DO NOTHING`,
          [noteId, operation.id, noteOperationDigest(operation)]);
        await client.query("DELETE FROM stash_note_conflict_operations WHERE conflict_id = $1 AND note_id = $2", [conflictId, noteId]);
      }
      await client.query(`UPDATE stash_note_edit_conflicts SET resolved_at = CURRENT_TIMESTAMP, resolution = $3,
        resolved_by_account_id = $4 WHERE id = $1 AND note_id = $2`, [conflictId, noteId, resolution, memberId]);
      return { status: "resolved" as const, note, projection: projectionFor(note) };
    });
  }
  async close(): Promise<void> {
    await this.#pool.end();
  }

  async findAccountByEmail(email: string): Promise<AccountAuthenticationRecord | undefined> {
    await this.#ensureAuthSchema();
    const result = await this.#pool.query<AccountRow>(
      "SELECT id, name, email, password_hash FROM stash_accounts WHERE email = $1", [email],
    );
    return result.rows[0] ? this.#accountRecord(result.rows[0]) : undefined;
  }

  async findAccountById(id: string): Promise<AccountAuthenticationRecord | undefined> {
    await this.#ensureAuthSchema();
    const result = await this.#pool.query<AccountRow>(
      "SELECT id, name, email, password_hash FROM stash_accounts WHERE id = $1", [id],
    );
    return result.rows[0] ? this.#accountRecord(result.rows[0]) : undefined;
  }

  async createSession(session: SessionRecord): Promise<void> {
    await this.#ensureAuthSchema();
    await this.#pool.query(
      "INSERT INTO stash_sessions (id, account_id, token_lookup, token_hash, created_at, last_seen_at, user_agent) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [
        session.id,
        session.accountId,
        this.#authenticationSecrets.blindIndex(session.tokenHash),
        this.#authenticationSecrets.encrypt(session.tokenHash),
        session.createdAt,
        session.lastSeenAt,
        session.userAgent ?? null,
      ],
    );
  }

  async findOidcIdentity(key: OidcIdentityKey): Promise<OidcIdentityRecord | undefined> {
    await this.#ensureOidcSchema();
    const result = await this.#pool.query<OidcIdentityRow>(`
      SELECT a.id, a.name, a.email, i.subject_secret
      FROM stash_oidc_identities i
      JOIN stash_accounts a ON a.id = i.account_id
      JOIN stash_organization_memberships m ON m.account_id = a.id AND m.organization_id = i.organization_id
      WHERE i.organization_id = $1 AND i.issuer = $2 AND i.subject_lookup = $3
    `, [key.organizationId, key.issuer, this.#oidcIdentityLookup(key)]);
    const row = result.rows[0];
    if (!row || this.#authenticationSecrets.decrypt(row.subject_secret) !== key.subject) return undefined;
    return { accountId: row.id, name: row.name, email: row.email };
  }

  async findOidcConfiguration(organizationId: string): Promise<OidcOrganizationConfiguration | undefined> {
    await this.#ensureOidcSchema();
    const result = await this.#pool.query<OidcConfigurationRow>(
      "SELECT organization_id, issuer, client_id, client_secret FROM stash_oidc_configurations WHERE organization_id = $1",
      [organizationId],
    );
    const row = result.rows[0];
    return row ? {
      organizationId: row.organization_id,
      issuer: row.issuer,
      clientId: row.client_id,
      clientSecret: this.#authenticationSecrets.decrypt(row.client_secret),
    } : undefined;
  }

  async organizationRole(organizationId: string, accountId: string): Promise<BuiltInOrganizationRole | undefined> {
    const result = await this.#pool.query<{ role: BuiltInOrganizationRole }>(
      "SELECT role FROM stash_organization_memberships WHERE organization_id = $1 AND account_id = $2",
      [organizationId, accountId],
    );
    return result.rows[0]?.role;
  }

  async findRepositoryConnectionById(organizationId: string, connectionId: string): Promise<RepositoryConnectionRecord | undefined> {
    await this.#ensureRepositoryConnectionSchema();
    const result = await this.#pool.query<RepositoryConnectionRow>(
      `${repositoryConnectionSelect} WHERE organization_id = $1 AND connection.id = $2`,
      [organizationId, connectionId],
    );
    return result.rows[0] ? repositoryConnectionRecord(result.rows[0]) : undefined;
  }

  async createRepositoryConnection(actorId: string, record: RepositoryConnectionRecord) {
    await this.#ensureRepositoryConnectionSchema();
    return this.#withTransaction(async (client) => {
      const memberships = await this.#lockedOrganizationMemberships(client, record.organizationId);
      if (!this.#canManageRepositoryConnections(memberships, actorId)) return { status: "forbidden" as const };
      const existing = await client.query<RepositoryConnectionRow>(`${repositoryConnectionSelect} WHERE organization_id = $1 AND repository_id = $2 FOR UPDATE`, [record.organizationId, record.repositoryId]);
      if (existing.rows[0]) return { status: "existing" as const, record: repositoryConnectionRecord(existing.rows[0]) };
      await client.query(`INSERT INTO stash_repository_connections (id, organization_id, provider, installation_id, repository_id, repository_url, created_by_account_id, created_by_attribution) VALUES ($1,$2,$3,$4,$5,$6,$7,'recorded')`, [record.id, record.organizationId, record.provider, record.installationId, record.repositoryId, record.repositoryUrl, actorId]);
      await this.#recordRepositoryConnectionProjection(client, record, 1);
      return { status: "created" as const, record };
    });
  }

  async listRepositoryConnections(organizationId: string): Promise<RepositoryConnectionRecord[]> {
    await this.#ensureRepositoryConnectionSchema();
    const result = await this.#pool.query<RepositoryConnectionRow>(
      `${repositoryConnectionSelect} WHERE organization_id = $1 ORDER BY repository_url, id`,
      [organizationId],
    );
    return result.rows.map(repositoryConnectionRecord);
  }

  async attachRepositoryConnectionToProject(actorId: string, organizationId: string, connectionId: string, projectId: string) {
    await this.#ensureRepositoryConnectionSchema();
    return this.#withTransaction(async (client) => {
      const memberships = await this.#lockedOrganizationMemberships(client, organizationId);
      if (!this.#canManageRepositoryConnections(memberships, actorId)) return "forbidden" as const;
      const result = await client.query(
      `INSERT INTO stash_repository_connection_projects (connection_id, project_id)
       SELECT connection.id, project.id
       FROM stash_repository_connections connection
       JOIN stash_projects project ON project.id = $3
       JOIN stash_workspaces workspace ON workspace.id = project.workspace_id
       WHERE connection.id = $2 AND connection.organization_id = $1
         AND workspace.owner_type = 'organization' AND workspace.organization_owner_id = $1
       ON CONFLICT DO NOTHING`,
      [organizationId, connectionId, projectId],
    );
      if (!result.rowCount) {
        const existing = await client.query(
      `SELECT 1 FROM stash_repository_connection_projects link
       JOIN stash_repository_connections connection ON connection.id = link.connection_id
       WHERE connection.organization_id = $1 AND link.connection_id = $2 AND link.project_id = $3`,
      [organizationId, connectionId, projectId],
    );
        if (!existing.rowCount) return "not_found" as const;
      }
      const refreshed = await client.query<RepositoryConnectionRow>(`${repositoryConnectionSelect} WHERE connection.organization_id = $1 AND connection.id = $2`, [organizationId, connectionId]);
      const record = repositoryConnectionRecord(refreshed.rows[0]!);
      const revision = await client.query<{ revision: number }>(`SELECT COALESCE(MAX(revision), 0) + 1 AS revision FROM stash_portable_projection_outbox WHERE object_kind = 'RepositoryConnection' AND object_id = $1`, [connectionId]);
      await this.#recordRepositoryConnectionProjection(client, record, Number(revision.rows[0]!.revision));
      return "attached" as const;
    });
  }

  async assignBuiltInRole(
    organizationId: string,
    actorId: string,
    accountId: string,
    role: BuiltInOrganizationRole,
  ): Promise<"updated" | "member_not_found" | "final_owner" | "forbidden"> {
    return this.#withTransaction(async (client) => {
      const memberships = await this.#lockedOrganizationMemberships(client, organizationId);
      if (!this.#canManageRoles(memberships, actorId)) return "forbidden";
      const target = memberships.find((membership) => membership.account_id === accountId);
      if (!target) return "member_not_found";
      if (target.role === "Owner" && role !== "Owner"
        && this.#isOnlyOwner(memberships, accountId)) {
        return "final_owner";
      }
      await client.query(
        `UPDATE stash_organization_memberships SET role = $3
         WHERE organization_id = $1 AND account_id = $2`,
        [organizationId, accountId, role],
      );
      return "updated";
    });
  }

  async removeOrganizationMember(
    organizationId: string,
    actorId: string,
    accountId: string,
  ): Promise<"removed" | "member_not_found" | "final_owner" | "forbidden"> {
    return this.#withTransaction(async (client) => {
      const memberships = await this.#lockedOrganizationMemberships(client, organizationId);
      if (!this.#canManageRoles(memberships, actorId)) return "forbidden";
      const target = memberships.find((membership) => membership.account_id === accountId);
      if (!target) return "member_not_found";
      if (target.role === "Owner" && this.#isOnlyOwner(memberships, accountId)) {
        return "final_owner";
      }
      await client.query(
        "DELETE FROM stash_organization_memberships WHERE organization_id = $1 AND account_id = $2",
        [organizationId, accountId],
      );
      return "removed";
    });
  }

  async createInvitation(record: InvitationRecord, token: string): Promise<"created" | "forbidden" | "project_forbidden"> {
    return this.#withTransaction(async (client) => {
      await this.#ensureInvitationSchema(client);
      const memberships = await this.#lockedOrganizationMemberships(client, record.organizationId);
      const actorRole = memberships.find(({ account_id }) => account_id === record.invitedByAccountId)?.role;
      if (actorRole !== "Owner" && actorRole !== "Admin") return "forbidden";
      if (actorRole === "Admin" && record.access.kind === "member" && record.access.role !== "Member") return "forbidden";
      if (record.access.kind === "guest") {
        const allowed = await client.query<{ id: string }>(
          `SELECT project.id FROM stash_projects project JOIN stash_workspaces workspace ON workspace.id = project.workspace_id
           WHERE project.id = ANY($1::uuid[]) AND workspace.organization_owner_id = $2`,
          [record.access.projectIds, record.organizationId],
        );
        if (allowed.rowCount !== record.access.projectIds.length) return "project_forbidden";
      }
      await client.query(
        `INSERT INTO stash_invitations (id, organization_id, token_lookup, token_secret, kind, member_role, invited_by_account_id, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [record.id, record.organizationId, this.#authenticationSecrets.blindIndex(token, "invitation-v1"), this.#authenticationSecrets.encrypt(token, "invitation-v1"), record.access.kind, record.access.kind === "member" ? record.access.role : null, record.invitedByAccountId, record.expiresAt],
      );
      if (record.access.kind === "guest") for (const projectId of record.access.projectIds) {
        await client.query("INSERT INTO stash_invitation_projects (invitation_id, project_id) VALUES ($1, $2)", [record.id, projectId]);
      }
      return "created";
    });
  }

  async acceptInvitation(token: string, accountId: string, acceptedAt: string): Promise<
    | { status: "accepted"; access: { kind: "member"; organizationId: string; role: BuiltInOrganizationRole } | { kind: "guest"; organizationId: string; projectIds: string[] } }
    | "invalid_invitation"
  > {
    return this.#withTransaction(async (client) => {
      await this.#ensureInvitationSchema(client);
      await client.query("UPDATE stash_invitations SET token_lookup = NULL, token_secret = NULL WHERE accepted_at IS NULL AND expires_at <= $1", [acceptedAt]);
      const result = await client.query<{ id: string; organization_id: string; kind: "member" | "guest"; member_role: BuiltInOrganizationRole | null; token_secret: string }>(
        `SELECT id, organization_id, kind, member_role, token_secret FROM stash_invitations
         WHERE token_lookup = $1 AND accepted_at IS NULL AND expires_at > $2 FOR UPDATE`, [this.#authenticationSecrets.blindIndex(token, "invitation-v1"), acceptedAt],
      );
      const invitation = result.rows[0];
      if (!invitation || !this.#invitationTokenMatches(invitation.token_secret, token)) return "invalid_invitation";
      if (invitation.kind === "member") {
        const memberships = await this.#lockedOrganizationMemberships(client, invitation.organization_id);
        const invitedRole = invitation.member_role!;
        const existingRole = memberships.find(({ account_id }) => account_id === accountId)?.role;
        const role = existingRole && this.#roleRank(existingRole) >= this.#roleRank(invitedRole) ? existingRole : invitedRole;
        if (!existingRole) await client.query("INSERT INTO stash_organization_memberships (organization_id, account_id, role) VALUES ($1, $2, $3)", [invitation.organization_id, accountId, role]);
        else if (existingRole !== role) await client.query("UPDATE stash_organization_memberships SET role = $3 WHERE organization_id = $1 AND account_id = $2", [invitation.organization_id, accountId, role]);
        await client.query("UPDATE stash_invitations SET accepted_at = $2, accepted_by_account_id = $3, token_lookup = NULL, token_secret = NULL WHERE id = $1", [invitation.id, acceptedAt, accountId]);
        return { status: "accepted", access: { kind: "member", organizationId: invitation.organization_id, role } };
      }
      const projects = await client.query<{ project_id: string; workspace_id: string }>(
        `SELECT selected.project_id, project.workspace_id FROM stash_invitation_projects selected
         JOIN stash_projects project ON project.id = selected.project_id WHERE selected.invitation_id = $1 ORDER BY selected.project_id`, [invitation.id]);
      const guest = await client.query<{ id: string; name: string }>("SELECT id, name FROM stash_accounts WHERE id = $1", [accountId]);
      if (!guest.rows[0]) throw new Error("guest_identity_unavailable");
      for (const { project_id } of projects.rows) {
        await client.query("INSERT INTO stash_project_guests (project_id, account_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [project_id, accountId]);
      }
      const inviter = await client.query<{ id: string; name: string }>(
        `SELECT account.id, account.name FROM stash_invitations invitation
         JOIN stash_accounts account ON account.id = invitation.invited_by_account_id WHERE invitation.id = $1`, [invitation.id]);
      if (!inviter.rows[0]) throw new Error("inviter_identity_unavailable");
      const projection = { schema: "stash.guest-project-access.v1" as const, id: invitation.id, organizationId: invitation.organization_id,
        guest: { localAccountId: guest.rows[0].id, displayName: guest.rows[0].name },
        projects: projects.rows.map(({ project_id, workspace_id }) => ({ projectId: project_id, workspaceId: workspace_id })),
        acceptedAt, invitedBy: { localAccountId: inviter.rows[0].id, displayName: inviter.rows[0].name } };
      await this.#recordPortableProjection(client, "GuestProjectAccess", invitation.id, projection.schema, projection);
      await client.query("UPDATE stash_invitations SET accepted_at = $2, accepted_by_account_id = $3, token_lookup = NULL, token_secret = NULL WHERE id = $1", [invitation.id, acceptedAt, accountId]);
      return { status: "accepted", access: { kind: "guest", organizationId: invitation.organization_id, projectIds: projects.rows.map(({ project_id }) => project_id) } };
    });
  }

  async readProject(accountId: string, projectId: string): Promise<ProjectAccessSummary | undefined> {
    const client = await this.#pool.connect();
    try {
      await this.#ensureInvitationSchema(client);
      const result = await client.query<{ id: string; organization_id: string; name: string; project_key: string; creator_id: string; creator_name: string }>(
        `SELECT project.id, workspace.organization_owner_id AS organization_id, project.name, project.project_key,
                creator.id AS creator_id, creator.name AS creator_name
         FROM stash_projects project JOIN stash_workspaces workspace ON workspace.id = project.workspace_id
         JOIN stash_accounts creator ON creator.id = project.created_by_account_id
         WHERE project.id = $1 AND (
           EXISTS (SELECT 1 FROM stash_organization_memberships membership WHERE membership.organization_id = workspace.organization_owner_id AND membership.account_id = $2)
           OR EXISTS (SELECT 1 FROM stash_project_guests guest WHERE guest.project_id = project.id AND guest.account_id = $2)
         )`, [projectId, accountId],
      );
      const row = result.rows[0];
      return row ? { id: row.id, organizationId: row.organization_id, name: row.name, key: row.project_key, createdBy: { localAccountId: row.creator_id, displayName: row.creator_name } } : undefined;
    } finally { client.release(); }
  }

  async canWriteProject(accountId: string, projectId: string): Promise<boolean> {
    const client = await this.#pool.connect();
    try {
      await this.#ensureInvitationSchema(client);
      const result = await client.query(
        `SELECT 1 FROM stash_projects project JOIN stash_workspaces workspace ON workspace.id = project.workspace_id
         JOIN stash_organization_memberships membership ON membership.organization_id = workspace.organization_owner_id
         WHERE project.id = $1 AND membership.account_id = $2`, [projectId, accountId],
      );
      return result.rowCount === 1;
    } finally { client.release(); }
  }

  async #lockedOrganizationMemberships(client: PoolClient, organizationId: string) {
    await this.#ensureBootstrapSchema(client);
    const memberships = await client.query<{ account_id: string; role: BuiltInOrganizationRole }>(
      `SELECT account_id, role FROM stash_organization_memberships
       WHERE organization_id = $1 FOR UPDATE`,
      [organizationId],
    );
    return memberships.rows;
  }

  #isOnlyOwner(
    memberships: ReadonlyArray<{ account_id: string; role: BuiltInOrganizationRole }>,
    accountId: string,
  ): boolean {
    return memberships.filter((membership) => membership.role === "Owner").length === 1
      && memberships.some(
        (membership) => membership.account_id === accountId && membership.role === "Owner",
      );
  }

  #roleRank(role: BuiltInOrganizationRole): number { return { Member: 0, Admin: 1, Owner: 2 }[role]; }

  #invitationTokenMatches(encryptedToken: string, candidate: string): boolean {
    try {
      const expected = Buffer.from(this.#authenticationSecrets.decrypt(encryptedToken, "invitation-v1"));
      const actual = Buffer.from(candidate);
      return expected.length === actual.length && timingSafeEqual(expected, actual);
    } catch { return false; }
  }

  #canManageRoles(
    memberships: ReadonlyArray<{ account_id: string; role: BuiltInOrganizationRole }>,
    accountId: string,
  ): boolean {
    return memberships.some(
      (membership) => membership.account_id === accountId && membership.role === "Owner",
    );
  }

  #canManageRepositoryConnections(
    memberships: ReadonlyArray<{ account_id: string; role: BuiltInOrganizationRole }>,
    accountId: string,
  ): boolean {
    return memberships.some((membership) => membership.account_id === accountId
      && (membership.role === "Owner" || membership.role === "Admin"));
  }

  async saveOidcConfiguration(configuration: OidcOrganizationConfiguration): Promise<void> {
    await this.#ensureOidcSchema();
    await this.#pool.query(`
      INSERT INTO stash_oidc_configurations (organization_id, issuer, client_id, client_secret)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (organization_id) DO UPDATE SET issuer = EXCLUDED.issuer, client_id = EXCLUDED.client_id, client_secret = EXCLUDED.client_secret
    `, [configuration.organizationId, configuration.issuer, configuration.clientId, this.#authenticationSecrets.encrypt(configuration.clientSecret)]);
  }

  async linkOidcIdentity(key: OidcIdentityKey, accountId: string): Promise<boolean> {
    await this.#ensureOidcSchema();
    const result = await this.#pool.query(`
      INSERT INTO stash_oidc_identities (organization_id, issuer, subject_lookup, subject_secret, account_id)
      SELECT $1, $3, $4, $5, account_id FROM stash_organization_memberships
      WHERE organization_id = $1 AND account_id = $2
      ON CONFLICT (organization_id, issuer, account_id) DO UPDATE
      SET subject_lookup = EXCLUDED.subject_lookup, subject_secret = EXCLUDED.subject_secret
    `, [key.organizationId, accountId, key.issuer, this.#oidcIdentityLookup(key), this.#authenticationSecrets.encrypt(key.subject)]);
    return result.rowCount === 1;
  }

  async findSessionByTokenHash(hash: string): Promise<SessionRecord | undefined> {
    await this.#ensureAuthSchema();
    const result = await this.#pool.query<SessionRow>(
      "SELECT * FROM stash_sessions WHERE token_lookup = $1", [this.#authenticationSecrets.blindIndex(hash)],
    );
    return result.rows[0] ? this.#sessionRecord(result.rows[0]) : undefined;
  }

  async listSessions(accountId: string): Promise<SessionRecord[]> {
    await this.#ensureAuthSchema();
    const result = await this.#pool.query<SessionRow>(
      "SELECT * FROM stash_sessions WHERE account_id = $1 ORDER BY created_at", [accountId],
    );
    return result.rows.map((row) => this.#sessionRecord(row));
  }

  async deleteSession(accountId: string, sessionId: string): Promise<boolean> {
    const result = await this.#pool.query("DELETE FROM stash_sessions WHERE account_id = $1 AND id = $2", [accountId, sessionId]);
    return result.rowCount === 1;
  }

  async changePasswordAndDeleteOtherSessions(
    accountId: string, currentSessionId: string, passwordHash: string,
  ): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "UPDATE stash_accounts SET password_hash = $2 WHERE id = $1",
        [accountId, this.#authenticationSecrets.encrypt(passwordHash)],
      );
      await client.query("DELETE FROM stash_sessions WHERE account_id = $1 AND id <> $2", [accountId, currentSessionId]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async savePasskey(record: PasskeyRecord): Promise<void> {
    await this.#ensureRecoverySchema();
    await this.#pool.query(
      "INSERT INTO stash_passkeys (credential_id, account_id, public_key, signature_counter, transports, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
      [record.credentialId, record.accountId, this.#authenticationSecrets.encrypt(record.publicKey), record.counter, record.transports ?? null, record.createdAt],
    );
  }

  async findPasskey(credentialId: string): Promise<PasskeyRecord | undefined> {
    await this.#ensureRecoverySchema();
    const result = await this.#pool.query<{ credential_id: string; account_id: string; public_key: string; signature_counter: number; transports: string[] | null; created_at: Date | string }>(
      "SELECT credential_id, account_id, public_key, signature_counter, transports, created_at FROM stash_passkeys WHERE credential_id = $1", [credentialId],
    );
    const row = result.rows[0];
    return row ? { credentialId: row.credential_id, accountId: row.account_id, publicKey: this.#authenticationSecrets.decrypt(row.public_key), counter: row.signature_counter, ...(row.transports ? { transports: row.transports } : {}), createdAt: new Date(row.created_at).toISOString() } : undefined;
  }

  async updatePasskeyCounterAndCreateSession(credentialId: string, previousCounter: number, newCounter: number, session: SessionRecord): Promise<boolean> {
    return this.#transaction(async (client) => {
      const result = await client.query("UPDATE stash_passkeys SET signature_counter = $3 WHERE credential_id = $1 AND signature_counter = $2", [credentialId, previousCounter, newCounter]);
      if (result.rowCount !== 1) return { commit: false, value: false };
      await this.#insertSession(client, session);
      return { commit: true, value: true };
    });
  }

  async replaceRecoveryCodes(accountId: string, records: RecoveryCodeRecord[]): Promise<void> {
    await this.#ensureRecoverySchema();
    await this.#transaction(async (client) => {
      await client.query("DELETE FROM stash_recovery_codes WHERE account_id = $1", [accountId]);
      for (const record of records) await client.query("INSERT INTO stash_recovery_codes (account_id, code_lookup, protected_secret) VALUES ($1, $2, $3)", [accountId, this.#authenticationSecrets.blindIndex(record.lookup), record.protectedSecret]);
      return { commit: true, value: undefined };
    });
  }

  async consumeRecoveryCodeAndCreateSession(accountId: string, lookup: string, session?: SessionRecord): Promise<boolean> {
    await this.#ensureRecoverySchema();
    return this.#transaction(async (client) => {
      const result = await client.query("DELETE FROM stash_recovery_codes WHERE account_id = $1 AND code_lookup = $2", [accountId, this.#authenticationSecrets.blindIndex(lookup)]);
      if (result.rowCount !== 1 || !session) return { commit: false, value: false };
      await this.#insertSession(client, session);
      return { commit: true, value: true };
    });
  }

  async enqueueEmailRecovery(job: EmailRecoveryDeliveryJob): Promise<void> {
    await this.#ensureRecoverySchema();
    await this.#transaction(async (client) => {
      await client.query("INSERT INTO stash_email_recovery_delivery_jobs (id, protected_delivery, created_at) VALUES ($1, $2, $3)", [job.id, job.protectedDelivery, job.createdAt]);
      return { commit: true, value: undefined };
    });
  }

  async findEmailRecoveryAccount(lookup: string, now: string): Promise<string | undefined> {
    await this.#ensureRecoverySchema();
    const result = await this.#pool.query<{ account_id: string }>("SELECT account_id FROM stash_email_recoveries WHERE token_lookup = $1 AND expires_at > $2", [this.#authenticationSecrets.blindIndex(lookup), now]);
    return result.rows[0]?.account_id;
  }

  async consumeEmailRecoveryAndCreateSession(lookup: string, now: string, session: SessionRecord): Promise<boolean> {
    return this.#transaction(async (client) => {
      const result = await client.query("DELETE FROM stash_email_recoveries WHERE token_lookup = $1 AND account_id = $2 AND expires_at > $3", [this.#authenticationSecrets.blindIndex(lookup), session.accountId, now]);
      if (result.rowCount !== 1) return { commit: false, value: false };
      await this.#insertSession(client, session);
      return { commit: true, value: true };
    });
  }

  async claimEmailRecoveryDelivery(owner: string, leaseUntil: string): Promise<ClaimedEmailRecoveryDelivery | undefined> {
    await this.#ensureRecoverySchema();
    return this.#transaction(async (client) => {
      const result = await client.query<{ id: string; protected_delivery: string; created_at: Date | string; claim_version: number }>("SELECT id, protected_delivery, created_at, claim_version FROM stash_email_recovery_delivery_jobs WHERE available_at <= NOW() AND (lease_until IS NULL OR lease_until <= NOW()) ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED");
      const row = result.rows[0];
      if (!row) return { commit: false, value: undefined };
      const claimVersion = Number(row.claim_version) + 1;
      await client.query("UPDATE stash_email_recovery_delivery_jobs SET claim_owner = $2, claim_version = $3, lease_until = $4 WHERE id = $1", [row.id, owner, claimVersion, leaseUntil]);
      return { commit: true, value: {
        job: { id: row.id, protectedDelivery: row.protected_delivery, createdAt: new Date(row.created_at).toISOString() },
        claim: { jobId: row.id, owner, version: claimVersion },
      } };
    });
  }
  async renewEmailRecoveryDelivery(claim: EmailRecoveryDeliveryClaim, leaseUntil: string): Promise<boolean> {
    const result = await this.#pool.query("UPDATE stash_email_recovery_delivery_jobs SET lease_until = $4 WHERE id = $1 AND claim_owner = $2 AND claim_version = $3", [claim.jobId, claim.owner, claim.version, leaseUntil]);
    return result.rowCount === 1;
  }
  async completeEmailRecoveryDelivery(claim: EmailRecoveryDeliveryClaim, activation?: EmailRecoveryRecord): Promise<boolean> {
    return this.#transaction(async (client) => {
      const deleted = await client.query("DELETE FROM stash_email_recovery_delivery_jobs WHERE id = $1 AND claim_owner = $2 AND claim_version = $3", [claim.jobId, claim.owner, claim.version]);
      if (deleted.rowCount !== 1) return { commit: false, value: false };
      if (activation) await client.query("INSERT INTO stash_email_recoveries (token_lookup, account_id, protected_secret, expires_at) VALUES ($1, $2, $3, $4)", [this.#authenticationSecrets.blindIndex(activation.tokenLookup), activation.accountId, activation.protectedSecret, activation.expiresAt]);
      return { commit: true, value: true };
    });
  }
  async retryEmailRecoveryDelivery(claim: EmailRecoveryDeliveryClaim, reason: string): Promise<boolean> {
    const result = await this.#pool.query("UPDATE stash_email_recovery_delivery_jobs SET attempts = attempts + 1, last_error = $4, available_at = NOW() + INTERVAL '1 minute', claim_owner = NULL, lease_until = NULL WHERE id = $1 AND claim_owner = $2 AND claim_version = $3", [claim.jobId, claim.owner, claim.version, reason.slice(0, 500)]);
    return result.rowCount === 1;
  }

  async #insertSession(client: PoolClient, session: SessionRecord): Promise<void> {
    await client.query(
      "INSERT INTO stash_sessions (id, account_id, token_lookup, token_hash, created_at, last_seen_at, user_agent) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [session.id, session.accountId, this.#authenticationSecrets.blindIndex(session.tokenHash), this.#authenticationSecrets.encrypt(session.tokenHash), session.createdAt, session.lastSeenAt, session.userAgent ?? null],
    );
  }

  async #transaction<T>(work: (client: PoolClient) => Promise<{ commit: boolean; value: T }>): Promise<T> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query(result.commit ? "COMMIT" : "ROLLBACK");
      return result.value;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async #ensureAuthSchema(): Promise<void> {
    await this.#pool.query(`
      CREATE TABLE IF NOT EXISTS stash_sessions (
        id UUID PRIMARY KEY,
        account_id UUID NOT NULL REFERENCES stash_accounts(id) ON DELETE CASCADE,
        token_lookup TEXT NOT NULL UNIQUE,
        token_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        last_seen_at TIMESTAMPTZ NOT NULL,
        user_agent TEXT
      )
    `);
  }

  async #ensureOidcSchema(): Promise<void> {
    await this.#pool.query(`
      CREATE TABLE IF NOT EXISTS stash_oidc_configurations (
        organization_id UUID PRIMARY KEY REFERENCES stash_organizations(id) ON DELETE CASCADE,
        issuer TEXT NOT NULL,
        client_id TEXT NOT NULL,
        client_secret TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS stash_oidc_identities (
        organization_id UUID NOT NULL REFERENCES stash_organizations(id) ON DELETE CASCADE,
        issuer TEXT NOT NULL,
        subject_lookup TEXT NOT NULL,
        subject_secret TEXT NOT NULL,
        account_id UUID NOT NULL REFERENCES stash_accounts(id) ON DELETE CASCADE,
        PRIMARY KEY (organization_id, issuer, subject_lookup),
        UNIQUE (organization_id, issuer, account_id)
      )
    `);
  }

  #oidcIdentityLookup(key: OidcIdentityKey): string {
    return this.#authenticationSecrets.blindIndex(
      `oidc-identity-v1:${JSON.stringify([key.organizationId, key.issuer, key.subject])}`,
    );
  }

  async #ensureRecoverySchema(): Promise<void> {
    await this.#ensureAuthSchema();
    await this.#pool.query(`
      CREATE TABLE IF NOT EXISTS stash_passkeys (
        credential_id TEXT PRIMARY KEY,
        account_id UUID NOT NULL REFERENCES stash_accounts(id) ON DELETE CASCADE,
        public_key TEXT NOT NULL,
        signature_counter BIGINT NOT NULL,
        transports TEXT[],
        created_at TIMESTAMPTZ NOT NULL
      );
      CREATE TABLE IF NOT EXISTS stash_recovery_codes (
        account_id UUID NOT NULL REFERENCES stash_accounts(id) ON DELETE CASCADE,
        code_lookup TEXT NOT NULL,
        protected_secret TEXT NOT NULL,
        PRIMARY KEY (account_id, code_lookup)
      );
      CREATE TABLE IF NOT EXISTS stash_email_recoveries (
        token_lookup TEXT PRIMARY KEY,
        account_id UUID NOT NULL REFERENCES stash_accounts(id) ON DELETE CASCADE,
        protected_secret TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL
      );
      CREATE TABLE IF NOT EXISTS stash_email_recovery_delivery_jobs (
        id UUID PRIMARY KEY,
        protected_delivery TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        claim_owner UUID,
        claim_version BIGINT NOT NULL DEFAULT 0,
        lease_until TIMESTAMPTZ
      );
    `);
  }
  async #verifyAuthenticationKey(): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS stash_authentication_key_check (
          singleton BOOLEAN PRIMARY KEY CHECK (singleton),
          encrypted_check TEXT NOT NULL
        )
      `);
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [authenticationKeyCheckLockId]);
      const result = await client.query<{ encrypted_check: string }>(
        "SELECT encrypted_check FROM stash_authentication_key_check WHERE singleton = TRUE",
      );
      const existing = result.rows[0];
      if (existing) {
        verifyAuthenticationKeyCheck(this.#authenticationSecrets, existing.encrypted_check);
      } else {
        await client.query(
          "INSERT INTO stash_authentication_key_check (singleton, encrypted_check) VALUES (TRUE, $1)",
          [createAuthenticationKeyCheck(this.#authenticationSecrets)],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  #accountRecord(row: AccountRow): AccountAuthenticationRecord {
    return {
      id: row.id,
      name: row.name,
      email: row.email,
      passwordHash: this.#authenticationSecrets.decrypt(row.password_hash),
    };
  }

  #sessionRecord(row: SessionRow): SessionRecord {
    return {
      id: row.id,
      accountId: row.account_id,
      tokenHash: this.#authenticationSecrets.decrypt(row.token_hash),
      createdAt: new Date(row.created_at).toISOString(),
      lastSeenAt: new Date(row.last_seen_at).toISOString(),
      ...(row.user_agent ? { userAgent: row.user_agent } : {}),
    };
  }

  async #ensureBootstrapSchema(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE IF NOT EXISTS stash_organizations (
        id UUID PRIMARY KEY,
        name TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS stash_accounts (
        id UUID PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS stash_organization_memberships (
        organization_id UUID NOT NULL REFERENCES stash_organizations(id),
        account_id UUID NOT NULL REFERENCES stash_accounts(id),
        role TEXT NOT NULL CHECK (role IN ('Owner', 'Admin', 'Member')),
        PRIMARY KEY (organization_id, account_id)
      );
      CREATE TABLE IF NOT EXISTS stash_instance_bootstrap (
        singleton BOOLEAN PRIMARY KEY CHECK (singleton)
      );
    `);
  }

  async #ensureRepositoryConnectionSchema(): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await this.#ensureWorkspaceProjectSchema(client);
      await client.query(`
        CREATE TABLE IF NOT EXISTS stash_repository_connections (
          id UUID PRIMARY KEY,
          organization_id UUID NOT NULL REFERENCES stash_organizations(id),
          provider TEXT NOT NULL CHECK (provider = 'github'),
          installation_id BIGINT NOT NULL CHECK (installation_id > 0),
          repository_id TEXT NOT NULL CHECK (length(repository_id) > 0),
          repository_url TEXT NOT NULL CHECK (length(repository_url) > 0),
          created_by_account_id UUID NOT NULL REFERENCES stash_accounts(id),
          created_by_attribution TEXT NOT NULL CONSTRAINT stash_repository_connections_creator_attribution_check CHECK (created_by_attribution IN ('recorded', 'inferred-during-upgrade')),
          UNIQUE (organization_id, repository_id)
        );
        CREATE TABLE IF NOT EXISTS stash_repository_connection_projects (
          connection_id UUID NOT NULL REFERENCES stash_repository_connections(id),
          project_id UUID NOT NULL REFERENCES stash_projects(id),
          PRIMARY KEY (connection_id, project_id)
        )
      `);
      await client.query("SELECT pg_advisory_lock(1094218495)");
      await client.query("BEGIN");
      try {
        await client.query(`
          ALTER TABLE stash_repository_connections ADD COLUMN IF NOT EXISTS created_by_account_id UUID REFERENCES stash_accounts(id);
          ALTER TABLE stash_repository_connections ADD COLUMN IF NOT EXISTS created_by_attribution TEXT NOT NULL DEFAULT 'inferred-during-upgrade';
          UPDATE stash_repository_connections connection
          SET created_by_account_id = (
            SELECT candidate.account_id
            FROM stash_organization_memberships candidate
            WHERE candidate.organization_id = connection.organization_id AND candidate.role IN ('Owner', 'Admin')
            ORDER BY CASE candidate.role WHEN 'Owner' THEN 0 ELSE 1 END, candidate.account_id
            LIMIT 1
          )
          WHERE connection.created_by_account_id IS NULL;
          DO $creator$
          BEGIN
            IF EXISTS (SELECT 1 FROM stash_repository_connections WHERE created_by_account_id IS NULL) THEN
              RAISE EXCEPTION 'Cannot attribute an upgraded Repository Connection without an Organization Owner or Admin';
            END IF;
          END
          $creator$;
          ALTER TABLE stash_repository_connections ALTER COLUMN created_by_account_id SET NOT NULL;
          DO $attribution$
          BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stash_repository_connections_creator_attribution_check') THEN
              ALTER TABLE stash_repository_connections ADD CONSTRAINT stash_repository_connections_creator_attribution_check
                CHECK (created_by_attribution IN ('recorded', 'inferred-during-upgrade'));
            END IF;
          END
          $attribution$;
        `);
        await client.query(`
          INSERT INTO stash_portable_projection_outbox
            (object_kind, object_id, revision, projection_schema, payload)
          SELECT 'RepositoryConnection', connection.id, 1, 'stash.repository-connection.v1',
            jsonb_build_object(
              'schema', 'stash.repository-connection.v1',
              'id', connection.id,
              'provider', 'github',
              'repositoryUrl', connection.repository_url,
              'organization', jsonb_build_object('localOrganizationId', organization.id, 'displayName', organization.name),
              'createdBy', jsonb_build_object('localAccountId', creator.id, 'displayName', creator.name, 'attribution', connection.created_by_attribution),
              'projectIds', to_jsonb(ARRAY(
                SELECT link.project_id FROM stash_repository_connection_projects link
                WHERE link.connection_id = connection.id ORDER BY link.project_id
              ))
            )
          FROM stash_repository_connections connection
          JOIN stash_organizations organization ON organization.id = connection.organization_id
          JOIN stash_accounts creator ON creator.id = connection.created_by_account_id
          ON CONFLICT (object_kind, object_id, revision) DO NOTHING
        `);
        await client.query("ALTER TABLE stash_repository_connections DROP COLUMN IF EXISTS protected_credential");
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock(1094218495)").catch(() => undefined);
      client.release();
    }
  }

  async #ensureWorkspaceProjectSchema(client: PoolClient): Promise<void> {
    await this.#ensureBootstrapSchema(client);
    await client.query(`
      CREATE TABLE IF NOT EXISTS stash_workspaces (
        id UUID PRIMARY KEY,
        name TEXT NOT NULL,
        owner_type TEXT NOT NULL CHECK (owner_type IN ('personal', 'organization')),
        personal_owner_id UUID REFERENCES stash_accounts(id),
        organization_owner_id UUID REFERENCES stash_organizations(id),
        created_by_account_id UUID NOT NULL REFERENCES stash_accounts(id),
        CHECK (
          (owner_type = 'personal' AND personal_owner_id IS NOT NULL AND organization_owner_id IS NULL)
          OR
          (owner_type = 'organization' AND personal_owner_id IS NULL AND organization_owner_id IS NOT NULL)
        )
      );
      CREATE TABLE IF NOT EXISTS stash_projects (
        id UUID PRIMARY KEY,
        workspace_id UUID NOT NULL REFERENCES stash_workspaces(id),
        name TEXT NOT NULL,
        project_key TEXT NOT NULL,
        created_by_account_id UUID NOT NULL REFERENCES stash_accounts(id),
        next_task_number INTEGER NOT NULL DEFAULT 1 CHECK (next_task_number > 0),
        UNIQUE (workspace_id, project_key)
      );
      ALTER TABLE stash_projects ADD COLUMN IF NOT EXISTS next_task_number INTEGER NOT NULL DEFAULT 1 CHECK (next_task_number > 0);
    `);
    await this.#ensurePortableProjectionSchema(client);
  }

  async #ensureNoteSchema(client: PoolClient): Promise<void> {
    await this.#ensureWorkspaceProjectSchema(client);
    await client.query(`
      CREATE TABLE IF NOT EXISTS stash_notes (
        id UUID PRIMARY KEY,
        workspace_id UUID NOT NULL REFERENCES stash_workspaces(id),
        project_id UUID REFERENCES stash_projects(id),
        content TEXT NOT NULL CHECK (length(content) > 0),
        document JSONB NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
        tags JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(tags) = 'array'),
        reminder_at TIMESTAMPTZ,
        created_by_account_id UUID NOT NULL REFERENCES stash_accounts(id),
        created_at TIMESTAMPTZ NOT NULL,
        archived_at TIMESTAMPTZ
      );
      ALTER TABLE stash_notes ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
      CREATE TABLE IF NOT EXISTS stash_note_links (
        id UUID PRIMARY KEY, workspace_id UUID NOT NULL REFERENCES stash_workspaces(id),
        source_note_id UUID NOT NULL REFERENCES stash_notes(id), target_note_id UUID NOT NULL REFERENCES stash_notes(id),
        UNIQUE (source_note_id, target_note_id)
      );
      CREATE TABLE IF NOT EXISTS stash_workflow_statuses (
        id UUID PRIMARY KEY, project_id UUID NOT NULL REFERENCES stash_projects(id), name TEXT NOT NULL,
        category TEXT NOT NULL CHECK (category IN ('unstarted', 'started', 'completed')), position INTEGER NOT NULL,
        UNIQUE (project_id, name), UNIQUE (project_id, position)
      );
      CREATE TABLE IF NOT EXISTS stash_tasks (
        id UUID PRIMARY KEY, workspace_id UUID NOT NULL REFERENCES stash_workspaces(id), project_id UUID NOT NULL REFERENCES stash_projects(id),
        task_key TEXT NOT NULL, workflow_status_id UUID NOT NULL REFERENCES stash_workflow_statuses(id),
        title TEXT NOT NULL CHECK (length(title) > 0), created_by_account_id UUID NOT NULL REFERENCES stash_accounts(id), created_at TIMESTAMPTZ NOT NULL,
        UNIQUE (project_id, task_key)
      );
      CREATE TABLE IF NOT EXISTS stash_task_note_sources (
        task_id UUID NOT NULL REFERENCES stash_tasks(id), note_id UUID NOT NULL REFERENCES stash_notes(id), PRIMARY KEY (task_id, note_id)
      );
      CREATE TABLE IF NOT EXISTS stash_task_block_sources (
        task_id UUID NOT NULL REFERENCES stash_tasks(id), note_id UUID NOT NULL REFERENCES stash_notes(id), block_id UUID NOT NULL,
        PRIMARY KEY (task_id, note_id, block_id)
      )
    `);
    await client.query("ALTER TABLE stash_notes ADD COLUMN IF NOT EXISTS document JSONB");
    await client.query("ALTER TABLE stash_notes ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0)");
    await client.query("UPDATE stash_notes SET document = jsonb_build_object('type', 'doc', 'blocks', jsonb_build_array(jsonb_build_object('type', 'paragraph', 'content', jsonb_build_array(jsonb_build_object('text', content))))) WHERE document IS NULL");
    await client.query("ALTER TABLE stash_notes ALTER COLUMN document SET NOT NULL");
    await client.query(`UPDATE stash_notes SET document = jsonb_set(document, '{blocks}', (
      SELECT jsonb_agg(CASE WHEN block ? 'blockKey' THEN block ELSE block || jsonb_build_object('blockKey', gen_random_uuid()) END)
      FROM jsonb_array_elements(document->'blocks') block))
      WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(document->'blocks') block WHERE NOT block ? 'blockKey')`);
    await client.query(`CREATE TABLE IF NOT EXISTS stash_note_operations (
      note_id UUID NOT NULL REFERENCES stash_notes(id) ON DELETE CASCADE,
      operation_id UUID NOT NULL,
      base_revision INTEGER NOT NULL CHECK (base_revision > 0),
      applied_revision INTEGER NOT NULL CHECK (applied_revision > 0),
      block_key UUID NOT NULL,
      operation_digest TEXT,
      PRIMARY KEY (note_id, operation_id)
    )`);
    await client.query("ALTER TABLE stash_note_operations ADD COLUMN IF NOT EXISTS operation_digest TEXT");
    await client.query(`CREATE TABLE IF NOT EXISTS stash_note_acknowledged_operations (
      note_id UUID NOT NULL REFERENCES stash_notes(id) ON DELETE CASCADE,
      operation_id UUID NOT NULL,
      operation_digest TEXT NOT NULL,
      PRIMARY KEY (note_id, operation_id)
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS stash_note_edit_conflicts (
      id UUID PRIMARY KEY,
      note_id UUID NOT NULL REFERENCES stash_notes(id) ON DELETE CASCADE,
      base_revision INTEGER NOT NULL CHECK (base_revision > 0),
      document JSONB NOT NULL,
      markdown TEXT NOT NULL,
      operations JSONB,
      created_by_account_id UUID NOT NULL REFERENCES stash_accounts(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      resolved_at TIMESTAMPTZ,
      resolution TEXT CHECK (resolution IN ('keep_current', 'apply_contribution')),
      resolved_by_account_id UUID REFERENCES stash_accounts(id),
      kind TEXT NOT NULL DEFAULT 'concurrent_edit' CHECK (kind IN ('concurrent_edit', 'invalid_operation_id'))
    )`);
    await client.query("ALTER TABLE stash_note_edit_conflicts ADD COLUMN IF NOT EXISTS operations JSONB");
    await client.query("ALTER TABLE stash_note_edit_conflicts ADD COLUMN IF NOT EXISTS resolution TEXT CHECK (resolution IN ('keep_current', 'apply_contribution'))");
    await client.query("ALTER TABLE stash_note_edit_conflicts ADD COLUMN IF NOT EXISTS resolved_by_account_id UUID REFERENCES stash_accounts(id)");
    await client.query("ALTER TABLE stash_note_edit_conflicts ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'concurrent_edit' CHECK (kind IN ('concurrent_edit', 'invalid_operation_id'))");
    await client.query(`CREATE TABLE IF NOT EXISTS stash_note_conflict_operations (
      note_id UUID NOT NULL REFERENCES stash_notes(id) ON DELETE CASCADE,
      operation_id UUID NOT NULL,
      conflict_id UUID NOT NULL REFERENCES stash_note_edit_conflicts(id) ON DELETE CASCADE,
      operation_digest TEXT,
      PRIMARY KEY (note_id, operation_id)
    )`);
    await client.query("ALTER TABLE stash_note_conflict_operations ADD COLUMN IF NOT EXISTS operation_digest TEXT");
  }

  async #ensureNoteSchemaForPool(): Promise<void> {
    const client = await this.#pool.connect();
    try { await this.#ensureNoteSchema(client); } finally { client.release(); }
  }

  async #ensureAttachmentSchema(client: PoolClient): Promise<void> {
    await this.#ensureWorkspaceProjectSchema(client);
    await client.query(`CREATE TABLE IF NOT EXISTS stash_attachments (id UUID PRIMARY KEY, workspace_id UUID NOT NULL REFERENCES stash_workspaces(id), filename TEXT NOT NULL, content_type TEXT NOT NULL, byte_size BIGINT NOT NULL CHECK (byte_size > 0), relative_path TEXT NOT NULL, storage_key TEXT NOT NULL UNIQUE, source TEXT NOT NULL CHECK (source IN ('upload','paste')), created_by_account_id UUID NOT NULL REFERENCES stash_accounts(id), created_at TIMESTAMPTZ NOT NULL)`);
  }

  async #ensureMemberLocalizationSchema(): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await this.#ensureBootstrapSchema(client);
      await client.query(`
        CREATE TABLE IF NOT EXISTS stash_member_localization_preferences (
          account_id UUID PRIMARY KEY REFERENCES stash_accounts(id) ON DELETE CASCADE,
          locale TEXT NOT NULL,
          time_zone TEXT NOT NULL,
          date_format TEXT NOT NULL CHECK (date_format IN ('short', 'medium', 'long')),
          week_starts_on TEXT NOT NULL CHECK (week_starts_on IN ('sunday', 'monday', 'saturday')),
          updated_at TIMESTAMPTZ NOT NULL
        )
      `);
    } finally {
      client.release();
    }
  }

  async #ensureInvitationSchema(client: PoolClient): Promise<void> {
    await this.#ensureWorkspaceProjectSchema(client);
    await client.query(`
      CREATE TABLE IF NOT EXISTS stash_invitations (
        id UUID PRIMARY KEY,
        organization_id UUID NOT NULL REFERENCES stash_organizations(id),
        token_lookup TEXT UNIQUE,
        token_secret TEXT,
        kind TEXT NOT NULL CHECK (kind IN ('member', 'guest')),
        member_role TEXT CHECK (member_role IN ('Owner', 'Admin', 'Member')),
        invited_by_account_id UUID NOT NULL REFERENCES stash_accounts(id),
        expires_at TIMESTAMPTZ NOT NULL,
        accepted_at TIMESTAMPTZ,
        accepted_by_account_id UUID REFERENCES stash_accounts(id),
        CHECK ((token_lookup IS NULL) = (token_secret IS NULL)),
        CHECK ((kind = 'member' AND member_role IS NOT NULL) OR (kind = 'guest' AND member_role IS NULL))
      );
      CREATE TABLE IF NOT EXISTS stash_invitation_projects (
        invitation_id UUID NOT NULL REFERENCES stash_invitations(id) ON DELETE CASCADE,
        project_id UUID NOT NULL REFERENCES stash_projects(id),
        PRIMARY KEY (invitation_id, project_id)
      );
      CREATE TABLE IF NOT EXISTS stash_project_guests (
        project_id UUID NOT NULL REFERENCES stash_projects(id),
        account_id UUID NOT NULL REFERENCES stash_accounts(id),
        PRIMARY KEY (project_id, account_id)
      );
    `);
    await client.query("SELECT pg_advisory_xact_lock(1465271063)");
    await client.query(`
      ALTER TABLE stash_invitations ADD COLUMN IF NOT EXISTS token_lookup TEXT;
      ALTER TABLE stash_invitations ADD COLUMN IF NOT EXISTS token_secret TEXT;
      DO $migration$
      BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'stash_invitations' AND column_name = 'token_hash') THEN
          DELETE FROM stash_invitations WHERE token_lookup IS NULL OR token_secret IS NULL;
          ALTER TABLE stash_invitations DROP COLUMN token_hash;
        END IF;
      END
      $migration$;
    `);
  }

  async #ensurePortableProjectionSchema(client: PoolClient): Promise<void> {
    await client.query("SELECT pg_advisory_lock(1094218495)");
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS stash_portable_projection_outbox (
          object_kind TEXT NOT NULL CONSTRAINT stash_portable_projection_outbox_object_kind_check CHECK (object_kind IN (${portableProjectionObjectKindSql})),
          object_id UUID NOT NULL,
          revision INTEGER NOT NULL CHECK (revision > 0),
          projection_schema TEXT NOT NULL,
          payload JSONB NOT NULL,
          state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'projected')),
          created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (object_kind, object_id, revision)
        );
        DO $portable_projection$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conrelid = 'stash_portable_projection_outbox'::regclass
              AND conname = 'stash_portable_projection_outbox_object_kind_check'
              AND (${portableProjectionObjectKinds.map((kind) => `pg_get_constraintdef(oid) NOT LIKE '%${kind}%'`).join(" OR ")})
          ) THEN
            ALTER TABLE stash_portable_projection_outbox DROP CONSTRAINT stash_portable_projection_outbox_object_kind_check;
            ALTER TABLE stash_portable_projection_outbox ADD CONSTRAINT stash_portable_projection_outbox_object_kind_check
              CHECK (object_kind IN (${portableProjectionObjectKindSql}));
          END IF;
        END
        $portable_projection$;
      `);
    } finally {
      await client.query("SELECT pg_advisory_unlock(1094218495)").catch(() => undefined);
    }
  }

  async #recordPortableProjection(
    client: PoolClient,
    objectKind: "Workspace" | "Project" | "Note" | "NoteLink" | "Task" | "GuestProjectAccess" | "RepositoryConnection" | "Attachment",
    objectId: string,
    projectionSchema: "stash.workspace.v1" | "stash.project.v1" | "stash.note.v1" | "stash.note.v2" | "stash.note-link.v1" | "stash.task.v1" | "stash.guest-project-access.v1" | "stash.repository-connection.v1" | "stash.attachment.v1",
    payload: object,
  ): Promise<void> {
    await client.query(
      `INSERT INTO stash_portable_projection_outbox
        (object_kind, object_id, revision, projection_schema, payload)
       SELECT $1, $2, COALESCE(MAX(revision), 0) + 1, $3, $4::jsonb
       FROM stash_portable_projection_outbox WHERE object_kind = $1 AND object_id = $2`,
      [objectKind, objectId, projectionSchema, JSON.stringify(payload)],
    );
  }

  async #recordRepositoryConnectionProjection(client: PoolClient, record: RepositoryConnectionRecord, revision: number): Promise<void> {
    const identities = await client.query<{ organization_name: string; account_name: string }>(
      `SELECT organization.name AS organization_name, account.name AS account_name
       FROM stash_organizations organization CROSS JOIN stash_accounts account
       WHERE organization.id = $1 AND account.id = $2`,
      [record.organizationId, record.createdByMemberId],
    );
    const identity = identities.rows[0];
    if (!identity) throw new Error("Repository Connection projection identity is unavailable");
    const projection: PortableRepositoryConnectionProjection = {
      schema: "stash.repository-connection.v1",
      id: record.id,
      provider: "github",
      repositoryUrl: record.repositoryUrl,
      organization: { localOrganizationId: record.organizationId, displayName: identity.organization_name },
      createdBy: { localAccountId: record.createdByMemberId, displayName: identity.account_name, attribution: record.createdByAttribution },
      projectIds: record.projectIds,
    };
    await client.query(
      `INSERT INTO stash_portable_projection_outbox (object_kind, object_id, revision, projection_schema, payload)
       VALUES ('RepositoryConnection', $1, $2, 'stash.repository-connection.v1', $3::jsonb)`,
      [record.id, revision, JSON.stringify(projection)],
    );
  }

  async #withTransaction<Result>(operation: (client: PoolClient) => Promise<Result>): Promise<Result> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

interface AccountRow { id: string; name: string; email: string; password_hash: string }
interface SessionRow { id: string; account_id: string; token_hash: string; created_at: Date | string; last_seen_at: Date | string; user_agent: string | null }
interface OidcIdentityRow { id: string; name: string; email: string; subject_secret: string }
interface OidcConfigurationRow { organization_id: string; issuer: string; client_id: string; client_secret: string }
interface MemberLocalizationRow {
  locale: string;
  time_zone: string;
  date_format: MemberLocalizationPreferences["dateFormat"];
  week_starts_on: MemberLocalizationPreferences["weekStartsOn"];
  updated_at: Date | string;
}
interface RepositoryConnectionRow { id: string; organization_id: string; provider: "github"; installation_id: string | number; repository_id: string; repository_url: string; created_by_account_id: string; created_by_attribution: "recorded" | "inferred-during-upgrade"; project_ids: string[] }
interface AttachmentRow { id: string; workspace_id: string; filename: string; content_type: string; byte_size: string | number; relative_path: string; storage_key: string; source: "upload" | "paste"; created_by_account_id: string; created_at: Date | string }
function repositoryConnectionRecord(row: RepositoryConnectionRow): RepositoryConnectionRecord {
  return { id: row.id, organizationId: row.organization_id, provider: row.provider, installationId: Number(row.installation_id), repositoryId: row.repository_id, repositoryUrl: row.repository_url, createdByMemberId: row.created_by_account_id, createdByAttribution: row.created_by_attribution, projectIds: row.project_ids };
}

function triageObjectKind(result: NoteTriageResult): "Task" | "NoteLink" | "Note" {
  if (result.kind === "task_created") return "Task";
  if (result.kind === "linked") return "NoteLink";
  return "Note";
}

function triageObjectId(result: NoteTriageResult, noteId: string): string {
  if (result.kind === "task_created") return result.task.id;
  if (result.kind === "linked") return result.link.id;
  return noteId;
}

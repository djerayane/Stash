import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { Pool, type PoolClient } from "pg";

import type { DatabaseProbe } from "./instance.js";
import { noteOperationDigest, type NoteConflictResolution, type NoteEditBatch, type NoteEditConflict, type NoteRecord, type NoteRepository, type NoteTriageChange, type NoteTriageResult, type PortableNoteLinkProjection, type PortableNoteProjection, type PortableTaskProjection, type TaskCreation } from "./notes.js";
import { isRichTextDocument, markdownToRichText, paragraphDocument, richTextToMarkdown } from "./rich-text.js";
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
import { taskEditDigest, type CreateTaskFromBlockDraft, type LinkedTaskReadModel, type StructuredTaskEditRepository, type TaskEditBatch, type TaskEditConflict, type TaskFromBlockRepository, type TaskMoveActivity, type TaskMoveRepository, type TaskPlanningReadModel, type TaskPlanningRepository, type TaskPlanningUpdate, type TaskSourceBlockReference } from "./tasks.js";
import type { AttachmentRecord, AttachmentRepository, PortableAttachmentProjection } from "./attachments.js";
import type { MobileCaptureRepository } from "./mobile-captures.js";
import type { CreateDiscussionWorkDraft, DiscussionDraft, DiscussionMessage, DiscussionRecord, DiscussionRepository, DiscussionTarget, DiscussionWorkActivity, DiscussionWorkOutcome, PortableDiscussionProjection, PortableDiscussionTarget, PortableDiscussionWorkLinkProjection } from "./discussions.js";
import { initialWorkflowStatus, type ProjectWorkflow, type ProjectWorkflowRepository, type WorkflowStatus } from "./project-workflows.js";
import type { PortableWorkspaceExportRepository, PortableWorkspaceExportSnapshot } from "./portable-workspace-export.js";
import type { ImportTransformation, PortableWorkspaceImportBundle, PortableWorkspaceImportReport, PortableWorkspaceImportRepository } from "./portable-workspace-import.js";
import type { Board, BoardRepository, BoardTask } from "./boards.js";
import type { NoteLinkRecord, NoteLocationRecord, PortableNoteLinkStateProjection, PortableNoteLocationProjection } from "./note-links.js";
import type { ActivityCause, ActivityRecord, ActivityRepository, NoteHistoryRevision } from "./activity.js";
import type { DevelopmentArtifact, GitHubArtifactRepository } from "./github-artifacts.js";
import type { GitHubSignal, GitHubSignalRepository, SignalCandidate } from "./github-signals.js";
import { assignmentNotificationInputs, directMentionMemberIds, directMentionNotificationInputs, notificationDeliveryMode, type NotificationDelivery, type NotificationPreferences, type NotificationRepository } from "./notifications.js";
import type { AutomationCandidate, AutomationFailureNotification, AutomationRecipe, AutomationRepository, AutomationState, AutomationTransition, AutomationTrigger } from "./automations.js";
import * as Y from "yjs";
import { prosemirrorJSONToYDoc, yDocToProsemirrorJSON } from "y-prosemirror";
import { Schema } from "prosemirror-model";
import { InvalidCollaborationUpdate, type CollaborationSnapshot, type NoteCollaborationRepository } from "./note-collaboration.js";
import { proseMirrorToRichText, richTextToProseMirror } from "@stash/rich-text";

// First 31 bits of SHA-256("stash:authentication-key-check:v1"); reserved in Stash's
// PostgreSQL advisory-lock ID domain for serializing only the authentication key-check transaction.
const authenticationKeyCheckLockId = 795_541_992;
interface FailedAutomationRun {
  automationId: string;
  configuringMemberId: string;
  configuringMemberName: string;
  workspaceId: string;
  projectId: string;
  taskId: string;
  taskKey: string;
  taskTitle: string;
}
const portableProjectionObjectKinds = ["Workspace", "Project", "Workflow", "Board", "Note", "NoteLocation", "NoteLink", "Task", "GuestProjectAccess", "RepositoryConnection", "Attachment", "Discussion", "DiscussionWorkLink", "Activity"] as const;
const portableProjectionObjectKindSql = portableProjectionObjectKinds.map((kind) => `'${kind}'`).join(", ");
export const workflowTemporaryRenameSql = `UPDATE stash_workflow_statuses
  SET position = -position - 1, name = repeat('__stash_workflow_transition__', 4) || id::text
  WHERE project_id = $1`;
const repositoryConnectionSelect = `SELECT connection.id, connection.organization_id, connection.provider, connection.installation_id,
  connection.repository_id, connection.repository_url, connection.created_by_account_id, connection.created_by_attribution,
  connection.ownership, connection.state,
  ARRAY(SELECT project_id FROM stash_repository_connection_projects link WHERE link.connection_id = connection.id ORDER BY project_id) AS project_ids
  FROM stash_repository_connections connection`;
const taskPlanningSelect = `SELECT task.*, status.name AS status_name, status.category AS status_category,
  creator.name AS created_by_name,
  ARRAY(SELECT source.note_id FROM stash_task_note_sources source WHERE source.task_id = task.id ORDER BY source.note_id) AS source_note_ids,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('noteId', source.note_id, 'blockId', source.block_id) ORDER BY source.note_id, source.block_id)
    FROM stash_task_block_sources source WHERE source.task_id = task.id), '[]'::jsonb) AS source_blocks,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('projectId', alias.project_id, 'key', alias.task_key) ORDER BY alias.created_at)
    FROM stash_task_key_aliases alias WHERE alias.task_id = task.id), '[]'::jsonb) AS key_aliases
  , COALESCE((SELECT jsonb_agg(relation ORDER BY relation->>'taskId', relation->>'type') FROM (
      SELECT jsonb_build_object('taskId', edge.prerequisite_task_id, 'type', 'depends_on') AS relation
      FROM stash_task_dependencies edge WHERE edge.dependent_task_id = task.id
      UNION ALL
      SELECT jsonb_build_object('taskId', edge.dependent_task_id, 'type', 'required_by') AS relation
      FROM stash_task_dependencies edge WHERE edge.prerequisite_task_id = task.id
    ) visible_dependencies), '[]'::jsonb) AS dependencies
  , COALESCE((SELECT jsonb_agg(jsonb_build_object('code', 'incomplete_dependency', 'taskId', prerequisite.id)
      ORDER BY prerequisite.id)
      FROM stash_task_dependencies edge
      JOIN stash_tasks prerequisite ON prerequisite.id = edge.prerequisite_task_id
      JOIN stash_workflow_statuses prerequisite_status ON prerequisite_status.id = prerequisite.workflow_status_id
      WHERE edge.dependent_task_id = task.id AND prerequisite_status.category <> 'completed'), '[]'::jsonb) AS dependency_warnings
  FROM stash_tasks task
  JOIN stash_workflow_statuses status ON status.id = task.workflow_status_id
  JOIN stash_accounts creator ON creator.id = task.created_by_account_id
  JOIN stash_workspaces workspace ON workspace.id = task.workspace_id
  WHERE (task.project_id = $1 AND task.task_key = $2 OR EXISTS (SELECT 1 FROM stash_task_key_aliases alias
      WHERE alias.task_id = task.id AND alias.project_id = $1 AND alias.task_key = $2))
    AND ((workspace.owner_type = 'personal' AND workspace.personal_owner_id = $3)
      OR (workspace.owner_type = 'organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
        WHERE membership.organization_id = workspace.organization_owner_id AND membership.account_id = $3))
      OR EXISTS (SELECT 1 FROM stash_project_guests guest WHERE guest.project_id = task.project_id AND guest.account_id = $3))`;
const taskPlanningSelectById = taskPlanningSelect
  .replace("(task.project_id = $1 AND task.task_key = $2 OR EXISTS (SELECT 1 FROM stash_task_key_aliases alias\n      WHERE alias.task_id = task.id AND alias.project_id = $1 AND alias.task_key = $2))", "task.id = $1")
  .replaceAll("$3", "$2");

function taskProjectionFromRow(row: any): PortableTaskProjection {
  return {
    schema: "stash.task.v1", id: row.id, workspaceId: row.workspace_id, projectId: row.project_id,
    key: row.task_key, ...(row.key_aliases?.length ? { keyAliases: row.key_aliases } : {}), title: row.title,
    status: { id: row.workflow_status_id, name: row.status_name, category: row.status_category },
    assigneeIds: row.assignee_ids ?? [], ...(row.former_assignee_ids?.length ? { formerAssigneeIds: row.former_assignee_ids } : {}),
    priority: row.priority ?? "none", labelNames: row.label_names ?? [],
    ...(row.due_date ? { dueDate: typeof row.due_date === "string" ? row.due_date : row.due_date.toISOString().slice(0, 10) } : {}),
    ...(row.estimate === null || row.estimate === undefined ? {} : { estimate: Number(row.estimate) }),
    linkedNoteIds: row.linked_note_ids ?? [], dependencies: row.dependencies ?? [], developmentLinks: row.development_links ?? [],
    sourceNoteIds: row.source_note_ids ?? [], ...(row.source_blocks?.length ? { sourceBlocks: row.source_blocks } : {}),
    createdAt: new Date(row.created_at).toISOString(),
    createdBy: { localAccountId: row.created_by_account_id, displayName: row.created_by_name },
  };
}

function formerAssignmentsAfterUpdate(
  previousFormerAssigneeIds: readonly string[],
  nextAssigneeIds: readonly string[],
  assigneesWereUpdated: boolean,
): string[] {
  if (!assigneesWereUpdated) return [...previousFormerAssigneeIds];
  const removedEveryFormerAssignee = previousFormerAssigneeIds.every((id) => !nextAssigneeIds.includes(id));
  const hasReplacementAssignee = nextAssigneeIds.some((id) => !previousFormerAssigneeIds.includes(id));
  return removedEveryFormerAssignee && hasReplacementAssignee ? [] : [...previousFormerAssigneeIds];
}

function taskPlanningReadModelFromRow(row: any): TaskPlanningReadModel {
  return { ...taskProjectionFromRow(row), revision: Number(row.revision), dependencyWarnings: row.dependency_warnings ?? [] };
}

function taskConflictFromRow(row: any): TaskEditConflict {
  return { id: row.id, taskId: row.task_id, baseRevision: row.base_revision, currentRevision: row.current_revision,
    fields: row.fields, contribution: row.contribution, createdAt: new Date(row.created_at).toISOString(),
    createdBy: { displayName: row.created_by_display_name, attribution: "recorded" },
    ...(row.resolved_at ? { resolvedAt: new Date(row.resolved_at).toISOString(), resolution: row.resolution } : {}) };
}
function boardFromRow(row: any): Board {
  return { schema: "stash.board.v1", id: row.id, projectId: row.project_id, name: row.name,
    groupBy: row.group_by, createdAt: new Date(row.created_at).toISOString() };
}

const collaborationSchema = new Schema({
  nodes: {
    doc: { content: "block+" }, text: { group: "inline" }, paragraph: { group: "block", content: "inline*", attrs: { blockKey: { default: null }, blockId: { default: null } } },
    heading: { group: "block", content: "inline*", attrs: { level: { default: 1 }, blockKey: { default: null }, blockId: { default: null } } },
    codeBlock: { group: "block", content: "text*", marks: "", code: true, attrs: { language: { default: null }, blockKey: { default: null }, blockId: { default: null } } },
    blockquote: { group: "block", content: "block+", attrs: { blockKey: { default: null }, blockId: { default: null } } },
    bulletList: { group: "block", content: "listItem+", attrs: { blockKey: { default: null }, blockId: { default: null } } },
    listItem: { content: "paragraph block*", attrs: { blockKey: { default: null }, blockId: { default: null } } },
    taskList: { group: "block", content: "taskItem+", attrs: { blockKey: { default: null }, blockId: { default: null } } },
    taskItem: { content: "paragraph block*", attrs: { checked: { default: false }, blockKey: { default: null }, blockId: { default: null } } },
    callout: { group: "block", content: "block+", attrs: { blockKey: { default: null }, blockId: { default: null }, kind: { default: "note" } } },
    workspaceAttachment: { group: "block", atom: true, attrs: { blockKey: { default: null }, blockId: { default: null }, href: {}, label: {} } },
    image: { group: "block", atom: true, attrs: { blockKey: { default: null }, blockId: { default: null }, src: {}, alt: { default: "" }, title: { default: null } } },
    table: { group: "block", content: "tableRow+", tableRole: "table", attrs: { blockKey: { default: null }, blockId: { default: null } } },
    tableRow: { content: "(tableCell|tableHeader)+", tableRole: "row" },
    tableCell: { content: "paragraph", tableRole: "cell", attrs: { colspan: { default: 1 }, rowspan: { default: 1 }, colwidth: { default: null } } },
    tableHeader: { content: "paragraph", tableRole: "header_cell", attrs: { colspan: { default: 1 }, rowspan: { default: 1 }, colwidth: { default: null } } },
  },
  marks: { bold: {}, italic: {}, code: { code: true }, link: { attrs: { href: {} }, inclusive: false } },
});

export function collaborativeDocumentFromRichText(document: import("./rich-text.js").RichTextDocument): Y.Doc {
  return prosemirrorJSONToYDoc(collaborationSchema, richTextToProseMirror(document), "default");
}

export function richTextFromCollaborativeDocument(document: Y.Doc): import("./rich-text.js").RichTextDocument {
  return proseMirrorToRichText(yDocToProsemirrorJSON(document, "default"));
}

export function validatedRichTextFromCollaborativeDocument(document: Y.Doc): import("./rich-text.js").RichTextDocument {
  const materialized = richTextFromCollaborativeDocument(document);
  if (!isRichTextDocument(materialized)) throw new InvalidCollaborationUpdate();
  return materialized;
}

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
  GitHubArtifactRepository,
  GitHubSignalRepository,
  TaskFromBlockRepository,
  TaskPlanningRepository,
  StructuredTaskEditRepository,
  TaskMoveRepository,
  AttachmentRepository,
  MobileCaptureRepository,
  DiscussionRepository,
  ProjectWorkflowRepository,
  PortableWorkspaceExportRepository,
  PortableWorkspaceImportRepository,
  BoardRepository,
  ActivityRepository,
  NotificationRepository,
  AutomationRepository,
  NoteCollaborationRepository
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
      await this.#ensureDefaultWorkflow(client, record.id);
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
      await this.#recordInitialNoteLocation(client, note.id, note.workspaceId);
      await this.#recordPortableProjection(client, "Note", note.id, "stash.note.v1", projection);
      await this.#recordNoteRevisionAndActivity(client, memberId, undefined, note, "note_created", { kind: "member" });
      return "created";
    });
  }

  async createMobileCapture(
    memberId: string,
    clientCaptureId: string,
    payloadDigest: string,
    note: NoteRecord,
    projection: PortableNoteProjection,
  ): Promise<{ status: "created" | "duplicate"; noteId: string } | { status: "workspace_forbidden" | "project_forbidden" | "conflict" }> {
    return this.#withTransaction(async (client) => {
      await this.#ensureNoteSchema(client);
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [memberId, clientCaptureId]);
      const receipt = await client.query<{ note_id: string; payload_digest: string | null }>(
        "SELECT note_id, payload_digest FROM stash_mobile_capture_receipts WHERE account_id = $1 AND client_capture_id = $2",
        [memberId, clientCaptureId],
      );
      if (receipt.rows[0]) return receipt.rows[0].payload_digest === payloadDigest
        ? { status: "duplicate", noteId: receipt.rows[0].note_id }
        : { status: "conflict" };
      const access = await client.query<{ allowed: boolean }>(
        `SELECT ((owner_type = 'personal' AND personal_owner_id = $2) OR
          (owner_type = 'organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
            WHERE membership.organization_id = stash_workspaces.organization_owner_id AND membership.account_id = $2))) AS allowed
         FROM stash_workspaces WHERE id = $1`, [note.workspaceId, memberId],
      );
      if (!access.rows[0]?.allowed) return { status: "workspace_forbidden" };
      if (note.projectId) {
        const project = await client.query("SELECT 1 FROM stash_projects WHERE id = $1 AND workspace_id = $2", [note.projectId, note.workspaceId]);
        if (!project.rowCount) return { status: "project_forbidden" };
      }
      await client.query(
        `INSERT INTO stash_notes (id, workspace_id, project_id, content, document, revision, tags, reminder_at, created_by_account_id, created_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8, $9, $10)`,
        [note.id, note.workspaceId, note.projectId ?? null, note.content, JSON.stringify(note.document), note.revision,
          JSON.stringify(note.tags), note.reminder?.at ?? null, memberId, note.createdAt],
      );
      await this.#recordInitialNoteLocation(client, note.id, note.workspaceId);
      await this.#recordPortableProjection(client, "Note", note.id, "stash.note.v1", projection);
      await this.#recordNoteRevisionAndActivity(client, memberId, undefined, note, "note_created", { kind: "member" });
      await client.query(
        "INSERT INTO stash_mobile_capture_receipts (account_id, client_capture_id, note_id, payload_digest) VALUES ($1, $2, $3, $4)",
        [memberId, clientCaptureId, note.id, payloadDigest],
      );
      return { status: "created", noteId: note.id };
    });
  }

  async listMobileCaptureOptions(memberId: string, workspaceId: string) {
    const client = await this.#pool.connect();
    try {
      await this.#ensureNoteSchema(client);
      await this.#ensureInvitationSchema(client);
      const access = await client.query(`SELECT 1 FROM stash_workspaces workspace WHERE workspace.id = $1 AND (
        (workspace.owner_type = 'personal' AND workspace.personal_owner_id = $2) OR
        (workspace.owner_type = 'organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
          WHERE membership.organization_id = workspace.organization_owner_id AND membership.account_id = $2)))`, [workspaceId, memberId]);
      if (!access.rowCount) return { status: "workspace_forbidden" as const };
      const [projects, tags] = await Promise.all([
        client.query<{ id: string; name: string }>("SELECT id, name FROM stash_projects WHERE workspace_id = $1 ORDER BY name, id", [workspaceId]),
        client.query<{ tag: string }>(`SELECT DISTINCT jsonb_array_elements_text(tags) AS tag FROM stash_notes
          WHERE workspace_id = $1 ORDER BY tag`, [workspaceId]),
      ]);
      return { status: "found" as const, projects: projects.rows, tags: tags.rows.map(({ tag }) => tag) };
    } finally { client.release(); }
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

  async listNotesByTag(memberId: string, workspaceId: string, tag: string) {
    const client = await this.#pool.connect();
    try {
      await this.#ensureNoteSchema(client);
      const access = await client.query(`SELECT 1 FROM stash_workspaces workspace WHERE workspace.id = $1 AND (
        (workspace.owner_type = 'personal' AND workspace.personal_owner_id = $2) OR
        (workspace.owner_type = 'organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
          WHERE membership.organization_id = workspace.organization_owner_id AND membership.account_id = $2)) OR
        EXISTS (SELECT 1 FROM stash_projects project JOIN stash_project_guests guest ON guest.project_id = project.id
          WHERE project.workspace_id = workspace.id AND guest.account_id = $2))`, [workspaceId, memberId]);
      if (!access.rowCount) return { status: "workspace_forbidden" as const };
      const result = await client.query<any>(`SELECT note.id, note.workspace_id, note.project_id, note.content, note.document, note.revision,
        note.tags, note.reminder_at, note.created_by_account_id, note.created_at, note.archived_at
        FROM stash_notes note JOIN stash_workspaces workspace ON workspace.id = note.workspace_id
        WHERE note.workspace_id = $1 AND note.archived_at IS NULL AND note.tags @> $2::jsonb AND (
          (workspace.owner_type = 'personal' AND workspace.personal_owner_id = $3) OR
          (workspace.owner_type = 'organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
            WHERE membership.organization_id = workspace.organization_owner_id AND membership.account_id = $3)) OR
          (note.project_id IS NOT NULL AND EXISTS (SELECT 1 FROM stash_project_guests guest
            WHERE guest.project_id = note.project_id AND guest.account_id = $3))) ORDER BY note.created_at, note.id`,
      [workspaceId, JSON.stringify([tag]), memberId]);
      return { status: "found" as const, notes: result.rows.map((row: any) => ({ id: row.id, workspaceId: row.workspace_id,
        content: row.content, document: row.document, revision: row.revision, tags: row.tags, createdByMemberId: row.created_by_account_id,
        createdAt: new Date(row.created_at).toISOString(), ...(row.project_id ? { projectId: row.project_id } : {}),
        ...(row.reminder_at ? { reminder: { at: new Date(row.reminder_at).toISOString() } } : {}) })) };
    } finally { client.release(); }
  }

  async findAttachmentReceipt(memberId: string, workspaceId: string, operationKey: string) {
    const client = await this.#pool.connect();
    try {
      await this.#ensureAttachmentSchema(client);
      const result = await client.query<any>(`SELECT receipt.payload_digest, receipt.projection, attachment.*
        FROM stash_attachment_operation_receipts receipt JOIN stash_attachments attachment ON attachment.id = receipt.attachment_id
        JOIN stash_workspaces workspace ON workspace.id = receipt.workspace_id
        WHERE receipt.operation_key = $1 AND receipt.workspace_id = $2 AND receipt.created_by_account_id = $3
        AND ((workspace.owner_type = 'personal' AND workspace.personal_owner_id = $3) OR EXISTS
          (SELECT 1 FROM stash_organization_memberships membership WHERE membership.organization_id = workspace.organization_owner_id AND membership.account_id = $3))`,
      [operationKey, workspaceId, memberId]);
      const row = result.rows[0];
      if (!row) return undefined;
      return { digest: row.payload_digest, record: attachmentRecord(row), projection: row.projection as PortableAttachmentProjection };
    } finally { client.release(); }
  }

  async createAttachment(memberId: string, record: AttachmentRecord, projection: PortableAttachmentProjection,
    operation?: { key: string; digest: string }) {
    return this.#withTransaction(async (client) => {
      await this.#ensureAttachmentSchema(client);
      const access = await client.query(`SELECT 1 FROM stash_workspaces workspace WHERE workspace.id = $1 AND ((workspace.owner_type = 'personal' AND workspace.personal_owner_id = $2) OR EXISTS (SELECT 1 FROM stash_organization_memberships membership WHERE membership.organization_id = workspace.organization_owner_id AND membership.account_id = $2))`, [record.workspaceId, memberId]);
      if (!access.rowCount) return { status: "workspace_forbidden" as const };
      if (operation) {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${record.workspaceId}:${memberId}:${operation.key}`]);
        const receipt = await client.query<any>(`SELECT receipt.payload_digest, receipt.projection, attachment.*
          FROM stash_attachment_operation_receipts receipt JOIN stash_attachments attachment ON attachment.id = receipt.attachment_id
          WHERE receipt.operation_key = $1 AND receipt.workspace_id = $2 AND receipt.created_by_account_id = $3`,
        [operation.key, record.workspaceId, memberId]);
        const existing = receipt.rows[0];
        if (existing) return existing.payload_digest === operation.digest
          ? { status: "duplicate" as const, digest: existing.payload_digest, record: attachmentRecord(existing),
            projection: existing.projection as PortableAttachmentProjection }
          : { status: "conflict" as const };
      }
      await client.query(`INSERT INTO stash_attachments (id, workspace_id, filename, content_type, byte_size, relative_path, storage_key, source, created_by_account_id, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [record.id, record.workspaceId, record.filename, record.contentType, record.size, record.relativePath, record.storageKey, record.source, memberId, record.createdAt]);
      await this.#recordPortableProjection(client, "Attachment", record.id, projection.schema, projection);
      if (operation) await client.query(`INSERT INTO stash_attachment_operation_receipts
        (operation_key, workspace_id, created_by_account_id, payload_digest, attachment_id, projection)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb)`, [operation.key, record.workspaceId, memberId, operation.digest, record.id, JSON.stringify(projection)]);
      return { status: "created" as const };
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
      return row ? attachmentRecord(row) : undefined;
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
      if (block.id && blocks.filter((candidate) => candidate.id === blockId).length !== 1)
        return { status: "ambiguous_block" as const };
      const noteProjection = () => ({ schema: "stash.note.v1" as const, id: noteId, workspaceId: row.workspace_id,
        content: row.content, tags: row.tags, createdAt: new Date(row.created_at).toISOString(),
        createdBy: { localAccountId: row.created_by_account_id, displayName: row.created_by_name },
        ...(row.project_id ? { projectId: row.project_id } : {}), ...(row.reminder_at ? { reminder: { at: new Date(row.reminder_at).toISOString() } } : {}) });
      if (!block.id) {
        const before = this.#noteFromRow({ ...row, id: noteId, workspace_id: row.workspace_id });
        block.id = blockId;
        const content = richTextToMarkdown(row.document);
        await client.query("UPDATE stash_notes SET document = $2::jsonb, content = $3, revision = revision + 1 WHERE id = $1",
          [noteId, JSON.stringify(row.document), content]);
        row.content = content;
        row.revision = Number(row.revision) + 1;
        await this.#recordPortableProjection(client, "Note", noteId, "stash.note.v1", noteProjection());
        await this.#recordNoteRevisionAndActivity(client, memberId, before, this.#noteFromRow({ ...row, id: noteId,
          workspace_id: row.workspace_id }), "note_block_identified", { kind: "member" });
      }
      const task = await this.#createTask(client, { ...draft, workspaceId: row.workspace_id, sourceNoteIds: [noteId],
        sourceBlocks: [{ noteId, blockId }] });
      await client.query("INSERT INTO stash_tasks (id, workspace_id, project_id, task_key, workflow_status_id, title, created_by_account_id, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
        [task.id, row.workspace_id, task.projectId, task.key, task.status.id, task.title, memberId, task.createdAt]);
      await client.query("INSERT INTO stash_task_note_sources (task_id, note_id) VALUES ($1,$2)", [task.id, noteId]);
      await client.query("INSERT INTO stash_task_block_sources (task_id, note_id, block_id) VALUES ($1,$2,$3)", [task.id, noteId, blockId]);
      await this.#recordPortableProjection(client, "Task", task.id, task.schema, task);
      await this.#recordDomainActivity(client,memberId,row.workspace_id,"Task",task.id,"task_created_from_block",{},task);
      const sourceBlock: TaskSourceBlockReference = { noteId, blockId };
      return { status: "created" as const, task, sourceBlock };
    });
  }

  async createDiscussion(memberId: string, draft: DiscussionDraft) {
    return this.#withTransaction(async (client) => {
      await this.#ensureDiscussionSchema(client);
      let workspaceId: string;
      let target: DiscussionTarget;
      if (draft.target.kind === "task") {
        const task = await client.query<{ workspace_id: string; can_write: boolean; guest_can_read: boolean }>(`SELECT task.workspace_id,
          ((workspace.owner_type = 'personal' AND workspace.personal_owner_id = $2) OR EXISTS (
            SELECT 1 FROM stash_organization_memberships membership WHERE membership.organization_id = workspace.organization_owner_id
              AND membership.account_id = $2)) AS can_write,
          EXISTS (SELECT 1 FROM stash_project_guests guest WHERE guest.project_id = task.project_id AND guest.account_id = $2) AS guest_can_read
          FROM stash_tasks task JOIN stash_workspaces workspace ON workspace.id = task.workspace_id
          WHERE task.id = $1 FOR UPDATE OF task`, [draft.target.taskId, memberId]);
        const taskRow = task.rows[0];
        if (!taskRow) return { status: "target_not_found" as const };
        if (!taskRow.can_write) return { status: taskRow.guest_can_read ? "forbidden" as const : "target_not_found" as const };
        workspaceId = taskRow.workspace_id;
        target = draft.target;
      } else {
        const note = await client.query<any>(`SELECT note.*, creator.name AS created_by_name,
          ((workspace.owner_type = 'personal' AND workspace.personal_owner_id = $2) OR EXISTS (
            SELECT 1 FROM stash_organization_memberships membership WHERE membership.organization_id = workspace.organization_owner_id
              AND membership.account_id = $2)) AS can_write,
          (note.project_id IS NOT NULL AND EXISTS (SELECT 1 FROM stash_project_guests guest
            WHERE guest.project_id = note.project_id AND guest.account_id = $2)) AS guest_can_read
          FROM stash_notes note
          JOIN stash_accounts creator ON creator.id = note.created_by_account_id
          JOIN stash_workspaces workspace ON workspace.id = note.workspace_id WHERE note.id = $1 FOR UPDATE OF note`, [draft.target.noteId, memberId]);
        const row = note.rows[0];
        if (!row) return { status: "target_not_found" as const };
        if (!row.can_write) return { status: row.guest_can_read ? "forbidden" as const : "target_not_found" as const };
        workspaceId = row.workspace_id;
        if (draft.target.kind === "note") target = draft.target;
        else {
          const blockTarget = draft.target;
          const blocks = Array.isArray(row.document?.blocks) ? row.document.blocks as Array<{ blockKey?: string; id?: string }> : [];
          const matches = blocks.filter((block) => block.blockKey === blockTarget.blockKey);
          if (matches.length !== 1) return { status: "target_not_found" as const };
          const block = matches[0]!;
          const blockId = block.id ?? randomUUID();
          if (block.id && blocks.filter((candidate) => candidate.id === blockId).length !== 1)
            return { status: "ambiguous_block" as const };
          if (!block.id) {
            const before = this.#noteFromRow(row);
            block.id = blockId;
            const content = richTextToMarkdown(row.document);
            await client.query("UPDATE stash_notes SET document = $2::jsonb, content = $3, revision = revision + 1 WHERE id = $1",
              [draft.target.noteId, JSON.stringify(row.document), content]);
            const noteProjection = { schema: "stash.note.v1" as const, id: draft.target.noteId, workspaceId,
              content, tags: row.tags, createdAt: new Date(row.created_at).toISOString(),
              createdBy: { localAccountId: row.created_by_account_id, displayName: row.created_by_name },
              ...(row.project_id ? { projectId: row.project_id } : {}),
              ...(row.reminder_at ? { reminder: { at: new Date(row.reminder_at).toISOString() } } : {}) };
            await this.#recordPortableProjection(client, "Note", draft.target.noteId, "stash.note.v1", noteProjection);
            row.content = content; row.revision = Number(row.revision) + 1;
            await this.#recordNoteRevisionAndActivity(client, memberId, before, this.#noteFromRow(row),
              "note_block_identified", { kind: "member" });
          }
          target = { kind: "block", noteId: draft.target.noteId, blockId };
        }
      }
      const discussion: DiscussionRecord = { ...draft, workspaceId, target };
      await client.query(`INSERT INTO stash_discussions
        (id, workspace_id, target_kind, note_id, block_id, task_id, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`, [discussion.id, workspaceId, target.kind,
        target.kind === "note" || target.kind === "block" ? target.noteId : null,
        target.kind === "block" ? target.blockId : null, target.kind === "task" ? target.taskId : null, discussion.createdAt]);
      const first = discussion.messages[0]!;
      await client.query(`INSERT INTO stash_discussion_messages (id, discussion_id, content, author_account_id, created_at)
        VALUES ($1,$2,$3,$4,$5)`, [first.id, discussion.id, first.content, first.author.localAccountId, first.createdAt]);
      const projection = this.#portableDiscussion(discussion);
      await this.#recordPortableProjection(client, "Discussion", discussion.id, projection.schema, projection);
      await this.#recordDiscussionMentionNotifications(client, memberId, discussion, first);
      return { status: "created" as const, discussion, projection };
    });
  }

  async findDiscussion(memberId: string, discussionId: string) {
    const client = await this.#pool.connect();
    try {
      await this.#ensureDiscussionSchema(client);
      const discussion = await this.#readDiscussion(client, memberId, discussionId, false);
      return discussion ? { status: "found" as const, discussion } : { status: "not_found" as const };
    } finally { client.release(); }
  }

  async listNoteDiscussions(memberId: string, noteId: string) {
    const client = await this.#pool.connect();
    try {
      await this.#ensureDiscussionSchema(client);
      const access = await client.query(`SELECT 1 FROM stash_notes note JOIN stash_workspaces workspace ON workspace.id = note.workspace_id
        WHERE note.id = $1 AND ((workspace.owner_type = 'personal' AND workspace.personal_owner_id = $2) OR EXISTS (
          SELECT 1 FROM stash_organization_memberships membership WHERE membership.organization_id = workspace.organization_owner_id
            AND membership.account_id = $2) OR (note.project_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM stash_project_guests guest WHERE guest.project_id = note.project_id AND guest.account_id = $2)))`, [noteId, memberId]);
      if (!access.rowCount) return { status: "not_found" as const };
      const ids = await client.query<{ id: string }>("SELECT id FROM stash_discussions WHERE note_id = $1 ORDER BY created_at, id", [noteId]);
      const discussions: DiscussionRecord[] = [];
      for (const { id } of ids.rows) {
        const discussion = await this.#readDiscussion(client, memberId, id, false);
        if (discussion) discussions.push(discussion);
      }
      return { status: "found" as const, discussions };
    } finally { client.release(); }
  }

  async listTaskDiscussions(memberId: string, taskId: string) {
    const client = await this.#pool.connect();
    try {
      await this.#ensureDiscussionSchema(client);
      const access = await client.query(`SELECT 1 FROM stash_tasks task JOIN stash_workspaces workspace ON workspace.id = task.workspace_id
        WHERE task.id = $1 AND ((workspace.owner_type = 'personal' AND workspace.personal_owner_id = $2) OR EXISTS (
          SELECT 1 FROM stash_organization_memberships membership WHERE membership.organization_id = workspace.organization_owner_id
            AND membership.account_id = $2) OR EXISTS (
          SELECT 1 FROM stash_project_guests guest WHERE guest.project_id = task.project_id AND guest.account_id = $2))`, [taskId, memberId]);
      if (!access.rowCount) return { status: "not_found" as const };
      const ids = await client.query<{ id: string }>("SELECT id FROM stash_discussions WHERE task_id = $1 ORDER BY created_at, id", [taskId]);
      const discussions: DiscussionRecord[] = [];
      for (const { id } of ids.rows) {
        const discussion = await this.#readDiscussion(client, memberId, id, false);
        if (discussion) discussions.push(discussion);
      }
      return { status: "found" as const, discussions };
    } finally { client.release(); }
  }

  async addMessage(memberId: string, discussionId: string, message: DiscussionMessage) {
    return this.#withTransaction(async (client) => {
      await this.#ensureDiscussionSchema(client);
      const discussion = await this.#readDiscussion(client, memberId, discussionId, true);
      if (!discussion) return { status: "not_found" as const };
      if (!await this.#canWriteDiscussion(client, memberId, discussion.workspaceId)) return { status: "forbidden" as const };
      if (discussion.resolvedAt) return { status: "resolved" as const };
      await client.query(`INSERT INTO stash_discussion_messages (id, discussion_id, content, author_account_id, created_at)
        VALUES ($1,$2,$3,$4,$5)`, [message.id, discussionId, message.content, message.author.localAccountId, message.createdAt]);
      discussion.messages.push(message);
      const projection = this.#portableDiscussion(discussion);
      await this.#recordPortableProjection(client, "Discussion", discussionId, projection.schema, projection);
      await this.#recordDiscussionMentionNotifications(client, memberId, discussion, message);
      return { status: "updated" as const, discussion, projection };
    });
  }

  async resolveDiscussion(memberId: string, discussionId: string, resolvedAt: string) {
    return this.#withTransaction(async (client) => {
      await this.#ensureDiscussionSchema(client);
      const discussion = await this.#readDiscussion(client, memberId, discussionId, true);
      if (!discussion) return { status: "not_found" as const };
      if (!await this.#canWriteDiscussion(client, memberId, discussion.workspaceId)) return { status: "forbidden" as const };
      if (discussion.resolvedAt) return { status: "already_resolved" as const, discussion };
      await client.query("UPDATE stash_discussions SET resolved_at = $2 WHERE id = $1", [discussionId, resolvedAt]);
      discussion.resolvedAt = resolvedAt;
      const projection = this.#portableDiscussion(discussion);
      await this.#recordPortableProjection(client, "Discussion", discussionId, projection.schema, projection);
      return { status: "resolved" as const, discussion, projection };
    });
  }

  async createWorkFromMessages(memberId: string, discussionId: string, draft: CreateDiscussionWorkDraft): Promise<DiscussionWorkOutcome> {
    return this.#withTransaction(async (client) => {
      await this.#ensureDiscussionSchema(client);
      const discussion = await this.#readDiscussion(client, memberId, discussionId, true);
      if (!discussion) return { status: "not_found" as const };
      if (!await this.#canWriteDiscussion(client, memberId, discussion.workspaceId)) return { status: "forbidden" as const };
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [memberId, draft.idempotencyKey]);
      const fingerprint = createHash("sha256").update(JSON.stringify({ discussionId, kind: draft.kind,
        messageIds: draft.messageIds, ...(draft.kind === "task" ? { projectId: draft.projectId, title: draft.title } : {}) })).digest("hex");
      const receipt = await client.query<{ fingerprint: string; outcome: DiscussionWorkOutcome }>(
        "SELECT fingerprint, outcome FROM stash_discussion_work_receipts WHERE account_id = $1 AND idempotency_key = $2 FOR UPDATE",
        [memberId, draft.idempotencyKey],
      );
      if (receipt.rows[0]) return receipt.rows[0].fingerprint === fingerprint
        ? { ...(receipt.rows[0].outcome as Extract<DiscussionWorkOutcome, { status: "created" }>), status: "duplicate" as const }
        : { status: "idempotency_conflict" as const };
      const selectedIds = new Set(draft.messageIds);
      const selectedMessages = discussion.messages.filter(({ id }) => selectedIds.has(id));
      if (selectedMessages.length !== draft.messageIds.length) return { status: "message_not_found" as const };

      let work: Extract<DiscussionWorkOutcome, { status: "created" }>["work"];
      let workProjection: { schema: "stash.note.v1" | "stash.task.v1" };
      if (draft.kind === "note") {
        const content = selectedMessages.map(({ content }) => content).join("\n\n");
        const document = paragraphDocument(content, randomUUID());
        await client.query(`INSERT INTO stash_notes
          (id, workspace_id, project_id, content, document, revision, tags, reminder_at, created_by_account_id, created_at)
          VALUES ($1,$2,NULL,$3,$4::jsonb,1,'[]'::jsonb,NULL,$5,$6)`,
        [draft.workId, discussion.workspaceId, content, JSON.stringify(document), memberId, draft.createdAt]);
        await this.#recordInitialNoteLocation(client, draft.workId, discussion.workspaceId);
        const projection = { schema: "stash.note.v1" as const, id: draft.workId, workspaceId: discussion.workspaceId,
          content, tags: [], createdAt: draft.createdAt, createdBy: draft.createdBy };
        await this.#recordPortableProjection(client, "Note", draft.workId, projection.schema, projection);
        await this.#recordNoteRevisionAndActivity(client, memberId, undefined, { id: draft.workId, workspaceId: discussion.workspaceId,
          content, document, revision: 1, tags: [], createdByMemberId: memberId,
          createdAt: draft.createdAt }, "note_created", { kind: "member" });
        work = { kind: "note", id: draft.workId, workspaceId: discussion.workspaceId, content,
          source: { discussionId, messageIds: selectedMessages.map(({ id }) => id) } };
        workProjection = { schema: projection.schema };
      } else {
        const project = await client.query("SELECT 1 FROM stash_projects WHERE id = $1 AND workspace_id = $2", [draft.projectId, discussion.workspaceId]);
        if (!project.rowCount) return { status: "project_forbidden" as const };
        const projection = await this.#createTask(client, { id: draft.workId, workspaceId: discussion.workspaceId,
          projectId: draft.projectId, title: draft.title, sourceNoteIds: [], createdAt: draft.createdAt, createdBy: draft.createdBy });
        await client.query("INSERT INTO stash_tasks (id, workspace_id, project_id, task_key, workflow_status_id, title, created_by_account_id, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
          [projection.id, projection.workspaceId, projection.projectId, projection.key, projection.status.id, projection.title, memberId, projection.createdAt]);
        await this.#recordPortableProjection(client, "Task", projection.id, projection.schema, projection);
        work = { kind: "task", id: projection.id, workspaceId: projection.workspaceId, projectId: projection.projectId,
          title: projection.title, key: projection.key, source: { discussionId, messageIds: selectedMessages.map(({ id }) => id) } };
        workProjection = { schema: projection.schema };
      }
      const link: PortableDiscussionWorkLinkProjection = { schema: "stash.discussion-work-link.v1", id: draft.linkId,
        workspaceId: discussion.workspaceId, discussionId, work: { kind: work.kind, id: work.id },
        selectedMessages, createdAt: draft.createdAt, createdBy: draft.createdBy };
      await client.query(`INSERT INTO stash_discussion_work_links
        (id, discussion_id, work_kind, note_id, task_id, selected_message_ids, created_by_account_id, created_at)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`, [draft.linkId, discussionId, work.kind,
        work.kind === "note" ? work.id : null, work.kind === "task" ? work.id : null,
        JSON.stringify(link.selectedMessages.map(({ id }) => id)), memberId, draft.createdAt]);
      await this.#recordPortableProjection(client, "DiscussionWorkLink", link.id, link.schema, link);
      const activity: DiscussionWorkActivity = { schema: "stash.activity.v1", id: randomUUID(), workspaceId: discussion.workspaceId,
        action: "discussion_work_created", object: { kind: work.kind === "note" ? "Note" : "Task", id: work.id },
        actor: draft.createdBy, cause: { kind: "member" }, occurredAt: draft.createdAt,
        before: { discussionId, selectedMessageIds: selectedMessages.map(({ id }) => id) }, after: work };
      await client.query(`INSERT INTO stash_workspace_activity
        (id, workspace_id, object_kind, object_id, action, actor_account_id, cause, occurred_at, before_state, after_state)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb)`, [activity.id, activity.workspaceId,
        activity.object.kind, activity.object.id, activity.action, memberId, activity.cause.kind, activity.occurredAt,
        JSON.stringify(activity.before), JSON.stringify(activity.after)]);
      await this.#recordPortableProjection(client, "Activity", activity.id, activity.schema, activity);
      await this.#recordProjectActivityNotifications(client, activity);
      const outcome = { status: "created" as const, work, activity, projections: [workProjection, link, activity] };
      await client.query("INSERT INTO stash_discussion_work_receipts (account_id,idempotency_key,fingerprint,outcome) VALUES ($1,$2,$3,$4::jsonb)",
        [memberId, draft.idempotencyKey, fingerprint, JSON.stringify(outcome)]);
      return outcome;
    });
  }

  async listLinkedTasks(memberId: string, noteId: string) {
    const client = await this.#pool.connect();
    try {
      await this.#ensureNoteSchema(client);
      const result = await client.query<any>(`SELECT task.id, task.task_key, task.title, status.id AS status_id,
        status.name AS status_name, status.category, source.block_id, note.document
        FROM stash_notes note JOIN stash_workspaces workspace ON workspace.id = note.workspace_id
        LEFT JOIN stash_task_block_sources source ON source.note_id = note.id
        LEFT JOIN stash_tasks task ON task.id = source.task_id
        LEFT JOIN stash_workflow_statuses status ON status.id = task.workflow_status_id
        WHERE note.id = $1 AND note.archived_at IS NULL AND ((workspace.owner_type = 'personal' AND workspace.personal_owner_id = $2)
        OR (workspace.owner_type = 'organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
          WHERE membership.organization_id = workspace.organization_owner_id AND membership.account_id = $2)))
        ORDER BY task.created_at NULLS FIRST, task.id NULLS FIRST`, [noteId, memberId]);
      if (!result.rowCount) return { status: "note_not_found" as const };
      const tasks: LinkedTaskReadModel[] = result.rows.filter((row: any) => row.id !== null).map((row: any) => {
        const matches = Array.isArray(row.document?.blocks) ? row.document.blocks.filter((block: any) => block.id === row.block_id).length : 0;
        return { id: row.id, key: row.task_key, title: row.title,
          status: { id: row.status_id, name: row.status_name, category: row.category }, sourceBlock: { noteId, blockId: row.block_id },
          relationshipState: matches === 1 ? "linked" : matches > 1 ? "ambiguous" : "broken" };
      });
      return { status: "found" as const, tasks };
    } finally { client.release(); }
  }

  async linkTaskToBlock(memberId: string, taskId: string, noteId: string, blockKey: string) {
    return this.#withTransaction(async (client) => {
      await this.#ensureNoteSchema(client);
      const taskResult = await client.query<any>(`SELECT task.*, status.name AS status_name, status.category,
        creator.name AS created_by_name FROM stash_tasks task
        JOIN stash_workflow_statuses status ON status.id = task.workflow_status_id
        JOIN stash_accounts creator ON creator.id = task.created_by_account_id
        JOIN stash_workspaces workspace ON workspace.id = task.workspace_id
        WHERE task.id = $1 AND ((workspace.owner_type = 'personal' AND workspace.personal_owner_id = $2)
        OR (workspace.owner_type = 'organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
          WHERE membership.organization_id = workspace.organization_owner_id AND membership.account_id = $2))) FOR UPDATE`, [taskId, memberId]);
      const taskRow = taskResult.rows[0];
      if (!taskRow) return { status: "task_not_found" as const };
      const noteResult = await client.query<any>(`SELECT note.*, creator.name AS created_by_name FROM stash_notes note
        JOIN stash_accounts creator ON creator.id = note.created_by_account_id
        WHERE note.id = $1 AND note.workspace_id = $2 AND note.archived_at IS NULL FOR UPDATE`, [noteId, taskRow.workspace_id]);
      const noteRow = noteResult.rows[0];
      if (!noteRow) return { status: "note_not_found" as const };
      const blocks = noteRow.document.blocks as Array<{ blockKey?: string; id?: string }>;
      const matches = blocks.filter((block) => block.blockKey === blockKey);
      if (matches.length !== 1) return { status: "block_not_found" as const };
      const block = matches[0]!;
      const blockId = block.id ?? randomUUID();
      if (block.id && blocks.filter((candidate) => candidate.id === blockId).length !== 1)
        return { status: "ambiguous_block" as const };
      const existing = await client.query("SELECT 1 FROM stash_task_block_sources WHERE task_id = $1 AND note_id = $2 AND block_id = $3",
        [taskId, noteId, blockId]);
      const sourceBlock: TaskSourceBlockReference = { noteId, blockId };
      if (!existing.rowCount) {
        if (!block.id) {
          const before = this.#noteFromRow(noteRow);
          block.id = blockId;
          const content = richTextToMarkdown(noteRow.document);
          await client.query("UPDATE stash_notes SET document = $2::jsonb, content = $3, revision = revision + 1 WHERE id = $1",
            [noteId, JSON.stringify(noteRow.document), content]);
          const noteProjection = { schema: "stash.note.v1" as const, id: noteId, workspaceId: noteRow.workspace_id,
            content, tags: noteRow.tags, createdAt: new Date(noteRow.created_at).toISOString(),
            createdBy: { localAccountId: noteRow.created_by_account_id, displayName: noteRow.created_by_name },
            ...(noteRow.project_id ? { projectId: noteRow.project_id } : {}),
            ...(noteRow.reminder_at ? { reminder: { at: new Date(noteRow.reminder_at).toISOString() } } : {}) };
          await this.#recordPortableProjection(client, "Note", noteId, noteProjection.schema, noteProjection);
          noteRow.content = content; noteRow.revision = Number(noteRow.revision) + 1;
          await this.#recordNoteRevisionAndActivity(client, memberId, before, this.#noteFromRow(noteRow),
            "note_block_identified", { kind: "member" });
        }
        await client.query("INSERT INTO stash_task_note_sources (task_id, note_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [taskId, noteId]);
        await client.query("INSERT INTO stash_task_block_sources (task_id, note_id, block_id) VALUES ($1,$2,$3)", [taskId, noteId, blockId]);
      }
      const noteSources = await client.query<{ note_id: string }>("SELECT note_id FROM stash_task_note_sources WHERE task_id = $1 ORDER BY note_id", [taskId]);
      const blockSources = await client.query<{ note_id: string; block_id: string }>(
        "SELECT note_id, block_id FROM stash_task_block_sources WHERE task_id = $1 ORDER BY note_id, block_id", [taskId]);
      const task: PortableTaskProjection = { schema: "stash.task.v1", id: taskId, workspaceId: taskRow.workspace_id,
        projectId: taskRow.project_id, title: taskRow.title, key: taskRow.task_key,
        status: { id: taskRow.workflow_status_id, name: taskRow.status_name, category: taskRow.category },
        sourceNoteIds: noteSources.rows.map((row) => row.note_id),
        sourceBlocks: blockSources.rows.map((row) => ({ noteId: row.note_id, blockId: row.block_id })),
        createdAt: new Date(taskRow.created_at).toISOString(),
        createdBy: { localAccountId: taskRow.created_by_account_id, displayName: taskRow.created_by_name } };
      if (!existing.rowCount) await this.#recordPortableProjection(client, "Task", task.id, task.schema, task);
      return { status: existing.rowCount ? "already_linked" as const : "linked" as const, task, sourceBlock };
    });
  }

  async listTaskSourceBlocks(memberId: string, taskId: string) {
    const client = await this.#pool.connect();
    try {
      await this.#ensureNoteSchema(client);
      const result = await client.query<any>(`SELECT source.note_id, source.block_id, note.document
        FROM stash_tasks task JOIN stash_workspaces workspace ON workspace.id = task.workspace_id
        LEFT JOIN stash_task_block_sources source ON source.task_id = task.id
        LEFT JOIN stash_notes note ON note.id = source.note_id
        WHERE task.id = $1 AND ((workspace.owner_type = 'personal' AND workspace.personal_owner_id = $2)
        OR (workspace.owner_type = 'organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
          WHERE membership.organization_id = workspace.organization_owner_id AND membership.account_id = $2)))
        ORDER BY source.note_id NULLS FIRST, source.block_id NULLS FIRST`, [taskId, memberId]);
      if (!result.rowCount) return { status: "task_not_found" as const };
      return { status: "found" as const, sourceBlocks: result.rows.filter((row: any) => row.note_id !== null).map((row: any) => {
        const matches = Array.isArray(row.document?.blocks) ? row.document.blocks.filter((block: any) => block.id === row.block_id).length : 0;
        return { noteId: row.note_id, blockId: row.block_id,
          state: matches === 1 ? "linked" as const : matches > 1 ? "ambiguous" as const : "broken" as const };
      }) };
    } finally { client.release(); }
  }

  async findTaskByKey(memberId: string, projectId: string, taskKey: string) {
    const client = await this.#pool.connect();
    try {
      await this.#ensureNoteSchema(client);
      await this.#ensureInvitationSchema(client);
      const result = await client.query<any>(taskPlanningSelect, [projectId, taskKey, memberId]);
      const row = result.rows[0];
      return row ? { status: "found" as const, task: taskPlanningReadModelFromRow(row) } : { status: "not_found" as const };
    } finally { client.release(); }
  }

  async findWorkflow(memberId: string, projectId: string) {
    return this.#withTransaction(async (client) => {
      await this.#ensureNoteSchema(client);
      await this.#ensureInvitationSchema(client);
      const access = await this.#findProjectWorkflowAccess(client, memberId, projectId, true);
      if (access !== "member") return { status: access };
      await this.#ensureDefaultWorkflow(client, projectId);
      return { status: "found" as const, workflow: await this.#loadWorkflow(client, projectId) };
    });
  }

  async replaceWorkflow(memberId: string, projectId: string, expectedRevision: number, statuses: WorkflowStatus[], newStatusIds: ReadonlySet<string>) {
    return this.#withTransaction(async (client) => {
      await this.#ensureNoteSchema(client);
      await this.#ensureInvitationSchema(client);
      const access = await this.#findProjectWorkflowAccess(client, memberId, projectId, true);
      if (access !== "member") return { status: access };
      await this.#ensureDefaultWorkflow(client, projectId);
      const currentRevision = await client.query<{ workflow_revision: number }>(
        "SELECT workflow_revision FROM stash_projects WHERE id = $1", [projectId]);
      if (currentRevision.rows[0]!.workflow_revision !== expectedRevision) return { status: "stale_status" as const };
      const current = await client.query<{ id: string }>(
        "SELECT id FROM stash_workflow_statuses WHERE project_id = $1 ORDER BY position FOR UPDATE", [projectId]);
      const currentIds = new Set(current.rows.map(({ id }) => id));
      if (statuses.filter(({ id }) => currentIds.has(id)).length !== currentIds.size
        || statuses.some(({ id }) => !currentIds.has(id) && !newStatusIds.has(id)))
        return { status: "stale_status" as const };
      const currentWorkflow = await this.#loadWorkflow(client, projectId);
      if (JSON.stringify(currentWorkflow.statuses) === JSON.stringify(statuses))
        return { status: "updated" as const, workflow: currentWorkflow };
      const previousStatuses = new Map(currentWorkflow.statuses.map((status) => [status.id, status]));
      const taskVisibleStatusChanges = statuses.filter((status) => { const previous = previousStatuses.get(status.id);
        return previous && (previous.name !== status.name || previous.category !== status.category || previous.archived !== status.archived); }).map(({ id }) => id);
      const collision = await client.query("SELECT 1 FROM stash_workflow_statuses WHERE id = ANY($1::uuid[]) AND project_id <> $2 LIMIT 1",
        [statuses.map(({ id }) => id), projectId]);
      if (collision.rowCount) return { status: "stale_status" as const };
      await client.query(workflowTemporaryRenameSql, [projectId]);
      for (const status of statuses) {
        await client.query(`INSERT INTO stash_workflow_statuses (id, project_id, name, category, position, archived)
          VALUES ($1,$2,$3,$4,$5,$6)
          ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, category = EXCLUDED.category,
            position = EXCLUDED.position, archived = EXCLUDED.archived
          WHERE stash_workflow_statuses.project_id = EXCLUDED.project_id`,
        [status.id, projectId, status.name, status.category, status.position, status.archived]);
      }
      await client.query("UPDATE stash_projects SET workflow_revision = workflow_revision + 1 WHERE id = $1", [projectId]);
      if (taskVisibleStatusChanges.length) {
        const assigned = await client.query<{ id: string }>(`SELECT id FROM stash_tasks WHERE project_id=$1 AND workflow_status_id=ANY($2::uuid[])
          ORDER BY id FOR UPDATE`, [projectId, taskVisibleStatusChanges]);
        for (const { id } of assigned.rows) await client.query(`UPDATE stash_tasks SET revision=revision+1,
          field_revisions=jsonb_set(field_revisions,'{statusId}',to_jsonb(revision+1),true) WHERE id=$1`, [id]);
      }
      const workflow = await this.#loadWorkflow(client, projectId);
      await this.#recordPortableProjection(client, "Workflow", projectId, "stash.workflow.v1", workflow);
      const affectedTasks = await client.query<{ id: string }>("SELECT id FROM stash_tasks WHERE project_id = $1 ORDER BY id", [projectId]);
      for (const { id } of affectedTasks.rows) {
        const taskRow = await client.query<any>(taskPlanningSelectById, [id, memberId]);
        if (taskRow.rows[0]) {
          const projection = taskProjectionFromRow(taskRow.rows[0]);
          await this.#recordPortableProjection(client, "Task", projection.id, projection.schema, projection);
        }
      }
      return { status: "updated" as const, workflow };
    });
  }

  async #findProjectWorkflowAccess(client: PoolClient, memberId: string, projectId: string, lock = false): Promise<"member" | "forbidden" | "not_found"> {
    const result = await client.query<{ member: boolean; guest: boolean }>(`SELECT
      ((workspace.owner_type = 'personal' AND workspace.personal_owner_id = $2)
        OR (workspace.owner_type = 'organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
          WHERE membership.organization_id = workspace.organization_owner_id AND membership.account_id = $2))) AS member,
      EXISTS (SELECT 1 FROM stash_project_guests guest WHERE guest.project_id = project.id AND guest.account_id = $2) AS guest
      FROM stash_projects project
      JOIN stash_workspaces workspace ON workspace.id = project.workspace_id
      WHERE project.id = $1
      ${lock ? "FOR UPDATE OF project" : ""}`, [projectId, memberId]);
    const row = result.rows[0];
    return !row ? "not_found" : row.member ? "member" : row.guest ? "forbidden" : "not_found";
  }

  async #loadWorkflow(client: PoolClient, projectId: string): Promise<ProjectWorkflow> {
    const project = await client.query<{ workflow_revision: number }>("SELECT workflow_revision FROM stash_projects WHERE id = $1", [projectId]);
    const statuses = await client.query<{ id: string; name: string; category: WorkflowStatus["category"]; position: number; archived: boolean }>(
      "SELECT id, name, category, position, archived FROM stash_workflow_statuses WHERE project_id = $1 ORDER BY position, id", [projectId]);
    return { schema: "stash.workflow.v1", projectId, revision: project.rows[0]!.workflow_revision, statuses: statuses.rows };
  }

  async listBoards(memberId: string, projectId: string) {
    const client = await this.#pool.connect();
    try {
      await this.#ensureBoardSchema(client); await this.#ensureInvitationSchema(client);
      if (await this.#findProjectWorkflowAccess(client, memberId, projectId) === "not_found") return { status: "not_found" as const };
      const result = await client.query<any>("SELECT id, project_id, name, group_by, created_at FROM stash_boards WHERE project_id = $1 ORDER BY created_at, id", [projectId]);
      return { status: "found" as const, boards: result.rows.map(boardFromRow) };
    } finally { client.release(); }
  }

  async createBoard(memberId: string, board: Board) {
    return this.#withTransaction(async (client) => {
      await this.#ensureBoardSchema(client); await this.#ensureInvitationSchema(client);
      const access = await this.#findProjectWorkflowAccess(client, memberId, board.projectId, true);
      if (access !== "member") return { status: access };
      await client.query("INSERT INTO stash_boards (id, project_id, name, group_by, created_at) VALUES ($1,$2,$3,$4,$5)", [board.id, board.projectId, board.name, board.groupBy, board.createdAt]);
      await this.#recordPortableProjection(client, "Board", board.id, board.schema, board);
      return { status: "created" as const, board };
    });
  }

  async readBoard(memberId: string, projectId: string, boardId: string) {
    const client = await this.#pool.connect();
    try {
      await this.#ensureBoardSchema(client); await this.#ensureInvitationSchema(client);
      if (await this.#findProjectWorkflowAccess(client, memberId, projectId) === "not_found") return { status: "not_found" as const };
      const found = await client.query<any>("SELECT id, project_id, name, group_by, created_at FROM stash_boards WHERE id = $1 AND project_id = $2", [boardId, projectId]);
      if (!found.rowCount) return { status: "not_found" as const };
      const rows = await client.query<any>(`SELECT task.id, task.task_key, task.title, task.assignee_ids, task.priority, task.label_names,
        status.id AS status_id, status.name AS status_name, status.category FROM stash_tasks task
        JOIN stash_workflow_statuses status ON status.id = task.workflow_status_id WHERE task.project_id = $1 ORDER BY task.task_key, task.id`, [projectId]);
      const tasks: BoardTask[] = rows.rows.map((row: any) => ({ id: row.id, key: row.task_key, title: row.title,
        status: { id: row.status_id, name: row.status_name, category: row.category }, assigneeIds: row.assignee_ids, priority: row.priority, labelNames: row.label_names }));
      return { status: "found" as const, board: boardFromRow(found.rows[0]), tasks, statuses: (await this.#loadWorkflow(client, projectId)).statuses };
    } finally { client.release(); }
  }

  async moveTaskOnBoard(memberId: string, projectId: string, boardId: string, taskKey: string, statusId: string) {
    return this.#withTransaction(async (client) => {
      await this.#ensureBoardSchema(client); await this.#ensureInvitationSchema(client);
      const access = await this.#findProjectWorkflowAccess(client, memberId, projectId, true);
      if (access !== "member") return { status: access };
      const board = await client.query<{ group_by: string }>("SELECT group_by FROM stash_boards WHERE id = $1 AND project_id = $2", [boardId, projectId]);
      if (!board.rowCount) return { status: "not_found" as const };
      if (board.rows[0]!.group_by !== "status") return { status: "unsupported_group" as const };
      const status = await client.query<any>("SELECT id, name, category FROM stash_workflow_statuses WHERE id = $1 AND project_id = $2 AND archived = FALSE", [statusId, projectId]);
      if (!status.rowCount) return { status: "invalid_status" as const };
      const beforeResult = await client.query<any>(taskPlanningSelect, [projectId, taskKey, memberId]);
      if (!beforeResult.rows[0]) return { status: "not_found" as const };
      const before = taskPlanningReadModelFromRow(beforeResult.rows[0]);
      const changed = await client.query<any>(`UPDATE stash_tasks SET workflow_status_id = $3, revision = revision + 1,
        field_revisions = jsonb_set(field_revisions, '{statusId}', to_jsonb(revision + 1), true) WHERE project_id = $1 AND task_key = $2
        RETURNING id, task_key, title, assignee_ids, priority, label_names`, [projectId, taskKey, statusId]);
      if (!changed.rowCount) return { status: "not_found" as const };
      const row = changed.rows[0]; const task: BoardTask = { id: row.id, key: row.task_key, title: row.title,
        status: status.rows[0], assigneeIds: row.assignee_ids, priority: row.priority, labelNames: row.label_names };
      const projection = await client.query<any>(taskPlanningSelectById, [task.id, memberId]);
      if (projection.rows[0]) {
        const after = taskPlanningReadModelFromRow(projection.rows[0]);
        await this.#recordPortableProjection(client, "Task", task.id, "stash.task.v1", taskProjectionFromRow(projection.rows[0]));
        await this.#recordTaskActivity(client, memberId, before.workspaceId, task.id, "task_status_changed", before, after);
      }
      return { status: "moved" as const, task };
    });
  }

  async updateTaskByKey(memberId: string, projectId: string, taskKey: string, update: TaskPlanningUpdate) {
    return this.#withTransaction(async (client) => {
      await this.#ensureNoteSchema(client);
      await this.#ensureInvitationSchema(client);
      const writable = await client.query<{ workspace_id: string }>(`SELECT workspace.id AS workspace_id FROM stash_projects project
        JOIN stash_workspaces workspace ON workspace.id = project.workspace_id
        WHERE project.id = $1 AND ((workspace.owner_type = 'personal' AND workspace.personal_owner_id = $2)
          OR (workspace.owner_type = 'organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
            WHERE membership.organization_id = workspace.organization_owner_id AND membership.account_id = $2))) FOR UPDATE OF project`, [projectId, memberId]);
      if (!writable.rowCount) return { status: "not_found" as const };
      if (update.dependencies !== undefined) await client.query("SELECT pg_advisory_xact_lock(hashtext('stash-task-dependencies'),hashtext($1))", [writable.rows[0]!.workspace_id]);
      const current = await client.query<any>(`${taskPlanningSelect} FOR UPDATE OF task`, [projectId, taskKey, memberId]);
      const row = current.rows[0];
      if (!row) return { status: "not_found" as const };
      if (update.statusId) {
        const status = await client.query("SELECT 1 FROM stash_workflow_statuses WHERE id = $1 AND project_id = $2 AND archived = FALSE", [update.statusId, projectId]);
        if (!status.rowCount) return { status: "invalid_reference" as const };
      }
      if (update.assigneeIds) {
        const assignees = await client.query<{ id: string }>(`SELECT account.id FROM stash_accounts account
          JOIN stash_workspaces workspace ON workspace.id = $2
          WHERE account.id = ANY($1::uuid[]) AND ((workspace.owner_type = 'personal' AND workspace.personal_owner_id = account.id)
          OR (workspace.owner_type = 'organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
            WHERE membership.organization_id = workspace.organization_owner_id AND membership.account_id = account.id)))`, [update.assigneeIds, row.workspace_id]);
        if (assignees.rowCount !== new Set(update.assigneeIds).size) return { status: "invalid_reference" as const };
      }
      for (const noteId of update.linkedNoteIds ?? []) {
        const note = await client.query("SELECT 1 FROM stash_notes WHERE id = $1 AND workspace_id = $2", [noteId, row.workspace_id]);
        if (!note.rowCount) return { status: "invalid_reference" as const };
      }
      if (update.dependencies !== undefined) {
        const graphRows = await client.query<{ id: string }>(
          "SELECT id FROM stash_tasks WHERE workspace_id = $1 ORDER BY id FOR UPDATE", [row.workspace_id]);
        const taskIds = new Set(graphRows.rows.map((task) => task.id));
        if (update.dependencies.some((dependency) => dependency.taskId === row.id || !taskIds.has(dependency.taskId)))
          return { status: "invalid_reference" as const };
        const stored = await client.query<{ dependent_task_id: string; prerequisite_task_id: string }>(
          `SELECT edge.dependent_task_id, edge.prerequisite_task_id FROM stash_task_dependencies edge
           JOIN stash_tasks dependent ON dependent.id = edge.dependent_task_id
           WHERE dependent.workspace_id = $1`, [row.workspace_id]);
        const previousIncident = stored.rows.filter((edge) => edge.dependent_task_id === row.id || edge.prerequisite_task_id === row.id);
        const retained = stored.rows.filter((edge) => edge.dependent_task_id !== row.id && edge.prerequisite_task_id !== row.id);
        const proposed = update.dependencies.map((dependency) => dependency.type === "depends_on"
          ? { dependent_task_id: row.id, prerequisite_task_id: dependency.taskId }
          : { dependent_task_id: dependency.taskId, prerequisite_task_id: row.id });
        const uniqueProposed = [...new Map(proposed.map((edge) => [`${edge.dependent_task_id}:${edge.prerequisite_task_id}`, edge])).values()];
        if (hasDependencyCycle(taskIds, [...retained, ...uniqueProposed])) return { status: "invalid_reference" as const };
        await client.query("DELETE FROM stash_task_dependencies WHERE dependent_task_id = $1 OR prerequisite_task_id = $1", [row.id]);
        for (const edge of uniqueProposed) await client.query(
          "INSERT INTO stash_task_dependencies (dependent_task_id, prerequisite_task_id) VALUES ($1,$2)",
          [edge.dependent_task_id, edge.prerequisite_task_id]);
        row.affected_dependency_task_ids = [...new Set([...previousIncident, ...uniqueProposed]
          .flatMap((edge) => [edge.dependent_task_id, edge.prerequisite_task_id]))];
      }
      const next = { ...taskProjectionFromRow(row), ...update } as PortableTaskProjection & { statusId?: string };
      if (update.statusId) {
        const status = await client.query<any>("SELECT id, name, category FROM stash_workflow_statuses WHERE id = $1", [update.statusId]);
        next.status = status.rows[0];
      }
      delete next.statusId;
      const nextRevision = Number(row.revision) + 1;
      const nextFieldRevisions = { ...(row.field_revisions ?? {}) };
      for (const field of Object.keys(update)) nextFieldRevisions[field] = nextRevision;
      const nextAssigneeIds = [...new Set(next.assigneeIds ?? [])];
      const nextFormerAssigneeIds = formerAssignmentsAfterUpdate(
        row.former_assignee_ids ?? [], nextAssigneeIds, update.assigneeIds !== undefined,
      );
      await client.query(`UPDATE stash_tasks SET title = $2, workflow_status_id = $3, assignee_ids = $4::jsonb, priority = $5,
        label_names = $6::jsonb, due_date = $7, estimate = $8, linked_note_ids = $9::jsonb,
        development_links = $10::jsonb, revision = $11, field_revisions = $12::jsonb,
        former_assignee_ids = $13::jsonb WHERE id = $1`, [row.id, next.title.trim(), next.status.id,
        JSON.stringify(nextAssigneeIds), next.priority ?? "none",
        JSON.stringify([...new Set((next.labelNames ?? []).map((label) => label.trim()))]), next.dueDate ?? null, next.estimate ?? null,
        JSON.stringify([...new Set(next.linkedNoteIds ?? [])]), JSON.stringify(next.developmentLinks ?? []), nextRevision,
        JSON.stringify(nextFieldRevisions), JSON.stringify(nextFormerAssigneeIds)]);
      const saved = await client.query<any>(taskPlanningSelect, [projectId, taskKey, memberId]);
      const task = taskPlanningReadModelFromRow(saved.rows[0]);
      await this.#recordPortableProjection(client, "Task", task.id, task.schema, taskProjectionFromRow(saved.rows[0]));
      const beforeTask = taskPlanningReadModelFromRow(row);
      const activity = await this.#recordTaskActivity(client, memberId, task.workspaceId, task.id, "task_planning_updated", beforeTask, task);
      await this.#recordAssignmentNotifications(client, projectId, activity, beforeTask, task);
      for (const affectedId of (row.affected_dependency_task_ids ?? []).filter((id: string) => id !== task.id)) {
        const affectedBefore = await client.query<any>(taskPlanningSelectById, [affectedId, memberId]);
        await client.query(`UPDATE stash_tasks SET revision=revision+1,
          field_revisions=jsonb_set(field_revisions,'{dependencies}',to_jsonb(revision+1),true) WHERE id=$1`, [affectedId]);
        const affected = await client.query<any>(taskPlanningSelectById, [affectedId, memberId]);
        if (affected.rows[0]) {
          const projection = taskProjectionFromRow(affected.rows[0]);
          await this.#recordPortableProjection(client, "Task", projection.id, projection.schema, projection);
          if (affectedBefore.rows[0]) await this.#recordTaskActivity(client, memberId, task.workspaceId, affectedId,
            "task_dependency_relationship_updated", taskPlanningReadModelFromRow(affectedBefore.rows[0]),
            taskPlanningReadModelFromRow(affected.rows[0]));
        }
      }
      return { status: "updated" as const, task };
    });
  }

  async applyStructuredTaskEdit(memberId: string, projectId: string, taskKey: string, batch: TaskEditBatch) {
    return this.#withTransaction(async (client) => {
      await this.#ensureNoteSchema(client); await this.#ensureInvitationSchema(client);
      const writable = await client.query<{ workspace_id: string }>(`SELECT workspace.id AS workspace_id FROM stash_projects project JOIN stash_workspaces workspace ON workspace.id = project.workspace_id
        WHERE project.id = $1 AND ((workspace.owner_type = 'personal' AND workspace.personal_owner_id = $2) OR
        (workspace.owner_type = 'organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
          WHERE membership.organization_id = workspace.organization_owner_id AND membership.account_id = $2))) FOR UPDATE OF project`, [projectId, memberId]);
      if (!writable.rowCount) return { status: "not_found" as const };
      if (batch.changes.dependencies !== undefined) await client.query("SELECT pg_advisory_xact_lock(hashtext('stash-task-dependencies'),hashtext($1))", [writable.rows[0]!.workspace_id]);
      const current = await client.query<any>(`${taskPlanningSelect} FOR UPDATE OF task`, [projectId, taskKey, memberId]);
      const row = current.rows[0]; if (!row) return { status: "not_found" as const };
      const beforeTask = taskPlanningReadModelFromRow(row);
      if (batch.baseRevision > Number(row.revision)) return { status: "invalid_revision" as const };
      const digest = taskEditDigest(batch);
      const prior = await client.query<{ digest: string; outcome: any }>(
        "SELECT digest, outcome FROM stash_task_edit_operations WHERE task_id = $1 AND operation_id = $2", [row.id, batch.operationId]);
      if (prior.rows[0]) return prior.rows[0].digest === digest ? prior.rows[0].outcome : { status: "operation_identity_conflict" as const };
      const fields = Object.keys(batch.changes);
      const forcedConflicts = new Set<string>();
      if (batch.changes.statusId) {
        const status = await client.query<{ archived: boolean }>(
          "SELECT archived FROM stash_workflow_statuses WHERE id=$1 AND project_id=$2 FOR UPDATE", [batch.changes.statusId, projectId]);
        if (!status.rows[0]) return { status: "invalid_reference" as const };
        if (status.rows[0].archived) forcedConflicts.add("statusId");
      }
      const incompatible = fields.filter((field) => forcedConflicts.has(field) || Number(row.field_revisions?.[field] ?? 0) > batch.baseRevision);
      const compatible = Object.fromEntries(Object.entries(batch.changes).filter(([field]) => !incompatible.includes(field))) as TaskPlanningUpdate;
      if (Object.keys(compatible).length) {
        const applied = await this.#applyStructuredTaskChanges(client, memberId, row, compatible);
        if (!applied) return { status: "invalid_reference" as const };
        row.revision += 1; row.field_revisions = { ...(row.field_revisions ?? {}) };
        for (const field of Object.keys(compatible)) row.field_revisions[field] = row.revision;
        await client.query("UPDATE stash_tasks SET revision = $2, field_revisions = $3::jsonb WHERE id = $1",
          [row.id, row.revision, JSON.stringify(row.field_revisions)]);
      }
      let outcome: any;
      if (incompatible.length) {
        const conflictId = randomUUID();
        const contribution = Object.fromEntries(incompatible.map((field) => [field, (batch.changes as Record<string, unknown>)[field]]));
        const conflict: TaskEditConflict = { id: conflictId, taskId: row.id, baseRevision: batch.baseRevision,
          currentRevision: row.revision, fields: incompatible, contribution, createdAt: batch.createdAt,
          createdBy: { displayName: batch.createdBy.displayName, attribution: "recorded" } };
        await client.query(`INSERT INTO stash_task_edit_conflicts
          (id,task_id,base_revision,current_revision,fields,contribution,created_by_account_id,created_by_display_name,created_at)
          VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9)`, [conflictId, row.id, batch.baseRevision, row.revision,
          JSON.stringify(incompatible), JSON.stringify(contribution), memberId, batch.createdBy.displayName, batch.createdAt]);
        outcome = { status: "conflict_preserved", conflict };
      } else {
        const saved = await client.query<any>(taskPlanningSelect, [projectId, taskKey, memberId]);
        const task = taskPlanningReadModelFromRow(saved.rows[0]);
        await this.#recordPortableProjection(client, "Task", task.id, task.schema, taskProjectionFromRow(saved.rows[0]));
        outcome = { status: "applied", task, revision: row.revision, appliedFields: fields };
      }
      if (Object.keys(compatible).length && incompatible.length) {
        const saved = await client.query<any>(taskPlanningSelect, [projectId, taskKey, memberId]);
        await this.#recordPortableProjection(client, "Task", row.id, "stash.task.v1", taskProjectionFromRow(saved.rows[0]));
      }
      if (Object.keys(compatible).length) {
        const saved = await client.query<any>(taskPlanningSelectById, [row.id, memberId]);
        if (saved.rows[0]) {
          const afterTask = taskPlanningReadModelFromRow(saved.rows[0]);
          const activity = await this.#recordTaskActivity(client, memberId, row.workspace_id, row.id,
            "task_structured_edit_applied", beforeTask, afterTask);
          await this.#recordAssignmentNotifications(client, projectId, activity, beforeTask, afterTask);
        }
      }
      await client.query("INSERT INTO stash_task_edit_operations (task_id,operation_id,digest,outcome) VALUES ($1,$2,$3,$4::jsonb)",
        [row.id, batch.operationId, digest, JSON.stringify(outcome)]);
      return outcome;
    });
  }

  async listStructuredTaskConflicts(memberId: string, projectId: string, taskKey: string) {
    const client = await this.#pool.connect();
    try {
      await this.#ensureNoteSchema(client); await this.#ensureInvitationSchema(client);
      const writable = await client.query(`SELECT 1 FROM stash_projects project JOIN stash_workspaces workspace ON workspace.id=project.workspace_id
        WHERE project.id=$1 AND ((workspace.owner_type='personal' AND workspace.personal_owner_id=$2) OR
        (workspace.owner_type='organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
          WHERE membership.organization_id=workspace.organization_owner_id AND membership.account_id=$2)))`, [projectId,memberId]);
      if (!writable.rowCount) return { status: "not_found" as const };
      const task = await client.query<any>(taskPlanningSelect, [projectId, taskKey, memberId]);
      if (!task.rows[0]) return { status: "not_found" as const };
      const rows = await client.query<any>(`SELECT conflict.* FROM stash_task_edit_conflicts conflict
        WHERE conflict.task_id = $1 AND conflict.resolved_at IS NULL ORDER BY conflict.created_at, conflict.id`, [task.rows[0].id]);
      return { status: "found" as const, revision: task.rows[0].revision, conflicts: rows.rows.map(taskConflictFromRow) };
    } finally { client.release(); }
  }

  async resolveStructuredTaskConflict(memberId: string, projectId: string, taskKey: string, conflictId: string,
    resolution: "keep_current" | "apply_contribution", expectedRevision: number) {
    return this.#withTransaction(async (client) => {
      await this.#ensureNoteSchema(client); await this.#ensureInvitationSchema(client);
      const writable = await client.query<{ workspace_id: string }>(`SELECT workspace.id AS workspace_id FROM stash_projects project JOIN stash_workspaces workspace ON workspace.id = project.workspace_id
        WHERE project.id = $1 AND ((workspace.owner_type = 'personal' AND workspace.personal_owner_id = $2) OR
        (workspace.owner_type = 'organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
          WHERE membership.organization_id = workspace.organization_owner_id AND membership.account_id = $2))) FOR UPDATE OF project`, [projectId, memberId]);
      if (!writable.rowCount) return { status: "not_found" as const };
      await client.query("SELECT pg_advisory_xact_lock(hashtext('stash-task-dependencies'),hashtext($1))", [writable.rows[0]!.workspace_id]);
      const taskResult = await client.query<any>(`${taskPlanningSelect} FOR UPDATE OF task`, [projectId, taskKey, memberId]);
      const row = taskResult.rows[0]; if (!row) return { status: "not_found" as const };
      const found = await client.query<any>(`SELECT conflict.* FROM stash_task_edit_conflicts conflict
        WHERE conflict.id = $1 AND conflict.task_id = $2 FOR UPDATE OF conflict`, [conflictId, row.id]);
      const conflictRow = found.rows[0]; if (!conflictRow) return { status: "conflict_not_found" as const };
      if (conflictRow.resolved_at) return { status: "already_resolved" as const };
      if (row.revision !== expectedRevision) return { status: "conflict_changed" as const, conflict: { ...taskConflictFromRow(conflictRow), currentRevision: row.revision } };
      const before = taskProjectionFromRow(row);
      if (resolution === "apply_contribution") {
        if (!await this.#applyStructuredTaskChanges(client, memberId, row, conflictRow.contribution)) return { status: "invalid_reference" as const };
        row.revision += 1; row.field_revisions = { ...(row.field_revisions ?? {}) };
        for (const field of conflictRow.fields) row.field_revisions[field] = row.revision;
        await client.query("UPDATE stash_tasks SET revision = $2, field_revisions = $3::jsonb WHERE id = $1",
          [row.id, row.revision, JSON.stringify(row.field_revisions)]);
      }
      const occurredAt = new Date().toISOString();
      await client.query("UPDATE stash_task_edit_conflicts SET resolved_at = $2, resolution = $3 WHERE id = $1", [conflictId, occurredAt, resolution]);
      const saved = await client.query<any>(taskPlanningSelect, [projectId, taskKey, memberId]); const task = taskPlanningReadModelFromRow(saved.rows[0]);
      const actor = await client.query<{ name: string }>("SELECT name FROM stash_accounts WHERE id = $1", [memberId]);
      const activity = { schema: "stash.activity.v1" as const, id: randomUUID(), workspaceId: task.workspaceId,
        action: "task_edit_conflict_resolved", object: { kind: "Task" as const, id: task.id },
        actor: { localAccountId: memberId, displayName: actor.rows[0]!.name }, cause: { kind: "member" as const }, occurredAt,
        before: { task: before, conflictId }, after: { task: taskProjectionFromRow(saved.rows[0]), resolution } };
      await client.query(`INSERT INTO stash_workspace_activity
        (id,workspace_id,object_kind,object_id,action,actor_account_id,cause,occurred_at,before_state,after_state)
        VALUES ($1,$2,'Task',$3,$4,$5,'member',$6,$7::jsonb,$8::jsonb)`, [activity.id, activity.workspaceId, task.id,
        activity.action, memberId, occurredAt, JSON.stringify(activity.before), JSON.stringify(activity.after)]);
      await this.#recordPortableProjection(client, "Task", task.id, task.schema, taskProjectionFromRow(saved.rows[0]));
      await this.#recordPortableProjection(client, "Activity", activity.id, activity.schema, activity);
      await this.#recordProjectActivityNotifications(client, activity);
      if (resolution === "apply_contribution") await this.#recordAssignmentNotifications(client, projectId, activity, before, task);
      return { status: "resolved" as const, task, revision: row.revision, activity };
    });
  }

  async #applyStructuredTaskChanges(client: PoolClient, memberId: string, row: any, update: TaskPlanningUpdate): Promise<boolean> {
    if (update.statusId) { const status = await client.query("SELECT 1 FROM stash_workflow_statuses WHERE id=$1 AND project_id=$2 AND archived=FALSE FOR UPDATE", [update.statusId, row.project_id]); if (!status.rowCount) return false; }
    if (update.assigneeIds) { const result = await client.query(`SELECT account.id FROM stash_accounts account JOIN stash_workspaces workspace ON workspace.id=$2
      WHERE account.id=ANY($1::uuid[]) AND ((workspace.owner_type='personal' AND workspace.personal_owner_id=account.id) OR
      (workspace.owner_type='organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership WHERE membership.organization_id=workspace.organization_owner_id AND membership.account_id=account.id)))`, [update.assigneeIds,row.workspace_id]); if (result.rowCount !== new Set(update.assigneeIds).size) return false; }
    for (const noteId of update.linkedNoteIds ?? []) { const note = await client.query("SELECT 1 FROM stash_notes WHERE id=$1 AND workspace_id=$2", [noteId,row.workspace_id]); if (!note.rowCount) return false; }
    if (update.dependencies !== undefined) {
      const all = await client.query<{id:string}>("SELECT id FROM stash_tasks WHERE workspace_id=$1 ORDER BY id FOR UPDATE", [row.workspace_id]); const ids = new Set(all.rows.map(({id})=>id));
      if (update.dependencies.some(({taskId})=>taskId===row.id || !ids.has(taskId))) return false;
      const stored = await client.query<{dependent_task_id:string;prerequisite_task_id:string}>(`SELECT edge.dependent_task_id,edge.prerequisite_task_id FROM stash_task_dependencies edge JOIN stash_tasks task ON task.id=edge.dependent_task_id WHERE task.workspace_id=$1`,[row.workspace_id]);
      const previous=stored.rows.filter((edge)=>edge.dependent_task_id===row.id||edge.prerequisite_task_id===row.id);
      const retained=stored.rows.filter((edge)=>edge.dependent_task_id!==row.id&&edge.prerequisite_task_id!==row.id);
      const proposed=update.dependencies.map((d)=>d.type==="depends_on"?{dependent_task_id:row.id,prerequisite_task_id:d.taskId}:{dependent_task_id:d.taskId,prerequisite_task_id:row.id});
      if (hasDependencyCycle(ids,[...retained,...proposed])) return false;
      await client.query("DELETE FROM stash_task_dependencies WHERE dependent_task_id=$1 OR prerequisite_task_id=$1",[row.id]);
      for(const edge of proposed) await client.query("INSERT INTO stash_task_dependencies (dependent_task_id,prerequisite_task_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",[edge.dependent_task_id,edge.prerequisite_task_id]);
      for (const affectedId of [...new Set([...previous,...proposed].flatMap((edge)=>[edge.dependent_task_id,edge.prerequisite_task_id]))].filter((id)=>id!==row.id)) {
        const beforeAffected=await client.query<any>(taskPlanningSelectById,[affectedId,memberId]);
        await client.query(`UPDATE stash_tasks SET revision=revision+1,
          field_revisions=jsonb_set(field_revisions,'{dependencies}',to_jsonb(revision+1),true) WHERE id=$1`,[affectedId]);
        const affected=await client.query<any>(taskPlanningSelectById,[affectedId,memberId]);
        if(affected.rows[0]) { const projection=taskProjectionFromRow(affected.rows[0]); await this.#recordPortableProjection(client,"Task",projection.id,projection.schema,projection);
          if(beforeAffected.rows[0]) await this.#recordTaskActivity(client,memberId,row.workspace_id,affectedId,
            "task_dependency_relationship_updated",taskPlanningReadModelFromRow(beforeAffected.rows[0]),taskPlanningReadModelFromRow(affected.rows[0])); }
      }
    }
    const current=taskProjectionFromRow(row); const next={...current,...update} as any;
    const nextAssigneeIds=[...new Set<string>(next.assigneeIds??[])];
    const nextFormerAssigneeIds=formerAssignmentsAfterUpdate(
      row.former_assignee_ids??[],nextAssigneeIds,update.assigneeIds!==undefined);
    await client.query(`UPDATE stash_tasks SET title=$2,workflow_status_id=$3,assignee_ids=$4::jsonb,priority=$5,label_names=$6::jsonb,
      due_date=$7,estimate=$8,linked_note_ids=$9::jsonb,development_links=$10::jsonb,
      former_assignee_ids=$11::jsonb WHERE id=$1`,[row.id,next.title,
      update.statusId??current.status.id,JSON.stringify(nextAssigneeIds),next.priority??"none",JSON.stringify(next.labelNames??[]),
      next.dueDate??null,next.estimate??null,JSON.stringify(next.linkedNoteIds??[]),JSON.stringify(next.developmentLinks??[]),
      JSON.stringify(nextFormerAssigneeIds)]);
    return true;
  }

  async moveTask(memberId: string, projectId: string, taskKey: string, destinationProjectId: string) {
    return this.#withTransaction(async (client) => {
      await this.#ensureNoteSchema(client);
      await this.#ensureInvitationSchema(client);
      await client.query("SELECT id FROM stash_projects WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE", [[projectId, destinationProjectId]]);
      const current = await client.query<any>(`${taskPlanningSelect} FOR UPDATE OF task`, [projectId, taskKey, memberId]);
      const row = current.rows[0];
      if (!row) return { status: "not_found" as const };
      if (row.project_id === destinationProjectId) return { status: "same_project" as const };
      const destination = await client.query<{ project_key: string; task_number: number }>(`UPDATE stash_projects project
        SET next_task_number = next_task_number + 1 FROM stash_workspaces workspace
        WHERE project.id = $1 AND workspace.id = project.workspace_id AND project.workspace_id = $2
          AND ((workspace.owner_type = 'personal' AND workspace.personal_owner_id = $3)
            OR (workspace.owner_type = 'organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
              WHERE membership.organization_id = workspace.organization_owner_id AND membership.account_id = $3)))
        RETURNING project.project_key, project.next_task_number - 1 AS task_number`, [destinationProjectId, row.workspace_id, memberId]);
      if (!destination.rowCount) return { status: "destination_forbidden" as const };
      await this.#ensureDefaultWorkflow(client, destinationProjectId);
      const destinationStatus = initialWorkflowStatus(await this.#loadWorkflow(client, destinationProjectId));
      const nextKey = `${destination.rows[0]!.project_key}-${destination.rows[0]!.task_number}`;
      const before = { projectId: row.project_id, key: row.task_key,
        status: { id: row.workflow_status_id, name: row.status_name, category: row.status_category } };
      await client.query(`INSERT INTO stash_task_key_aliases (project_id, task_key, task_id, created_at)
        VALUES ($1,$2,$3,now())`, [row.project_id, row.task_key, row.id]);
      await client.query(`UPDATE stash_tasks SET project_id = $2, task_key = $3, workflow_status_id = $4, revision=revision+1,
        field_revisions=field_revisions || jsonb_build_object('projectId',revision+1,'key',revision+1,'statusId',revision+1) WHERE id = $1`,
        [row.id, destinationProjectId, nextKey, destinationStatus.id]);
      const saved = await client.query<any>(taskPlanningSelect, [destinationProjectId, nextKey, memberId]);
      const task = taskPlanningReadModelFromRow(saved.rows[0]);
      await this.#recordPortableProjection(client, "Task", task.id, task.schema, taskProjectionFromRow(saved.rows[0]));
      const actor = await client.query<{ name: string }>("SELECT name FROM stash_accounts WHERE id = $1", [memberId]);
      if (!actor.rows[0]) throw new Error("Task move actor identity is unavailable");
      const activity: TaskMoveActivity = { schema: "stash.activity.v1", id: randomUUID(), workspaceId: task.workspaceId,
        action: "task_moved", object: { kind: "Task", id: task.id },
        actor: { localAccountId: memberId, displayName: actor.rows[0].name }, cause: { kind: "member" },
        occurredAt: new Date().toISOString(), before,
        after: { projectId: task.projectId, key: task.key, status: task.status } };
      await client.query(`INSERT INTO stash_workspace_activity
        (id, workspace_id, object_kind, object_id, action, actor_account_id, cause, occurred_at, before_state, after_state)
        VALUES ($1,$2,'Task',$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)`, [activity.id, activity.workspaceId, task.id,
        activity.action, memberId, activity.cause.kind, activity.occurredAt, JSON.stringify(activity.before), JSON.stringify(activity.after)]);
      await this.#recordPortableProjection(client, "Activity", activity.id, activity.schema, activity);
      await this.#recordProjectActivityNotifications(client, activity);
      return { status: "moved" as const, task, activity };
    });
  }

  async #applyTriageChange(client: PoolClient, memberId: string, workspaceId: string, noteId: string, change: NoteTriageChange): Promise<
    { result: NoteTriageResult } | { status: "project_forbidden" | "target_note_not_found" }
  > {
    switch (change.kind) {
      case "organized": return this.#organizeInboxNote(client, memberId, workspaceId, noteId, change);
      case "archived": return this.#archiveInboxNote(client, memberId, workspaceId, noteId, change);
      case "linked": return this.#linkInboxNote(client, memberId, workspaceId, noteId, change);
      case "task_created": return this.#createTaskFromInbox(client, memberId, workspaceId, noteId, change);
    }
  }

  async #organizeInboxNote(client: PoolClient, memberId: string, workspaceId: string, noteId: string, change: Extract<NoteTriageChange, { kind: "organized" }>) {
    const project = await client.query("SELECT 1 FROM stash_projects WHERE id = $1 AND workspace_id = $2", [change.note.projectId, workspaceId]);
    if (!project.rowCount) return { status: "project_forbidden" as const };
    const before=await client.query<any>("SELECT project_id,tags FROM stash_notes WHERE id=$1",[noteId]);
    await client.query("UPDATE stash_notes SET project_id = $2, tags = $3::jsonb WHERE id = $1", [noteId, change.note.projectId, JSON.stringify(change.note.tags)]);
    await this.#recordDomainActivity(client,memberId,workspaceId,"Note",noteId,"note_organized",
      {projectId:before.rows[0]?.project_id??null,tags:before.rows[0]?.tags??[]},
      {projectId:change.note.projectId,tags:change.note.tags});
    return { result: change };
  }

  async #archiveInboxNote(client: PoolClient, memberId: string, workspaceId: string, noteId: string, change: Extract<NoteTriageChange, { kind: "archived" }>) {
    await client.query("UPDATE stash_notes SET archived_at = $2 WHERE id = $1", [noteId, change.note.archivedAt]);
    await this.#recordDomainActivity(client,memberId,workspaceId,"Note",noteId,"note_archived",{archivedAt:null},{archivedAt:change.note.archivedAt});
    return { result: change };
  }

  async #linkInboxNote(client: PoolClient, memberId: string, workspaceId: string, noteId: string, change: Extract<NoteTriageChange, { kind: "linked" }>) {
    const target = await client.query("SELECT 1 FROM stash_notes WHERE id = $1 AND workspace_id = $2", [change.link.targetNoteId, workspaceId]);
    if (!target.rowCount) return { status: "target_note_not_found" as const };
    await client.query("INSERT INTO stash_note_links (id, workspace_id, source_note_id, target_note_id) VALUES ($1, $2, $3, $4)",
      [change.link.id, workspaceId, noteId, change.link.targetNoteId]);
    await this.#recordDomainActivity(client,memberId,workspaceId,"NoteLink",change.link.id,"note_link_created",{},change.link);
    return { result: change };
  }

  async #createTaskFromInbox(client: PoolClient, memberId: string, workspaceId: string, noteId: string, change: Extract<NoteTriageChange, { kind: "task_created" }>) {
    const project = await client.query("SELECT 1 FROM stash_projects WHERE id = $1 AND workspace_id = $2", [change.task.projectId, workspaceId]);
    if (!project.rowCount) return { status: "project_forbidden" as const };
    const task = await this.#createTask(client, change.task);
    await client.query("INSERT INTO stash_tasks (id, workspace_id, project_id, task_key, workflow_status_id, title, created_by_account_id, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [task.id, workspaceId, task.projectId, task.key, task.status.id, task.title, memberId, task.createdAt]);
    await client.query("INSERT INTO stash_task_note_sources (task_id, note_id) VALUES ($1,$2)", [change.task.id, noteId]);
    await this.#recordDomainActivity(client,memberId,workspaceId,"Task",task.id,"task_created_from_inbox",{},task);
    return { result: { kind: "task_created" as const, task, projections: [task] as [PortableTaskProjection] } };
  }

  async #createTask(client: PoolClient, draft: TaskCreation): Promise<PortableTaskProjection> {
    await client.query("SELECT id FROM stash_projects WHERE id = $1 FOR UPDATE", [draft.projectId]);
    await this.#ensureDefaultWorkflow(client, draft.projectId);
    const workflowStatus = initialWorkflowStatus(await this.#loadWorkflow(client, draft.projectId));
    const allocation = await client.query<{ project_key: string; task_number: number }>(
      `UPDATE stash_projects SET next_task_number = next_task_number + 1 WHERE id = $1
       RETURNING project_key, next_task_number - 1 AS task_number`, [draft.projectId],
    );
    const key = allocation.rows[0];
    if (!key) throw new Error("task_project_unavailable");
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
    const initialized = await client.query(`UPDATE stash_projects SET workflow_revision = 1
      WHERE id = $1 AND workflow_revision = 0 RETURNING id`, [projectId]);
    if (initialized.rowCount) {
      const workflow = await this.#loadWorkflow(client, projectId);
      await this.#recordPortableProjection(client, "Workflow", projectId, workflow.schema, workflow);
    }
  }

  async findNoteForMember(memberId: string, noteId: string): Promise<NoteRecord | undefined> {
    await this.#ensureNoteSchemaForPool();
    if (await this.#authorizeNote(this.#pool, memberId, noteId) === "none") return undefined;
    const result = await this.#pool.query<{
      id: string; workspace_id: string; project_id: string | null; content: string; document: NoteRecord["document"];
      revision: number; tags: string[]; reminder_at: Date | null; created_by_account_id: string; created_at: Date;
    }>("SELECT * FROM stash_notes WHERE id=$1", [noteId]);
    const row = result.rows[0];
    return row ? {
      id: row.id, workspaceId: row.workspace_id, content: row.content, document: row.document, revision: row.revision,
      tags: row.tags, createdByMemberId: row.created_by_account_id, createdAt: row.created_at.toISOString(),
      ...(row.project_id ? { projectId: row.project_id } : {}),
      ...(row.reminder_at ? { reminder: { at: row.reminder_at.toISOString() } } : {}),
    } : undefined;
  }

  async moveNote(memberId: string, noteId: string, expectedRevision: number, path: string, _projection: PortableNoteLocationProjection) {
    return this.#withTransaction(async (client) => {
      await this.#ensureNoteSchema(client);
      const found = await client.query<any>(`SELECT note.id, note.workspace_id, note.portable_path, note.location_revision,
        ARRAY(SELECT alias.path FROM stash_note_path_aliases alias WHERE alias.note_id=note.id ORDER BY alias.created_at, alias.path) aliases
        FROM stash_notes note JOIN stash_workspaces workspace ON workspace.id=note.workspace_id WHERE note.id=$1 AND
        ((workspace.owner_type='personal' AND workspace.personal_owner_id=$2) OR EXISTS
          (SELECT 1 FROM stash_organization_memberships membership WHERE membership.organization_id=workspace.organization_owner_id AND membership.account_id=$2))
        FOR UPDATE OF note`, [noteId, memberId]);
      const row = found.rows[0]; if (!row) return { status: "not_found" as const };
      const current: NoteLocationRecord = { noteId: row.id, workspaceId: row.workspace_id, path: row.portable_path,
        aliases: row.aliases ?? [], revision: row.location_revision };
      if (current.revision !== expectedRevision) return { status: "changed" as const, location: current };
      if (path === current.path) return { status: "unchanged" as const, location: current };
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`note-path:${current.workspaceId}`]);
      const conflict = await client.query(`SELECT 1 FROM stash_notes WHERE workspace_id=$1 AND id<>$2 AND portable_path=$3
        UNION ALL SELECT 1 FROM stash_note_path_aliases WHERE workspace_id=$1 AND note_id<>$2 AND path=$3 LIMIT 1`, [current.workspaceId, noteId, path]);
      if (conflict.rowCount) return { status: "path_conflict" as const };
      if (path !== current.path) await client.query(`INSERT INTO stash_note_path_aliases(workspace_id,note_id,path) VALUES($1,$2,$3)
        ON CONFLICT(workspace_id,path) DO NOTHING`, [current.workspaceId, noteId, current.path]);
      await client.query("DELETE FROM stash_note_path_aliases WHERE workspace_id=$1 AND note_id=$2 AND path=$3", [current.workspaceId, noteId, path]);
      await client.query("UPDATE stash_notes SET portable_path=$2,location_revision=location_revision+1 WHERE id=$1", [noteId, path]);
      const location: NoteLocationRecord = { ...current, path,
        aliases: [...new Set([...current.aliases.filter((alias) => alias !== path), current.path])], revision: current.revision + 1 };
      const projection: PortableNoteLocationProjection = { schema: "stash.note-location.v1", ...location };
      await this.#recordPortableProjection(client, "NoteLocation", noteId, projection.schema, projection);
      await this.#recordDomainActivity(client,memberId,current.workspaceId,"NoteLocation",noteId,"note_moved",current,location);
      return { status: "moved" as const, location };
    });
  }

  async createNoteLink(memberId: string, link: NoteLinkRecord, _projection: PortableNoteLinkStateProjection) {
    return this.#withTransaction(async (client) => {
      await this.#ensureNoteSchema(client);
      const notes = await client.query<any>(`SELECT note.id,note.workspace_id,note.portable_path,
        ((workspace.owner_type='personal' AND workspace.personal_owner_id=$3) OR EXISTS
          (SELECT 1 FROM stash_organization_memberships membership WHERE membership.organization_id=workspace.organization_owner_id AND membership.account_id=$3)) accessible
        FROM stash_notes note JOIN stash_workspaces workspace ON workspace.id=note.workspace_id WHERE note.id IN($1,$2)`,
      [link.sourceNoteId, link.targetNoteId, memberId]);
      const source = notes.rows.find((row) => row.id === link.sourceNoteId && row.accessible);
      if (!source) return { status: "source_not_found" as const };
      const target = notes.rows.find((row) => row.id === link.targetNoteId && row.accessible && row.workspace_id === source.workspace_id);
      if (!target) return { status: "target_not_found" as const };
      const saved = { ...link, workspaceId: source.workspace_id };
      const inserted = await client.query(`INSERT INTO stash_note_links(id,workspace_id,source_note_id,target_note_id,target_path,label,revision)
        VALUES($1,$2,$3,$4,$5,$6,1) ON CONFLICT(source_note_id,target_note_id) DO NOTHING RETURNING id`,
      [saved.id, saved.workspaceId, saved.sourceNoteId, saved.targetNoteId, target.portable_path, saved.label]);
      if (!inserted.rowCount) return { status: "already_linked" as const };
      const projection: PortableNoteLinkStateProjection = { schema: "stash.note-link.v2", ...saved };
      await this.#recordPortableProjection(client, "NoteLink", saved.id, projection.schema, projection);
      await this.#recordDomainActivity(client,memberId,saved.workspaceId,"NoteLink",saved.id,"note_link_created",{},saved);
      return { status: "created" as const, link: saved };
    });
  }

  async createImportedNoteLink(memberId: string, link: NoteLinkRecord, _projection: PortableNoteLinkStateProjection) {
    return this.#withTransaction(async (client) => {
      await this.#ensureNoteSchema(client);
      const source = await client.query<any>(`SELECT note.workspace_id FROM stash_notes note JOIN stash_workspaces workspace ON workspace.id=note.workspace_id
        WHERE note.id=$1 AND ((workspace.owner_type='personal' AND workspace.personal_owner_id=$2) OR EXISTS
          (SELECT 1 FROM stash_organization_memberships membership WHERE membership.organization_id=workspace.organization_owner_id AND membership.account_id=$2))`,
      [link.sourceNoteId, memberId]);
      if (!source.rows[0]) return { status: "source_not_found" as const };
      const candidateIds = link.candidateNoteIds ?? [];
      const candidates = candidateIds.length ? await client.query<{ id: string }>(
        "SELECT id FROM stash_notes WHERE workspace_id=$1 AND id=ANY($2::uuid[]) ORDER BY id", [source.rows[0].workspace_id, candidateIds]) : { rows: [] };
      if (candidates.rows.length !== candidateIds.length) return { status: "candidate_not_found" as const };
      const saved: NoteLinkRecord = { ...link, workspaceId: source.rows[0].workspace_id };
      await client.query(`INSERT INTO stash_note_links(id,workspace_id,source_note_id,target_note_id,target_path,candidate_note_ids,label,revision)
        VALUES($1,$2,$3,NULL,$4,$5::uuid[],$6,1)`,
      [saved.id, saved.workspaceId, saved.sourceNoteId, saved.targetPath, candidateIds, saved.label]);
      const projection: PortableNoteLinkStateProjection = { schema: "stash.note-link.v2", ...saved };
      await this.#recordPortableProjection(client, "NoteLink", saved.id, projection.schema, projection);
      await this.#recordDomainActivity(client,memberId,saved.workspaceId,"NoteLink",saved.id,"note_link_imported",{},saved);
      return { status: "created" as const, link: saved };
    });
  }

  async listNoteLinks(memberId: string, sourceNoteId: string) {
    const client = await this.#pool.connect();
    try {
      await this.#ensureNoteSchema(client);
      const source = await client.query<any>(`SELECT note.workspace_id,note.portable_path,note.location_revision,
        ARRAY(SELECT alias.path FROM stash_note_path_aliases alias WHERE alias.note_id=note.id ORDER BY alias.created_at,alias.path) aliases
        FROM stash_notes note JOIN stash_workspaces workspace ON workspace.id=note.workspace_id
        WHERE note.id=$1 AND ((workspace.owner_type='personal' AND workspace.personal_owner_id=$2) OR EXISTS
          (SELECT 1 FROM stash_organization_memberships membership WHERE membership.organization_id=workspace.organization_owner_id AND membership.account_id=$2))`, [sourceNoteId, memberId]);
      if (!source.rows[0]) return { status: "not_found" as const };
      const rows = await client.query<any>(`SELECT link.*,target.portable_path,target.location_revision,
        ARRAY(SELECT alias.path FROM stash_note_path_aliases alias WHERE alias.note_id=target.id ORDER BY alias.created_at,alias.path) aliases
        FROM stash_note_links link LEFT JOIN stash_notes target ON target.id=link.target_note_id WHERE link.source_note_id=$1 ORDER BY link.id`, [sourceNoteId]);
      const links: any[] = [];
      for (const row of rows.rows) {
        const link: NoteLinkRecord = { id: row.id, workspaceId: row.workspace_id, sourceNoteId: row.source_note_id,
          ...(row.target_note_id ? { targetNoteId: row.target_note_id } : {}), ...(row.target_path ? { targetPath: row.target_path } : {}),
          ...(row.candidate_note_ids?.length ? { candidateNoteIds: row.candidate_note_ids } : {}), label: row.label, revision: row.revision };
        if (row.target_note_id && row.portable_path) { links.push({ link, state: "resolved", target: { noteId: row.target_note_id,
          workspaceId: row.workspace_id, path: row.portable_path, aliases: row.aliases ?? [], revision: row.location_revision } }); continue; }
        const candidates = await client.query<any>(`SELECT DISTINCT note.id,note.workspace_id,note.portable_path,note.location_revision FROM stash_notes note
          WHERE note.workspace_id=$1 AND note.id=ANY($2::uuid[])
          AND ((EXISTS(SELECT 1 FROM stash_workspaces workspace WHERE workspace.id=note.workspace_id AND workspace.owner_type='personal' AND workspace.personal_owner_id=$3))
            OR EXISTS(SELECT 1 FROM stash_workspaces workspace JOIN stash_organization_memberships membership ON membership.organization_id=workspace.organization_owner_id
              WHERE workspace.id=note.workspace_id AND membership.account_id=$3))`, [row.workspace_id, row.candidate_note_ids ?? [], memberId]);
        const visible = candidates.rows.map((candidate) => ({ noteId: candidate.id, workspaceId: candidate.workspace_id,
          path: candidate.portable_path, aliases: [], revision: candidate.location_revision }));
        links.push(visible.length ? { link, state: "ambiguous", candidates: visible } : { link, state: "broken" });
      }
      return { status: "found" as const, source: { noteId: sourceNoteId, workspaceId: source.rows[0].workspace_id,
        path: source.rows[0].portable_path, aliases: source.rows[0].aliases ?? [], revision: source.rows[0].location_revision }, links };
    } finally { client.release(); }
  }

  async repairNoteLink(memberId: string, sourceNoteId: string, linkId: string, targetNoteId: string, expectedRevision: number,
    _projection: PortableNoteLinkStateProjection) {
    return this.#withTransaction(async (client) => {
      await this.#ensureNoteSchema(client);
      const found = await client.query<any>(`SELECT link.* FROM stash_note_links link JOIN stash_notes source ON source.id=link.source_note_id
        JOIN stash_workspaces workspace ON workspace.id=source.workspace_id WHERE link.id=$1 AND link.source_note_id=$2 AND
        ((workspace.owner_type='personal' AND workspace.personal_owner_id=$3) OR EXISTS
          (SELECT 1 FROM stash_organization_memberships membership WHERE membership.organization_id=workspace.organization_owner_id AND membership.account_id=$3))
        FOR UPDATE OF link`, [linkId, sourceNoteId, memberId]);
      const row = found.rows[0]; if (!row) return { status: "not_found" as const };
      const current: NoteLinkRecord = { id: row.id, workspaceId: row.workspace_id, sourceNoteId: row.source_note_id,
        ...(row.target_note_id ? { targetNoteId: row.target_note_id } : {}), ...(row.target_path ? { targetPath: row.target_path } : {}),
        ...(row.candidate_note_ids?.length ? { candidateNoteIds: row.candidate_note_ids } : {}), label: row.label, revision: row.revision };
      if (current.revision !== expectedRevision) return { status: "changed" as const, link: current };
      const target = await client.query<any>(`SELECT portable_path FROM stash_notes WHERE id=$1 AND workspace_id=$2`, [targetNoteId, current.workspaceId]);
      if (!target.rowCount) return { status: "target_not_found" as const };
      const { targetPath: _, candidateNoteIds: __, ...stable } = current;
      const repaired = { ...stable, targetNoteId, revision: current.revision + 1 };
      await client.query("UPDATE stash_note_links SET target_note_id=$2,target_path=$3,candidate_note_ids='{}'::uuid[],revision=revision+1 WHERE id=$1", [linkId, targetNoteId, target.rows[0].portable_path]);
      const projection: PortableNoteLinkStateProjection = { schema: "stash.note-link.v2", ...repaired };
      await this.#recordPortableProjection(client, "NoteLink", linkId, projection.schema, projection);
      await this.#recordDomainActivity(client,memberId,current.workspaceId,"NoteLink",linkId,"note_link_repaired",current,repaired);
      return { status: "repaired" as const, link: repaired };
    });
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
      await this.#recordNoteRevisionAndActivity(client, memberId, current, note, "note_edited", { kind: "member" });
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
      await this.#recordNoteRevisionAndActivity(client, memberId, current, note,
        resolution === "apply_contribution" ? "note_conflict_contribution_applied" : "note_conflict_kept_current", { kind: "member" });
      return { status: "resolved" as const, note, projection: projectionFor(note) };
    });
  }

  async saveNotification(delivery: NotificationDelivery) {
    await this.#ensureNotificationSchema();
    const result = await this.#pool.query<any>(`INSERT INTO stash_notifications
      (id,member_id,workspace_id,project_id,trigger,summary,activity,created_at,delivery)
      SELECT $1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9 FROM stash_projects project
      JOIN stash_workspaces workspace ON workspace.id=project.workspace_id
      WHERE project.id=$4 AND workspace.id=$3 AND (
        (workspace.owner_type='personal' AND workspace.personal_owner_id=$2) OR
        (workspace.owner_type='organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
          WHERE membership.organization_id=workspace.organization_owner_id AND membership.account_id=$2)))
      AND ((workspace.owner_type='personal' AND workspace.personal_owner_id=$10) OR
        (workspace.owner_type='organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships actor_membership
          WHERE actor_membership.organization_id=workspace.organization_owner_id AND actor_membership.account_id=$10)))
      ON CONFLICT (member_id, activity_id, trigger) DO NOTHING
      RETURNING *`, [delivery.id, delivery.memberId, delivery.workspaceId, delivery.projectId, delivery.trigger,
      delivery.summary, JSON.stringify(delivery.activity), delivery.createdAt, delivery.delivery, delivery.activity.actor.localAccountId]);
    let row = result.rows[0];
    if (!row) {
      const existing = await this.#pool.query<any>(`SELECT * FROM stash_notifications
        WHERE member_id=$1 AND activity_id=$2 AND trigger=$3`, [delivery.memberId, delivery.activity.id, delivery.trigger]);
      row = existing.rows[0];
    }
    if (!row) throw new Error("notification_recipient_forbidden");
    return this.#notificationFromRow(row);
  }

  async listNotifications(memberId: string) {
    await this.#ensureNotificationSchema();
    const result = await this.#pool.query<any>(`SELECT notification.* FROM stash_notifications notification
      JOIN stash_workspaces workspace ON workspace.id=notification.workspace_id
      WHERE notification.member_id=$1 AND (
        (workspace.owner_type='personal' AND workspace.personal_owner_id=$1) OR
        (workspace.owner_type='organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
          WHERE membership.organization_id=workspace.organization_owner_id AND membership.account_id=$1)))
      ORDER BY notification.created_at DESC, notification.id DESC`, [memberId]);
    return result.rows.map((row) => this.#notificationFromRow(row));
  }

  async markNotificationRead(memberId: string, id: string, readAt: string) {
    await this.#ensureNotificationSchema();
    const result = await this.#pool.query<any>(`UPDATE stash_notifications notification SET read_at=$3
      FROM stash_workspaces workspace
      WHERE notification.id=$1 AND notification.member_id=$2 AND workspace.id=notification.workspace_id AND (
        (workspace.owner_type='personal' AND workspace.personal_owner_id=$2) OR
        (workspace.owner_type='organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
          WHERE membership.organization_id=workspace.organization_owner_id AND membership.account_id=$2))) RETURNING notification.*`, [id, memberId, readAt]);
    return result.rows[0] ? this.#notificationFromRow(result.rows[0]) : undefined;
  }

  async getNotificationPreferences(memberId: string, projectId: string) {
    await this.#ensureNotificationSchema();
    const visibility = await this.#pool.query<any>(`SELECT settings.* FROM stash_projects project
      JOIN stash_workspaces workspace ON workspace.id=project.workspace_id
      LEFT JOIN stash_notification_preferences settings ON settings.project_id=project.id AND settings.member_id=$1
      WHERE project.id=$2 AND ((workspace.owner_type='personal' AND workspace.personal_owner_id=$1) OR
        (workspace.owner_type='organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
          WHERE membership.organization_id=workspace.organization_owner_id AND membership.account_id=$1)))`, [memberId, projectId]);
    const row = visibility.rows[0];
    if (!row) return undefined;
    if (!row.member_id) return { activity: "followed", digest: "off" } as NotificationPreferences;
    return { activity: row.activity, digest: row.digest, ...(row.quiet_start ? { quietHours: { start: row.quiet_start, end: row.quiet_end, timeZone: row.quiet_time_zone } } : {}) };
  }

  async saveNotificationPreferences(memberId: string, projectId: string, preferences: NotificationPreferences) {
    await this.#ensureNotificationSchema();
    const result = await this.#pool.query<any>(`INSERT INTO stash_notification_preferences
      (member_id,project_id,activity,digest,quiet_start,quiet_end,quiet_time_zone)
      SELECT $1,$2,$3,$4,$5,$6,$7 FROM stash_projects project JOIN stash_workspaces workspace ON workspace.id=project.workspace_id
      WHERE project.id=$2 AND ((workspace.owner_type='personal' AND workspace.personal_owner_id=$1) OR
        (workspace.owner_type='organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
          WHERE membership.organization_id=workspace.organization_owner_id AND membership.account_id=$1)))
      ON CONFLICT (member_id,project_id) DO UPDATE SET activity=EXCLUDED.activity,digest=EXCLUDED.digest,
        quiet_start=EXCLUDED.quiet_start,quiet_end=EXCLUDED.quiet_end,quiet_time_zone=EXCLUDED.quiet_time_zone RETURNING *`,
    [memberId, projectId, preferences.activity, preferences.digest, preferences.quietHours?.start ?? null,
      preferences.quietHours?.end ?? null, preferences.quietHours?.timeZone ?? null]);
    return result.rowCount ? preferences : undefined;
  }

  async getProjectFollow(memberId: string, projectId: string) {
    await this.#ensureNotificationSchema();
    const result = await this.#pool.query<{ followed: boolean }>(`SELECT EXISTS (
      SELECT 1 FROM stash_project_follows follow WHERE follow.member_id=$1 AND follow.project_id=project.id
    ) AS followed FROM stash_projects project JOIN stash_workspaces workspace ON workspace.id=project.workspace_id
      WHERE project.id=$2 AND ((workspace.owner_type='personal' AND workspace.personal_owner_id=$1) OR
        (workspace.owner_type='organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
          WHERE membership.organization_id=workspace.organization_owner_id AND membership.account_id=$1)))`, [memberId, projectId]);
    return result.rows[0]?.followed;
  }

  async saveProjectFollow(memberId: string, projectId: string, followed: boolean) {
    await this.#ensureNotificationSchema();
    const visible = await this.#pool.query(`SELECT 1 FROM stash_projects project JOIN stash_workspaces workspace ON workspace.id=project.workspace_id
      WHERE project.id=$2 AND ((workspace.owner_type='personal' AND workspace.personal_owner_id=$1) OR
        (workspace.owner_type='organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
          WHERE membership.organization_id=workspace.organization_owner_id AND membership.account_id=$1)))`, [memberId, projectId]);
    if (!visible.rowCount) return undefined;
    if (followed) await this.#pool.query(`INSERT INTO stash_project_follows(member_id,project_id,followed_at)
      VALUES($1,$2,CURRENT_TIMESTAMP) ON CONFLICT(member_id,project_id) DO NOTHING`, [memberId, projectId]);
    else await this.#pool.query("DELETE FROM stash_project_follows WHERE member_id=$1 AND project_id=$2", [memberId, projectId]);
    return followed;
  }

  async listProjectNotificationAudience(projectId: string, actorId: string) {
    await this.#ensureNotificationSchema();
    const result = await this.#pool.query<{ member_id: string; followed: boolean }>(`SELECT account.id AS member_id,
      (follow.member_id IS NOT NULL) AS followed FROM stash_projects project
      JOIN stash_workspaces workspace ON workspace.id=project.workspace_id
      JOIN stash_accounts account ON (workspace.owner_type='personal' AND account.id=workspace.personal_owner_id) OR
        (workspace.owner_type='organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
          WHERE membership.organization_id=workspace.organization_owner_id AND membership.account_id=account.id))
      LEFT JOIN stash_project_follows follow ON follow.project_id=project.id AND follow.member_id=account.id
      WHERE project.id=$1 AND account.id<>$2 ORDER BY account.id`, [projectId, actorId]);
    return result.rows.map((row) => ({ memberId: row.member_id, followed: row.followed }));
  }

  async claimDigestNotifications(memberId: string, cadence: "daily" | "weekly", since: string, until: string, claimedAt: string) {
    await this.#ensureNotificationSchema();
    const result = await this.#pool.query<any>(`UPDATE stash_notifications notification SET digested_at=$5
      FROM stash_notification_preferences preference, stash_projects project, stash_workspaces workspace
      WHERE notification.member_id=$1 AND notification.read_at IS NULL AND notification.digested_at IS NULL
        AND notification.created_at >= $3 AND notification.created_at <= $4
        AND preference.member_id=$1 AND preference.project_id=notification.project_id AND preference.digest=$2
        AND project.id=notification.project_id AND workspace.id=project.workspace_id
        AND ((workspace.owner_type='personal' AND workspace.personal_owner_id=$1) OR
          (workspace.owner_type='organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
            WHERE membership.organization_id=workspace.organization_owner_id AND membership.account_id=$1)))
      RETURNING notification.*`, [memberId, cadence, since, until, claimedAt]);
    return result.rows.map((row) => this.#notificationFromRow(row));
  }

  #notificationFromRow(row: any): NotificationDelivery {
    return { schema: "stash.notification.v1", id: row.id, memberId: row.member_id, workspaceId: row.workspace_id,
      ...(row.project_id ? { projectId: row.project_id } : {}), trigger: row.trigger, summary: row.summary, activity: row.activity, delivery: row.delivery,
      createdAt: new Date(row.created_at).toISOString(), ...(row.read_at ? { readAt: new Date(row.read_at).toISOString() } : {}),
      ...(row.digested_at ? { digestedAt: new Date(row.digested_at).toISOString() } : {}) };
  }

  async listWorkspaceActivity(memberId: string, workspaceId: string) {
    const client = await this.#pool.connect();
    try {
      await this.#ensureNoteHistorySchema(client);
      await this.#backfillLegacyNoteHistory(client);
      const permitted = await client.query(`SELECT 1 FROM stash_workspaces workspace WHERE workspace.id=$1 AND
        ((workspace.owner_type='personal' AND workspace.personal_owner_id=$2) OR
         (workspace.owner_type='organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
           WHERE membership.organization_id=workspace.organization_owner_id AND membership.account_id=$2)))`, [workspaceId, memberId]);
      if (!permitted.rowCount) return { status: "forbidden" as const };
      const rows = await client.query<any>(`SELECT activity.*, actor.name AS actor_name FROM stash_workspace_activity activity
        JOIN stash_accounts actor ON actor.id=activity.actor_account_id WHERE activity.workspace_id=$1
        ORDER BY activity.occurred_at DESC, activity.id DESC`, [workspaceId]);
      return { status: "found" as const, activities: rows.rows.map((row): ActivityRecord => ({ schema: "stash.activity.v1",
        id: row.id, workspaceId: row.workspace_id, object: { kind: row.object_kind, id: row.object_id }, action: row.action,
        actor: { localAccountId: row.actor_account_id, displayName: row.actor_name }, cause: this.#parseActivityCause(row.cause),
        occurredAt: new Date(row.occurred_at).toISOString(), before: row.before_state, after: row.after_state })) };
    } finally { client.release(); }
  }

  async listNoteHistory(memberId: string, noteId: string) {
    const client = await this.#pool.connect();
    try {
      await this.#ensureNoteHistorySchema(client);
      await this.#backfillLegacyNoteHistory(client);
      const rows = await client.query<any>(`SELECT history.*, actor.name AS actor_name FROM stash_note_history history
        JOIN stash_notes note ON note.id=history.note_id JOIN stash_workspaces workspace ON workspace.id=note.workspace_id
        JOIN stash_accounts actor ON actor.id=history.actor_account_id
        WHERE history.note_id=$1 AND ((workspace.owner_type='personal' AND workspace.personal_owner_id=$2) OR
          (workspace.owner_type='organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
            WHERE membership.organization_id=workspace.organization_owner_id AND membership.account_id=$2)) OR
          (note.project_id IS NOT NULL AND EXISTS (SELECT 1 FROM stash_project_guests guest
            WHERE guest.project_id=note.project_id AND guest.account_id=$2))) ORDER BY history.revision`, [noteId, memberId]);
      if (!rows.rowCount) {
        const visible = await this.findNoteForMember(memberId, noteId);
        if (!visible) return { status: "not_found" as const };
      }
      return { status: "found" as const, revisions: rows.rows.map((row): NoteHistoryRevision => ({ noteId: row.note_id,
        workspaceId: row.workspace_id, revision: Number(row.revision), content: row.content, document: row.document,
        recordedAt: new Date(row.recorded_at).toISOString(), actor: { localAccountId: row.actor_account_id, displayName: row.actor_name },
        cause: this.#parseActivityCause(row.cause) })) };
    } finally { client.release(); }
  }

  async restoreNote(memberId: string, noteId: string, targetRevision: number, expectedRevision: number, idempotencyKey: string) {
    return this.#withTransaction(async (client) => {
      await this.#ensureNoteHistorySchema(client);
      await this.#backfillLegacyNoteHistory(client);
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [noteId, idempotencyKey]);
      const found = await client.query<any>(`SELECT note.*, creator.name AS creator_name FROM stash_notes note
        JOIN stash_workspaces workspace ON workspace.id=note.workspace_id JOIN stash_accounts creator ON creator.id=note.created_by_account_id
        WHERE note.id=$1 AND ((workspace.owner_type='personal' AND workspace.personal_owner_id=$2) OR
          (workspace.owner_type='organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
            WHERE membership.organization_id=workspace.organization_owner_id AND membership.account_id=$2))) FOR UPDATE OF note`, [noteId, memberId]);
      const row = found.rows[0];
      if (!row) return { status: "not_found" as const };
      const receipt = await client.query<any>(`SELECT receipt.target_revision, receipt.activity_id, receipt.restore_result, activity.*, actor.name AS actor_name
        FROM stash_note_restore_receipts receipt JOIN stash_workspace_activity activity ON activity.id=receipt.activity_id
        JOIN stash_accounts actor ON actor.id=activity.actor_account_id WHERE receipt.note_id=$1 AND receipt.idempotency_key=$2`, [noteId, idempotencyKey]);
      if (receipt.rows[0]) {
        if (Number(receipt.rows[0].target_revision) !== targetRevision) return { status: "idempotency_conflict" as const };
        const row = receipt.rows[0];
        return { status: "duplicate" as const, note: row.restore_result,
          activity: { schema: "stash.activity.v1", id: row.activity_id, workspaceId: row.workspace_id,
            object: { kind: row.object_kind, id: row.object_id }, action: row.action,
            actor: { localAccountId: row.actor_account_id, displayName: row.actor_name }, cause: this.#parseActivityCause(row.cause),
            occurredAt: new Date(row.occurred_at).toISOString(), before: row.before_state, after: row.after_state } as ActivityRecord };
      }
      if (Number(row.revision) !== expectedRevision) return { status: "revision_conflict" as const, currentRevision: Number(row.revision) };
      const target = await client.query<any>("SELECT content,document FROM stash_note_history WHERE note_id=$1 AND revision=$2", [noteId, targetRevision]);
      if (!target.rows[0]) return { status: "revision_not_found" as const };
      const before: NoteRecord = { id: row.id, workspaceId: row.workspace_id, content: row.content, document: row.document,
        revision: Number(row.revision), tags: row.tags, createdByMemberId: row.created_by_account_id,
        createdAt: new Date(row.created_at).toISOString(), ...(row.project_id ? { projectId: row.project_id } : {}),
        ...(row.reminder_at ? { reminder: { at: new Date(row.reminder_at).toISOString() } } : {}),
        ...(row.archived_at ? { archivedAt: new Date(row.archived_at).toISOString() } : {}) };
      const note = { ...before, revision: before.revision + 1, content: target.rows[0].content, document: target.rows[0].document };
      await client.query("UPDATE stash_notes SET content=$2,document=$3::jsonb,revision=$4 WHERE id=$1", [noteId, note.content, JSON.stringify(note.document), note.revision]);
      const projection = { schema: "stash.note.v2" as const, note: (({ createdByMemberId: _, ...publicNote }) => publicNote)(note),
        createdBy: { localAccountId: row.created_by_account_id, displayName: row.creator_name } };
      await this.#recordPortableProjection(client, "Note", noteId, "stash.note.v2", projection);
      const activity = await this.#recordNoteRevisionAndActivity(client, memberId, before, note, "note_restored",
        { kind: "member", restorationOfRevision: targetRevision });
      const restoreResult = { revision: note.revision, content: note.content, document: note.document };
      await client.query("INSERT INTO stash_note_restore_receipts (note_id,idempotency_key,target_revision,activity_id,restore_result) VALUES ($1,$2,$3,$4,$5::jsonb)",
        [noteId, idempotencyKey, targetRevision, activity.id, JSON.stringify(restoreResult)]);
      return { status: "restored" as const, note: restoreResult, activity };
    });
  }
  async close(): Promise<void> {
    await this.#pool.end();
  }

  async resolveClientSessionPrincipal(accountId: string) {
    const client = await this.#pool.connect();
    try {
      await this.#ensureWorkspaceProjectSchema(client);
      const result = await client.query<{ account_id: string; account_name: string; account_email: string; workspace_id: string; workspace_name: string; organization_id: string | null }>(`
        SELECT account.id account_id, account.name account_name, account.email account_email,
          workspace.id workspace_id, workspace.name workspace_name, workspace.organization_owner_id organization_id
        FROM stash_accounts account
        JOIN LATERAL (
          SELECT candidate.id, candidate.name, candidate.organization_owner_id
          FROM stash_workspaces candidate
          WHERE (candidate.owner_type='personal' AND candidate.personal_owner_id=account.id)
            OR (candidate.owner_type='organization' AND EXISTS (
              SELECT 1 FROM stash_organization_memberships membership
              WHERE membership.organization_id=candidate.organization_owner_id AND membership.account_id=account.id))
            OR EXISTS (
              SELECT 1 FROM stash_projects project JOIN stash_project_guests guest ON guest.project_id=project.id
              WHERE project.workspace_id=candidate.id AND guest.account_id=account.id)
          ORDER BY candidate.created_at, candidate.id LIMIT 1
        ) workspace ON true
        WHERE account.id=$1`, [accountId]);
      const row = result.rows[0];
      if (!row) return undefined;
      const administration = await client.query<{ organization_id: string; organization_name: string; member_id: string;
        member_name: string; member_email: string; member_role: BuiltInOrganizationRole }>(`
        SELECT organization.id organization_id, organization.name organization_name,
          member.id member_id, member.name member_name, member.email member_email, membership.role member_role
        FROM stash_organization_memberships actor_membership
        JOIN stash_organizations organization ON organization.id=actor_membership.organization_id
        JOIN stash_organization_memberships membership ON membership.organization_id=organization.id
        JOIN stash_accounts member ON member.id=membership.account_id
        WHERE actor_membership.account_id=$1 AND actor_membership.role IN ('Owner','Admin')
        ORDER BY organization.id, member.name, member.id`, [accountId]);
      const organizationAdministrations = [...new Set(administration.rows.map(({ organization_id }) => organization_id))]
        .map((organizationId) => {
          const eligibleMembers = administration.rows.filter(({ organization_id }) => organization_id === organizationId);
          return { organizationId, organizationName: eligibleMembers[0]!.organization_name,
            members: eligibleMembers.map((member) => ({ id: member.member_id, name: member.member_name,
              email: member.member_email, role: member.member_role })) };
        });
      return { member: { id: row.account_id, name: row.account_name, email: row.account_email },
        workspace: { id: row.workspace_id, name: row.workspace_name }, capabilities: [],
        ...(organizationAdministrations.length ? { organizationAdministrations } : {}),
        ...(row.organization_id ? { activeOrganizationId: row.organization_id } : {}) };
    } finally { client.release(); }
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
      await client.query(`INSERT INTO stash_repository_connections (id, organization_id, provider, installation_id, repository_id, repository_url, created_by_account_id, created_by_attribution, ownership, state) VALUES ($1,$2,$3,$4,$5,$6,$7,'recorded',$8,'active')`, [record.id, record.organizationId, record.provider, record.installationId, record.repositoryId, record.repositoryUrl, actorId, record.ownership ?? "organization"]);
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

  async replaceDegradedRepositoryConnection(actorId: string, organizationId: string, connectionId: string,
    replacement: import("./repository-connections.js").GitHubRepositoryIdentity) {
    await this.#ensureRepositoryConnectionSchema();
    return this.#withTransaction(async (client) => {
      const memberships = await this.#lockedOrganizationMemberships(client, organizationId);
      if (!this.#canManageRepositoryConnections(memberships, actorId)) return "forbidden" as const;
      const repaired = await client.query<RepositoryConnectionRow>(`${repositoryConnectionSelect} WHERE connection.organization_id = $1 AND connection.id = $2 AND connection.state = 'degraded' FOR UPDATE`, [organizationId, connectionId]);
      if (!repaired.rows[0]) return "not_found" as const;
      await client.query(`UPDATE stash_repository_connections SET installation_id = $2, repository_id = $3,
        repository_url = $4, created_by_account_id = $5, created_by_attribution = 'recorded',
        ownership = 'organization', state = 'active' WHERE id = $1`,
      [connectionId, replacement.installationId, replacement.repositoryId, replacement.repositoryUrl, actorId]);
      const refreshed = { ...repositoryConnectionRecord(repaired.rows[0]), ...replacement,
        createdByMemberId: actorId, createdByAttribution: "recorded" as const,
        ownership: "organization" as const, state: "active" as const };
      const revision = await client.query<{ revision: number }>("SELECT COALESCE(MAX(revision),0)+1 AS revision FROM stash_portable_projection_outbox WHERE object_kind='RepositoryConnection' AND object_id=$1", [connectionId]);
      await this.#recordRepositoryConnectionProjection(client, refreshed, Number(revision.rows[0]!.revision));
      return "repaired" as const;
    });
  }

  async resolveTask(memberId: string, projectId: string, taskKey: string) {
    const result = await this.findTaskByKey(memberId, projectId, taskKey);
    return result.status === "found" ? { id: result.task.id, key: result.task.key, title: result.task.title } : undefined;
  }

  async resolveConnection(memberId: string, projectId: string, connectionId: string) {
    await this.#ensureRepositoryConnectionSchema();
    const result = await this.#pool.query<RepositoryConnectionRow>(`${repositoryConnectionSelect}
      JOIN stash_repository_connection_projects selected ON selected.connection_id = connection.id AND selected.project_id = $2
      JOIN stash_projects project ON project.id = selected.project_id
      JOIN stash_workspaces workspace ON workspace.id = project.workspace_id
      WHERE connection.id = $1 AND connection.state = 'active' AND ((workspace.owner_type = 'personal' AND workspace.personal_owner_id = $3)
        OR (workspace.owner_type = 'organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership WHERE membership.organization_id = workspace.organization_owner_id AND membership.account_id = $3)))`, [connectionId, projectId, memberId]);
    const row = result.rows[0];
    return row ? { installationId: Number(row.installation_id), repositoryId: row.repository_id, repositoryUrl: row.repository_url } : undefined;
  }

  async canLinkArtifact(memberId: string, projectId: string, taskKey: string) {
    const client = await this.#pool.connect();
    try {
      await this.#ensureInvitationSchema(client);
      const result = await client.query(`SELECT 1 FROM stash_tasks task
      JOIN stash_projects project ON project.id = task.project_id
      JOIN stash_workspaces workspace ON workspace.id = project.workspace_id
      WHERE ((task.project_id = $1 AND task.task_key = $2) OR EXISTS (SELECT 1 FROM stash_task_key_aliases alias
        WHERE alias.task_id = task.id AND alias.project_id = $1 AND alias.task_key = $2))
        AND ((workspace.owner_type = 'personal' AND workspace.personal_owner_id = $3)
          OR (workspace.owner_type = 'organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
            WHERE membership.organization_id = workspace.organization_owner_id AND membership.account_id = $3)))`, [projectId, taskKey, memberId]);
      return Boolean(result.rowCount);
    } finally { client.release(); }
  }

  async linkArtifact(memberId: string, projectId: string, taskKey: string, artifact: DevelopmentArtifact) {
    return this.#withTransaction(async (client) => {
      await this.#ensureNoteSchema(client); await this.#ensureInvitationSchema(client);
      const current = await client.query<any>(`${taskPlanningSelect} FOR UPDATE OF task`, [projectId, taskKey, memberId]);
      const row = current.rows[0]; if (!row) return "forbidden" as const;
      const writable = await client.query(`SELECT 1 FROM stash_workspaces workspace WHERE workspace.id = $1
        AND ((workspace.owner_type = 'personal' AND workspace.personal_owner_id = $2)
          OR (workspace.owner_type = 'organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
            WHERE membership.organization_id = workspace.organization_owner_id AND membership.account_id = $2))) FOR UPDATE`, [row.workspace_id, memberId]);
      if (!writable.rowCount) return "forbidden" as const;
      await this.#persistTaskDevelopmentArtifact(client, row, memberId, artifact, "task_planning_updated", { kind: "member" });
      return "linked" as const;
    });
  }

  async listArtifacts(memberId: string, projectId: string, taskKey: string) {
    const current = await this.findTaskByKey(memberId, projectId, taskKey);
    if (current.status !== "found") return undefined;
    return (current.task.developmentLinks ?? []).flatMap(({ url }) => developmentArtifactFromUrl(url));
  }

  async matchingTasks(installationId: number, repositoryId: string, keys: string[]) {
    await this.#ensureGitHubSignalSchema();
    if (!keys.length) return [];
    const result = await this.#pool.query<{ task_id: string; project_id: string; organization_id: string; task_key: string; title: string; matched_key: string }>(`
      SELECT DISTINCT task.id AS task_id, task.project_id, connection.organization_id, task.task_key, task.title, matched.matched_key
      FROM stash_repository_connections connection
      JOIN stash_repository_connection_projects link ON link.connection_id = connection.id
      JOIN stash_tasks task ON task.project_id = link.project_id
      JOIN LATERAL (
        SELECT task.task_key AS matched_key WHERE task.task_key = ANY($3::text[])
        UNION SELECT alias.task_key FROM stash_task_key_aliases alias WHERE alias.task_id = task.id AND alias.task_key = ANY($3::text[])
      ) matched ON true
      WHERE connection.provider='github' AND connection.state='active'
        AND connection.installation_id=$1 AND connection.repository_id=$2
      `, [installationId, repositoryId, keys]);
    return result.rows.map((row) => ({ taskId: row.task_id, projectId: row.project_id, organizationId: row.organization_id,
      taskKey: row.task_key, title: row.title, matchedKey: row.matched_key }));
  }

  async receive(signal: GitHubSignal, candidates: SignalCandidate[]) {
    await this.#ensureGitHubSignalSchema();
    await this.#withTransaction(async (client) => {
      const inserted = await client.query(`INSERT INTO stash_github_signals
        (id, delivery_id, installation_id, repository_id, kind, provider_id, url, label, occurred_at, automation_trigger)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (delivery_id) DO NOTHING`,
      [signal.id, signal.deliveryId, signal.installationId, signal.repositoryId, signal.kind, signal.providerId, signal.url, signal.label, signal.occurredAt, signal.trigger ?? null]);
      if (!inserted.rowCount) return;
      for (const candidate of candidates) {
        await client.query(`INSERT INTO stash_github_signal_suggestions
          (id, signal_id, task_id, project_id, organization_id, task_key, task_title, matched_key, status)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [candidate.id, signal.id, candidate.taskId, candidate.projectId, candidate.organizationId, candidate.taskKey, candidate.taskTitle, candidate.matchedKey, candidate.status]);
        if (candidate.status === "confirmed") await this.#linkSignalArtifact(client, candidate.taskId, signal, undefined, candidate.organizationId);
      }
    });
  }

  async list(memberId: string, projectId: string, taskKey: string) {
    await this.#ensureGitHubSignalSchema();
    const visible = await this.findTaskByKey(memberId, projectId, taskKey);
    if (visible.status !== "found") return undefined;
    const result = await this.#pool.query<any>(`SELECT signal.*, suggestion.id AS suggestion_id, suggestion.task_id,
      suggestion.project_id, suggestion.organization_id, suggestion.task_key, suggestion.task_title, suggestion.matched_key, suggestion.status
      FROM stash_github_signal_suggestions suggestion JOIN stash_github_signals signal ON signal.id = suggestion.signal_id
      WHERE suggestion.task_id = $1 ORDER BY signal.occurred_at DESC, suggestion.id`, [visible.task.id]);
    const grouped = new Map<string, { signal: GitHubSignal; suggestions: SignalCandidate[] }>();
    for (const row of result.rows) {
      const entry = grouped.get(row.id) ?? { signal: githubSignalFromRow(row), suggestions: [] };
      entry.suggestions.push({ id: row.suggestion_id, signalId: row.id, taskId: row.task_id, projectId: row.project_id, organizationId: row.organization_id, taskKey: row.task_key, taskTitle: row.task_title, matchedKey: row.matched_key, status: row.status });
      grouped.set(row.id, entry);
    }
    return [...grouped.values()];
  }

  async confirm(memberId: string, projectId: string, taskKey: string, suggestionId: string) {
    await this.#ensureGitHubSignalSchema();
    if (!await this.canLinkArtifact(memberId, projectId, taskKey)) return "forbidden" as const;
    return this.#withTransaction(async (client) => {
      const result = await client.query<any>(`SELECT suggestion.*, signal.kind, signal.provider_id, signal.url, signal.label,
        signal.delivery_id, signal.repository_id, signal.occurred_at
        FROM stash_github_signal_suggestions suggestion JOIN stash_github_signals signal ON signal.id = suggestion.signal_id
        JOIN stash_tasks task ON task.id = suggestion.task_id
        WHERE suggestion.id=$1 AND suggestion.project_id=$2 AND (suggestion.task_key=$3 OR task.task_key=$3) FOR UPDATE OF suggestion`, [suggestionId, projectId, taskKey]);
      const row = result.rows[0]; if (!row) return "not_found" as const;
      await client.query("UPDATE stash_github_signal_suggestions SET status='confirmed', confirmed_by_account_id=$2, confirmed_at=NOW() WHERE id=$1", [suggestionId, memberId]);
      await this.#linkSignalArtifact(client, row.task_id, githubSignalFromRow(row), memberId);
      return "confirmed" as const;
    });
  }

  async listAutomationState(memberId: string, projectId: string, taskKey: string): Promise<AutomationState | undefined> {
    return this.#withTransaction(async (client) => {
      await this.#ensureAutomationSchema(client);
      const visible = await client.query<any>(taskPlanningSelect, [projectId, taskKey, memberId]);
      const task = visible.rows[0]; if (!task) return undefined;
      const recipes = await client.query<any>(`SELECT recipe.*, status.name AS target_status_name FROM stash_automation_recipes recipe
        JOIN stash_workflow_statuses status ON status.id=recipe.target_status_id WHERE recipe.project_id=$1 ORDER BY recipe.created_at,recipe.id`, [projectId]);
      const transitions = await client.query<any>(`SELECT transition.*, before_status.name AS before_status_name, after_status.name AS after_status_name
        FROM stash_automation_transitions transition JOIN stash_workflow_statuses before_status ON before_status.id=transition.before_status_id
        JOIN stash_workflow_statuses after_status ON after_status.id=transition.after_status_id WHERE transition.task_id=$1 ORDER BY transition.occurred_at DESC`, [task.id]);
      const statuses = await client.query<{ id: string; name: string }>("SELECT id,name FROM stash_workflow_statuses WHERE project_id=$1 AND archived=FALSE ORDER BY position", [projectId]);
      return { recipes: recipes.rows.map(automationRecipeFromRow), transitions: transitions.rows.map(automationTransitionFromRow), availableStatuses: statuses.rows };
    });
  }

  async enableAutomation(memberId: string, projectId: string, trigger: AutomationTrigger, targetStatusId: string) {
    return this.#withTransaction(async (client) => {
      await this.#ensureAutomationSchema(client);
      const access = await this.#findProjectWorkflowAccess(client, memberId, projectId, true);
      if (access === "forbidden") return "forbidden" as const;
      if (access === "not_found") return "not_found" as const;
      const status = await client.query<{ name: string }>("SELECT name FROM stash_workflow_statuses WHERE id=$1 AND project_id=$2 AND archived=FALSE", [targetStatusId, projectId]);
      if (!status.rowCount) return "invalid_status" as const;
      const id = randomUUID();
      const result = await client.query<any>(`INSERT INTO stash_automation_recipes(id,project_id,trigger,target_status_id,created_by_account_id,created_at)
        VALUES($1,$2,$3,$4,$5,now()) ON CONFLICT(project_id,trigger) DO UPDATE SET target_status_id=EXCLUDED.target_status_id,
        enabled=TRUE,created_by_account_id=EXCLUDED.created_by_account_id,created_at=EXCLUDED.created_at
        RETURNING *`, [id, projectId, trigger, targetStatusId, memberId]);
      return { status: "enabled" as const, recipe: automationRecipeFromRow({ ...result.rows[0], target_status_name: status.rows[0]!.name }) };
    });
  }

  async reverseAutomation(memberId: string, projectId: string, taskKey: string, transitionId: string) {
    return this.#withTransaction(async (client) => {
      await this.#ensureAutomationSchema(client);
      const access = await this.#findProjectWorkflowAccess(client, memberId, projectId, true);
      if (access === "forbidden") return "forbidden" as const;
      if (access === "not_found") return "not_found" as const;
      const result = await client.query<any>(`SELECT transition.*, before_status.name AS before_status_name, after_status.name AS after_status_name,
        task.workflow_status_id,task.workspace_id FROM stash_automation_transitions transition JOIN stash_tasks task ON task.id=transition.task_id
        JOIN stash_workflow_statuses before_status ON before_status.id=transition.before_status_id JOIN stash_workflow_statuses after_status ON after_status.id=transition.after_status_id
        WHERE transition.id=$1 AND transition.project_id=$2 AND task.task_key=$3 FOR UPDATE OF transition,task`, [transitionId, projectId, taskKey]);
      const row = result.rows[0]; if (!row) return "not_found" as const;
      if (row.reversed_at) return { status: "reversed" as const, transition: automationTransitionFromRow(row) };
      if (row.workflow_status_id !== row.after_status_id) return "conflict" as const;
      const before = await client.query<any>(taskPlanningSelectById, [row.task_id, memberId]);
      await client.query(`UPDATE stash_tasks SET workflow_status_id=$2,revision=revision+1,
        field_revisions=jsonb_set(field_revisions,'{statusId}',to_jsonb(revision+1),true) WHERE id=$1`, [row.task_id, row.before_status_id]);
      const reversedAt = new Date().toISOString();
      await client.query("UPDATE stash_automation_transitions SET reversed_at=$2,reversed_by_account_id=$3 WHERE id=$1", [transitionId, reversedAt, memberId]);
      const saved = await client.query<any>(taskPlanningSelectById, [row.task_id, memberId]);
      const after = taskPlanningReadModelFromRow(saved.rows[0]);
      await this.#recordPortableProjection(client, "Task", after.id, after.schema, taskProjectionFromRow(saved.rows[0]));
      await this.#recordTaskActivity(client, memberId, row.workspace_id, row.task_id, "automation_status_transition_reversed", taskPlanningReadModelFromRow(before.rows[0]), after,
        { kind: "member", automationId: row.automation_id, signalId: row.signal_id });
      return { status: "reversed" as const, transition: automationTransitionFromRow({ ...row, reversed_at: reversedAt }) };
    });
  }

  async applySignalAutomations(signal: { id: string; trigger?: AutomationTrigger }, candidates: ReadonlyArray<AutomationCandidate>) {
    if (!signal.trigger) return { failed: false, notifications: [] };
    const triggeredSignal = { id: signal.id, trigger: signal.trigger };
    const notifications: AutomationFailureNotification[] = [];
    let failed = false;
    for (const candidate of candidates.filter(({ status }) => status === "confirmed")) {
      const existingFailures = await this.#existingSignalAutomationFailureNotifications(signal.id, candidate);
      if (existingFailures.found) {
        failed = true;
        notifications.push(...existingFailures.notifications);
        continue;
      }
      let failedRun: FailedAutomationRun | undefined;
      try {
        await this.#withTransaction(async (client) => {
          await this.#ensureAutomationSchema(client);
        const result = await client.query<any>(`SELECT recipe.id AS automation_id,recipe.target_status_id,recipe.created_by_account_id,
          configurer.name AS created_by_name,task.*,current_status.name AS status_name,current_status.category AS status_category
          FROM stash_automation_recipes recipe JOIN stash_tasks task ON task.id=$1 AND task.project_id=recipe.project_id
          JOIN stash_workflow_statuses current_status ON current_status.id=task.workflow_status_id
          JOIN stash_accounts configurer ON configurer.id=recipe.created_by_account_id
          WHERE recipe.project_id=$2 AND recipe.trigger=$3 AND recipe.enabled=TRUE FOR UPDATE OF task,recipe`, [candidate.taskId, candidate.projectId, triggeredSignal.trigger]);
        const row = result.rows[0]; if (!row || row.workflow_status_id === row.target_status_id) return;
        failedRun = { automationId: row.automation_id, configuringMemberId: row.created_by_account_id,
          configuringMemberName: row.created_by_name, workspaceId: row.workspace_id, projectId: candidate.projectId,
          taskId: row.id, taskKey: row.task_key, taskTitle: row.title };
        const inserted = await client.query<any>(`INSERT INTO stash_automation_transitions(id,automation_id,signal_id,task_id,project_id,before_status_id,after_status_id,occurred_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,now()) ON CONFLICT(automation_id,signal_id,task_id) DO NOTHING RETURNING id,occurred_at`,
        [randomUUID(), row.automation_id, signal.id, row.id, candidate.projectId, row.workflow_status_id, row.target_status_id]);
        if (!inserted.rowCount) return;
        const before = taskPlanningReadModelFromRow(row);
        await client.query(`UPDATE stash_tasks SET workflow_status_id=$2,revision=revision+1,
          field_revisions=jsonb_set(field_revisions,'{statusId}',to_jsonb(revision+1),true) WHERE id=$1`, [row.id, row.target_status_id]);
        const saved = await client.query<any>(taskPlanningSelectById, [row.id, row.created_by_account_id]); const after = taskPlanningReadModelFromRow(saved.rows[0]);
        await this.#recordPortableProjection(client, "Task", after.id, after.schema, taskProjectionFromRow(saved.rows[0]));
        await this.#recordTaskActivity(client, row.created_by_account_id, row.workspace_id, row.id, "task_status_automated", before, after,
          { kind: "automation", automationId: row.automation_id, signalId: signal.id });
        });
      } catch (error) {
        if (!failedRun) throw error;
        failed = true;
        const notification = await this.#recordSignalAutomationFailure(triggeredSignal.id, failedRun);
        if (notification) notifications.push(notification);
      }
    }
    return { failed, notifications };
  }

  async #recordSignalAutomationFailure(signalId: string, run: FailedAutomationRun): Promise<AutomationFailureNotification | undefined> {
    return this.#withTransaction(async (client) => {
      await this.#ensureAutomationSchema(client);
        const activity: ActivityRecord = { schema: "stash.activity.v1", id: randomUUID(), workspaceId: run.workspaceId,
          object: { kind: "Task", id: run.taskId }, action: "automation_execution_failed",
          actor: { localAccountId: run.configuringMemberId, displayName: run.configuringMemberName },
          cause: { kind: "automation", automationId: run.automationId, signalId },
          occurredAt: new Date().toISOString(), before: { status: "running" }, after: { status: "failed" } };
        const summary = `Automation failed for ${run.taskKey}: ${run.taskTitle}`;
        const stored = await client.query<{ activity: ActivityRecord; recipient_member_id: string; summary: string; created: boolean }>(`WITH attempted AS (
          INSERT INTO stash_automation_failures(id,automation_id,signal_id,task_id,project_id,occurred_at,activity,recipient_member_id,summary)
          VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) ON CONFLICT(automation_id,signal_id,task_id) DO NOTHING
          RETURNING activity,recipient_member_id,summary,TRUE AS created
        ) SELECT * FROM attempted UNION ALL
          SELECT failure.activity,failure.recipient_member_id,failure.summary,FALSE AS created FROM stash_automation_failures failure
          WHERE failure.automation_id=$2 AND failure.signal_id=$3 AND failure.task_id=$4 AND NOT EXISTS(SELECT 1 FROM attempted)`,
        [activity.id, run.automationId, signalId, run.taskId, run.projectId, activity.occurredAt, JSON.stringify(activity), run.configuringMemberId, summary]);
        const failure = stored.rows[0]!;
        if (failure.created) await this.#persistTaskActivity(client, failure.activity);
        return await this.#canReceiveProjectNotification(client, failure.recipient_member_id, run.projectId, failure.activity.workspaceId)
          ? { activity: failure.activity, projectId: run.projectId, memberId: failure.recipient_member_id, summary: failure.summary }
          : undefined;
    });
  }

  async #existingSignalAutomationFailureNotifications(signalId: string, candidate: AutomationCandidate): Promise<
    { found: boolean; notifications: AutomationFailureNotification[] }
  > {
    return this.#withTransaction(async (client) => {
      await this.#ensureAutomationSchema(client);
      const stored = await client.query<{ activity: ActivityRecord; recipient_member_id: string; summary: string }>(`SELECT activity,recipient_member_id,summary
        FROM stash_automation_failures WHERE signal_id=$1 AND task_id=$2 AND project_id=$3`, [signalId, candidate.taskId, candidate.projectId]);
      const notifications: AutomationFailureNotification[] = [];
      for (const failure of stored.rows) {
        if (await this.#canReceiveProjectNotification(client, failure.recipient_member_id, candidate.projectId, failure.activity.workspaceId)) {
          notifications.push({ activity: failure.activity, projectId: candidate.projectId, memberId: failure.recipient_member_id, summary: failure.summary });
        }
      }
      return { found: Boolean(stored.rowCount), notifications };
    });
  }

  async #canReceiveProjectNotification(client: PoolClient, memberId: string, projectId: string, workspaceId: string): Promise<boolean> {
    const access = await client.query(`SELECT 1 FROM stash_projects project JOIN stash_workspaces workspace ON workspace.id=project.workspace_id
      WHERE project.id=$1 AND workspace.id=$2 AND ((workspace.owner_type='personal' AND workspace.personal_owner_id=$3) OR
        (workspace.owner_type='organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
          WHERE membership.organization_id=workspace.organization_owner_id AND membership.account_id=$3)))`, [projectId, workspaceId, memberId]);
    return Boolean(access.rowCount);
  }

  async #linkSignalArtifact(client: PoolClient, taskId: string, signal: GitHubSignal, confirmingMemberId?: string, organizationId?: string) {
    const actor = confirmingMemberId ? { id: confirmingMemberId, cause: { kind: "member" } as ActivityCause }
      : (await client.query<{ id: string }>(`SELECT membership.account_id AS id FROM stash_organization_memberships membership
        WHERE membership.organization_id=$1 AND membership.role='Owner' ORDER BY membership.account_id LIMIT 1`, [organizationId])).rows[0];
    if (!actor) return;
    const task = await client.query<any>(`${taskPlanningSelectById} FOR UPDATE OF task`, [taskId, actor.id]);
    const row = task.rows[0]; if (!row) return;
    await this.#persistTaskDevelopmentArtifact(client, row, actor.id, signal, "task_development_signal_linked",
      confirmingMemberId ? { kind: "member" } : { kind: "signal", signalId: signal.id });
  }

  async #persistTaskDevelopmentArtifact(client: PoolClient, row: any, actorId: string,
    artifact: Pick<DevelopmentArtifact, "kind" | "url">, action: string, cause: ActivityCause) {
    const before = taskPlanningReadModelFromRow(row); const links = before.developmentLinks ?? [];
    if (links.some(({ url }) => url === artifact.url)) return;
    const revision = Number(row.revision) + 1;
    await client.query(`UPDATE stash_tasks SET development_links=$2::jsonb, revision=$3,
      field_revisions=jsonb_set(field_revisions,'{developmentLinks}',to_jsonb($3::int),true) WHERE id=$1`,
    [row.id, JSON.stringify([...links, { provider: "github", kind: artifact.kind, url: artifact.url }]), revision]);
    const saved = await client.query<any>(taskPlanningSelectById, [row.id, actorId]);
    const after = taskPlanningReadModelFromRow(saved.rows[0]);
    await this.#recordPortableProjection(client, "Task", after.id, after.schema, taskProjectionFromRow(saved.rows[0]));
    await this.#recordTaskActivity(client, actorId, after.workspaceId, after.id, action, before, after, cause);
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
       WHERE connection.id = $2 AND connection.organization_id = $1 AND connection.state = 'active'
         AND workspace.owner_type = 'organization' AND workspace.organization_owner_id = $1
       ON CONFLICT DO NOTHING`,
      [organizationId, connectionId, projectId],
    );
      if (!result.rowCount) {
        const existing = await client.query(
      `SELECT 1 FROM stash_repository_connection_projects link
       JOIN stash_repository_connections connection ON connection.id = link.connection_id
       WHERE connection.organization_id = $1 AND connection.state = 'active'
         AND link.connection_id = $2 AND link.project_id = $3`,
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
  ): Promise<{ status: "removed"; departure: import("./organization-roles.js").MemberDeparture }
    | "member_not_found" | "final_owner" | "forbidden"> {
    return this.#withTransaction(async (client) => {
      const memberships = await this.#lockedOrganizationMemberships(client, organizationId);
      if (!this.#canManageMembers(memberships, actorId)) return "forbidden";
      const target = memberships.find((membership) => membership.account_id === accountId);
      if (!target) return "member_not_found";
      const actorRole = memberships.find((membership) => membership.account_id === actorId)?.role;
      if (target.role === "Owner" && this.#isOnlyOwner(memberships, accountId)) {
        return "final_owner";
      }
      if (actorRole === "Admin" && target.role === "Owner") return "forbidden";
      await this.#ensureMemberDepartureSchema(client);
      const affectedTaskIds = await this.#markFormerAssignments(client, organizationId, accountId, actorId);
      await client.query(
        "DELETE FROM stash_organization_memberships WHERE organization_id = $1 AND account_id = $2",
        [organizationId, accountId],
      );
      const { revokedSessions, revokedCredentials, revokedAgentGrants } =
        await this.#revokeDepartedMemberAuthority(client, organizationId, accountId);
      const degradedRepositoryConnectionIds = await this.#degradePersonalConnections(client, organizationId, accountId);
      await this.#recordMemberDepartureAudit(client, { organizationId, actorId, accountId, role: target.role,
        affectedTaskIds, degradedRepositoryConnectionIds, revokedSessions, revokedCredentials, revokedAgentGrants });
      return { status: "removed", departure: {
        memberId: accountId,
        affectedTaskIds,
        revokedSessions,
        revokedCredentials,
        revokedAgentGrants,
        degradedRepositoryConnectionIds,
      } };
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

  #canManageMembers(
    memberships: ReadonlyArray<{ account_id: string; role: BuiltInOrganizationRole }>,
    accountId: string,
  ): boolean {
    return memberships.some((membership) => membership.account_id === accountId
      && (membership.role === "Owner" || membership.role === "Admin"));
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
          ownership TEXT NOT NULL DEFAULT 'organization' CONSTRAINT stash_repository_connections_ownership_check CHECK (ownership IN ('organization','personal')),
          state TEXT NOT NULL DEFAULT 'active' CONSTRAINT stash_repository_connections_state_check CHECK (state IN ('active','degraded')),
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
        await this.#ensureRepositoryConnectionStateColumns(client);
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

  async #ensureGitHubSignalSchema(): Promise<void> {
    await this.#ensureRepositoryConnectionSchema();
    await this.#ensureNoteSchemaForPool();
    await this.#pool.query(`
      CREATE TABLE IF NOT EXISTS stash_github_signals (
        id UUID PRIMARY KEY,
        delivery_id TEXT NOT NULL UNIQUE,
        installation_id BIGINT NOT NULL CHECK (installation_id > 0),
        repository_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('branch','commit','pull_request')),
        provider_id TEXT NOT NULL,
        url TEXT NOT NULL,
        label TEXT NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL
      );
      CREATE TABLE IF NOT EXISTS stash_github_signal_suggestions (
        id UUID PRIMARY KEY,
        signal_id UUID NOT NULL REFERENCES stash_github_signals(id) ON DELETE CASCADE,
        task_id UUID NOT NULL REFERENCES stash_tasks(id) ON DELETE CASCADE,
        project_id UUID NOT NULL REFERENCES stash_projects(id) ON DELETE CASCADE,
        organization_id UUID NOT NULL REFERENCES stash_organizations(id) ON DELETE CASCADE,
        task_key TEXT NOT NULL,
        task_title TEXT NOT NULL,
        matched_key TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('confirmed','pending_confirmation')),
        confirmed_by_account_id UUID REFERENCES stash_accounts(id),
        confirmed_at TIMESTAMPTZ,
        UNIQUE(signal_id, task_id, matched_key)
      );
      CREATE INDEX IF NOT EXISTS stash_github_signal_suggestions_task_idx ON stash_github_signal_suggestions(task_id);
      ALTER TABLE stash_github_signals ADD COLUMN IF NOT EXISTS automation_trigger TEXT CHECK (automation_trigger IN ('branch_created','pull_request_completed'));
    `);
  }

  async #ensureAutomationSchema(client: PoolClient): Promise<void> {
    await this.#ensureNoteSchema(client);
    await this.#ensureGitHubSignalSchema();
    await client.query(`
      CREATE TABLE IF NOT EXISTS stash_automation_recipes (
        id UUID PRIMARY KEY, project_id UUID NOT NULL REFERENCES stash_projects(id) ON DELETE CASCADE,
        trigger TEXT NOT NULL CHECK(trigger IN ('branch_created','pull_request_completed')),
        target_status_id UUID NOT NULL REFERENCES stash_workflow_statuses(id), enabled BOOLEAN NOT NULL DEFAULT TRUE,
        created_by_account_id UUID NOT NULL REFERENCES stash_accounts(id), created_at TIMESTAMPTZ NOT NULL,
        UNIQUE(project_id,trigger)
      );
      CREATE TABLE IF NOT EXISTS stash_automation_transitions (
        id UUID PRIMARY KEY, automation_id UUID NOT NULL REFERENCES stash_automation_recipes(id) ON DELETE CASCADE,
        signal_id UUID NOT NULL REFERENCES stash_github_signals(id) ON DELETE CASCADE,
        task_id UUID NOT NULL REFERENCES stash_tasks(id) ON DELETE CASCADE, project_id UUID NOT NULL REFERENCES stash_projects(id) ON DELETE CASCADE,
        before_status_id UUID NOT NULL REFERENCES stash_workflow_statuses(id), after_status_id UUID NOT NULL REFERENCES stash_workflow_statuses(id),
        occurred_at TIMESTAMPTZ NOT NULL, reversed_at TIMESTAMPTZ, reversed_by_account_id UUID REFERENCES stash_accounts(id),
        UNIQUE(automation_id,signal_id,task_id)
      );
      CREATE TABLE IF NOT EXISTS stash_automation_failures (
        id UUID PRIMARY KEY, automation_id UUID NOT NULL REFERENCES stash_automation_recipes(id) ON DELETE CASCADE,
        signal_id UUID NOT NULL REFERENCES stash_github_signals(id) ON DELETE CASCADE,
        task_id UUID NOT NULL REFERENCES stash_tasks(id) ON DELETE CASCADE, project_id UUID NOT NULL REFERENCES stash_projects(id) ON DELETE CASCADE,
        occurred_at TIMESTAMPTZ NOT NULL, activity JSONB NOT NULL, recipient_member_id UUID NOT NULL REFERENCES stash_accounts(id),
        summary TEXT NOT NULL, UNIQUE(automation_id,signal_id,task_id)
      );
    `);
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
        workflow_revision INTEGER NOT NULL DEFAULT 0 CHECK (workflow_revision >= 0),
        UNIQUE (workspace_id, project_key)
      );
      ALTER TABLE stash_projects ADD COLUMN IF NOT EXISTS next_task_number INTEGER NOT NULL DEFAULT 1 CHECK (next_task_number > 0);
      ALTER TABLE stash_projects ADD COLUMN IF NOT EXISTS workflow_revision INTEGER NOT NULL DEFAULT 0 CHECK (workflow_revision >= 0);
    `);
    await this.#ensurePortableProjectionSchema(client);
  }

  async #ensureNotificationSchema(transactionClient?: PoolClient): Promise<void> {
    const client = transactionClient ?? await this.#pool.connect();
    try {
      await this.#ensureWorkspaceProjectSchema(client);
      await client.query(`CREATE TABLE IF NOT EXISTS stash_notification_preferences (
        member_id UUID NOT NULL REFERENCES stash_accounts(id) ON DELETE CASCADE,
        project_id UUID NOT NULL REFERENCES stash_projects(id) ON DELETE CASCADE,
        activity TEXT NOT NULL CHECK (activity IN ('all','followed','muted')),
        digest TEXT NOT NULL CHECK (digest IN ('off','daily','weekly')),
        quiet_start TEXT, quiet_end TEXT, quiet_time_zone TEXT,
        CHECK ((quiet_start IS NULL AND quiet_end IS NULL AND quiet_time_zone IS NULL) OR
          (quiet_start IS NOT NULL AND quiet_end IS NOT NULL AND quiet_time_zone IS NOT NULL)),
        PRIMARY KEY (member_id,project_id)
      );
      CREATE TABLE IF NOT EXISTS stash_project_follows (
        member_id UUID NOT NULL REFERENCES stash_accounts(id) ON DELETE CASCADE,
        project_id UUID NOT NULL REFERENCES stash_projects(id) ON DELETE CASCADE,
        followed_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (member_id,project_id)
      );
      CREATE TABLE IF NOT EXISTS stash_notifications (
        id UUID PRIMARY KEY,
        member_id UUID NOT NULL REFERENCES stash_accounts(id) ON DELETE CASCADE,
        workspace_id UUID NOT NULL REFERENCES stash_workspaces(id) ON DELETE CASCADE,
        project_id UUID NOT NULL REFERENCES stash_projects(id) ON DELETE CASCADE,
        trigger TEXT NOT NULL CHECK (trigger IN ('direct_mention','assignment','requested_review','automation_failure','followed_change')),
        summary TEXT NOT NULL,
        activity JSONB NOT NULL,
        activity_id TEXT GENERATED ALWAYS AS (activity->>'id') STORED,
        created_at TIMESTAMPTZ NOT NULL,
        delivery TEXT NOT NULL CHECK (delivery IN ('immediate','quiet_hours')),
        read_at TIMESTAMPTZ,
        digested_at TIMESTAMPTZ,
        UNIQUE (member_id,activity_id,trigger)
      );
      ALTER TABLE stash_notifications ADD COLUMN IF NOT EXISTS digested_at TIMESTAMPTZ;
      ALTER TABLE stash_notifications ALTER COLUMN project_id DROP NOT NULL;
      CREATE INDEX IF NOT EXISTS stash_notifications_member_created_idx ON stash_notifications(member_id,created_at DESC)`);
    } finally { if (!transactionClient) client.release(); }
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
      CREATE TABLE IF NOT EXISTS stash_mobile_capture_receipts (
        account_id UUID NOT NULL REFERENCES stash_accounts(id),
        client_capture_id UUID NOT NULL,
        note_id UUID NOT NULL REFERENCES stash_notes(id),
        payload_digest TEXT,
        PRIMARY KEY (account_id, client_capture_id)
      );
      ALTER TABLE stash_mobile_capture_receipts ADD COLUMN IF NOT EXISTS payload_digest TEXT;
      ALTER TABLE stash_notes ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
      ALTER TABLE stash_notes ADD COLUMN IF NOT EXISTS portable_path TEXT;
      ALTER TABLE stash_notes ADD COLUMN IF NOT EXISTS location_revision INTEGER NOT NULL DEFAULT 1 CHECK (location_revision > 0);
      UPDATE stash_notes SET portable_path='notes/' || id::text || '.md' WHERE portable_path IS NULL;
      ALTER TABLE stash_notes ALTER COLUMN portable_path SET NOT NULL;
      CREATE OR REPLACE FUNCTION stash_assign_note_portable_path() RETURNS TRIGGER AS $assign_note_path$
      BEGIN
        IF NEW.portable_path IS NULL THEN NEW.portable_path := 'notes/' || NEW.id::text || '.md'; END IF;
        RETURN NEW;
      END
      $assign_note_path$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS stash_assign_note_portable_path ON stash_notes;
      CREATE TRIGGER stash_assign_note_portable_path BEFORE INSERT ON stash_notes
        FOR EACH ROW EXECUTE FUNCTION stash_assign_note_portable_path();
      CREATE UNIQUE INDEX IF NOT EXISTS stash_notes_workspace_portable_path ON stash_notes(workspace_id,portable_path);
      CREATE TABLE IF NOT EXISTS stash_note_path_aliases (
        workspace_id UUID NOT NULL REFERENCES stash_workspaces(id), note_id UUID NOT NULL REFERENCES stash_notes(id), path TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(workspace_id,path), UNIQUE(note_id,path)
      );
      CREATE TABLE IF NOT EXISTS stash_note_links (
        id UUID PRIMARY KEY, workspace_id UUID NOT NULL REFERENCES stash_workspaces(id),
        source_note_id UUID NOT NULL REFERENCES stash_notes(id), target_note_id UUID NOT NULL REFERENCES stash_notes(id),
        UNIQUE (source_note_id, target_note_id)
      );
      ALTER TABLE stash_note_links ALTER COLUMN target_note_id DROP NOT NULL;
      ALTER TABLE stash_note_links ADD COLUMN IF NOT EXISTS target_path TEXT;
      ALTER TABLE stash_note_links ADD COLUMN IF NOT EXISTS candidate_note_ids UUID[] NOT NULL DEFAULT '{}';
      ALTER TABLE stash_note_links ADD COLUMN IF NOT EXISTS label TEXT NOT NULL DEFAULT 'Note';
      ALTER TABLE stash_note_links ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0);
      UPDATE stash_note_links link SET target_path=note.portable_path FROM stash_notes note
        WHERE link.target_note_id=note.id AND link.target_path IS NULL;
      INSERT INTO stash_portable_projection_outbox(object_kind,object_id,revision,projection_schema,payload)
      SELECT 'NoteLocation',note.id,1,'stash.note-location.v1',jsonb_build_object(
        'schema','stash.note-location.v1','noteId',note.id,'workspaceId',note.workspace_id,'path',note.portable_path,
        'aliases','[]'::jsonb,'revision',note.location_revision)
      FROM stash_notes note WHERE NOT EXISTS (SELECT 1 FROM stash_portable_projection_outbox projection
        WHERE projection.object_kind='NoteLocation' AND projection.object_id=note.id);
      CREATE TABLE IF NOT EXISTS stash_workflow_statuses (
        id UUID PRIMARY KEY, project_id UUID NOT NULL REFERENCES stash_projects(id), name TEXT NOT NULL,
        category TEXT NOT NULL CHECK (category IN ('unstarted', 'started', 'completed')), position INTEGER NOT NULL,
        archived BOOLEAN NOT NULL DEFAULT FALSE,
        UNIQUE (project_id, name), UNIQUE (project_id, position)
      );
      ALTER TABLE stash_workflow_statuses ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT FALSE;
      CREATE TABLE IF NOT EXISTS stash_tasks (
        id UUID PRIMARY KEY, workspace_id UUID NOT NULL REFERENCES stash_workspaces(id), project_id UUID NOT NULL REFERENCES stash_projects(id),
        task_key TEXT NOT NULL, workflow_status_id UUID NOT NULL REFERENCES stash_workflow_statuses(id),
        title TEXT NOT NULL CHECK (length(title) > 0), created_by_account_id UUID NOT NULL REFERENCES stash_accounts(id), created_at TIMESTAMPTZ NOT NULL,
        UNIQUE (project_id, task_key)
      );
      CREATE TABLE IF NOT EXISTS stash_task_key_aliases (
        project_id UUID NOT NULL REFERENCES stash_projects(id),
        task_key TEXT NOT NULL,
        task_id UUID NOT NULL REFERENCES stash_tasks(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (project_id, task_key),
        UNIQUE (task_id, project_id, task_key)
      );
      CREATE TABLE IF NOT EXISTS stash_workspace_activity (
        id UUID PRIMARY KEY,
        workspace_id UUID NOT NULL REFERENCES stash_workspaces(id) ON DELETE CASCADE,
        object_kind TEXT NOT NULL,
        object_id UUID NOT NULL,
        action TEXT NOT NULL,
        actor_account_id UUID NOT NULL REFERENCES stash_accounts(id),
        cause TEXT NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL,
        before_state JSONB NOT NULL,
        after_state JSONB NOT NULL
      );
      ALTER TABLE stash_tasks ADD COLUMN IF NOT EXISTS assignee_ids JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(assignee_ids) = 'array');
      ALTER TABLE stash_tasks ADD COLUMN IF NOT EXISTS former_assignee_ids JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(former_assignee_ids) = 'array');
      ALTER TABLE stash_tasks ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'none' CHECK (priority IN ('none','low','medium','high','urgent'));
      ALTER TABLE stash_tasks ADD COLUMN IF NOT EXISTS label_names JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(label_names) = 'array');
      ALTER TABLE stash_tasks ADD COLUMN IF NOT EXISTS due_date DATE;
      ALTER TABLE stash_tasks ADD COLUMN IF NOT EXISTS estimate DOUBLE PRECISION CHECK (estimate >= 0);
      ALTER TABLE stash_tasks ADD COLUMN IF NOT EXISTS linked_note_ids JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(linked_note_ids) = 'array');
      ALTER TABLE stash_tasks ADD COLUMN IF NOT EXISTS development_links JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(development_links) = 'array');
      ALTER TABLE stash_tasks ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0);
      ALTER TABLE stash_tasks ADD COLUMN IF NOT EXISTS field_revisions JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(field_revisions) = 'object');
      CREATE TABLE IF NOT EXISTS stash_task_edit_operations (
        task_id UUID NOT NULL REFERENCES stash_tasks(id) ON DELETE CASCADE, operation_id UUID NOT NULL,
        digest TEXT NOT NULL, outcome JSONB NOT NULL, PRIMARY KEY (task_id, operation_id)
      );
      CREATE TABLE IF NOT EXISTS stash_task_edit_conflicts (
        id UUID PRIMARY KEY, task_id UUID NOT NULL REFERENCES stash_tasks(id) ON DELETE CASCADE,
        base_revision INTEGER NOT NULL, current_revision INTEGER NOT NULL, fields JSONB NOT NULL,
        contribution JSONB NOT NULL, created_by_account_id UUID NOT NULL REFERENCES stash_accounts(id), created_by_display_name TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        resolved_at TIMESTAMPTZ, resolution TEXT CHECK (resolution IN ('keep_current','apply_contribution'))
      );
      ALTER TABLE stash_task_edit_conflicts ADD COLUMN IF NOT EXISTS created_by_display_name TEXT;
      UPDATE stash_task_edit_conflicts conflict SET created_by_display_name = account.name FROM stash_accounts account
        WHERE conflict.created_by_account_id = account.id AND conflict.created_by_display_name IS NULL;
      ALTER TABLE stash_task_edit_conflicts ALTER COLUMN created_by_display_name SET NOT NULL;
      CREATE TABLE IF NOT EXISTS stash_task_note_sources (
        task_id UUID NOT NULL REFERENCES stash_tasks(id), note_id UUID NOT NULL REFERENCES stash_notes(id), PRIMARY KEY (task_id, note_id)
      );
      CREATE TABLE IF NOT EXISTS stash_task_block_sources (
        task_id UUID NOT NULL REFERENCES stash_tasks(id), note_id UUID NOT NULL REFERENCES stash_notes(id), block_id UUID NOT NULL,
        PRIMARY KEY (task_id, note_id, block_id)
      );
      CREATE TABLE IF NOT EXISTS stash_task_dependencies (
        dependent_task_id UUID NOT NULL REFERENCES stash_tasks(id),
        prerequisite_task_id UUID NOT NULL REFERENCES stash_tasks(id),
        PRIMARY KEY (dependent_task_id, prerequisite_task_id),
        CHECK (dependent_task_id <> prerequisite_task_id)
      )
    `);
    const legacyColumn = await client.query<{ present: boolean }>(`SELECT EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'stash_tasks' AND column_name = 'dependencies') AS present`);
    if (legacyColumn.rows[0]?.present) {
      const [legacyRows, existingEdges] = await Promise.all([
        client.query<{ id: string; workspace_id: string; dependencies: unknown }>("SELECT id, workspace_id, dependencies FROM stash_tasks"),
        client.query<{ dependent_task_id: string; prerequisite_task_id: string }>("SELECT dependent_task_id, prerequisite_task_id FROM stash_task_dependencies"),
      ]);
      planLegacyTaskDependencyMigration(legacyRows.rows.map((row) => ({ id: row.id, workspaceId: row.workspace_id, dependencies: row.dependencies })),
        existingEdges.rows.map((edge) => ({ dependentTaskId: edge.dependent_task_id, prerequisiteTaskId: edge.prerequisite_task_id })));
    }
    await client.query(`DO $legacy_task_dependencies$
      DECLARE invalid_count BIGINT; cycle_found BOOLEAN;
      BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
          AND table_name = 'stash_tasks' AND column_name = 'dependencies') THEN
          EXECUTE $validate_shape$
            SELECT count(*) FROM stash_tasks task CROSS JOIN LATERAL jsonb_array_elements(task.dependencies) relation
            WHERE jsonb_typeof(relation) <> 'object' OR jsonb_object_length(relation) <> 2
              OR NOT (relation ? 'taskId' AND relation ? 'type')
              OR relation->>'type' NOT IN ('depends_on', 'required_by')
              OR relation->>'taskId' !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
          $validate_shape$ INTO invalid_count;
          IF invalid_count > 0 THEN
            RAISE EXCEPTION 'Legacy Task dependency migration aborted: % malformed relationship entries; repair stash_tasks.dependencies before retrying.', invalid_count;
          END IF;

          EXECUTE $validate_references$
            SELECT count(*) FROM stash_tasks task CROSS JOIN LATERAL jsonb_array_elements(task.dependencies) relation
            LEFT JOIN stash_tasks related ON related.id = (relation->>'taskId')::uuid
            WHERE related.id IS NULL OR related.workspace_id <> task.workspace_id OR related.id = task.id
          $validate_references$ INTO invalid_count;
          IF invalid_count > 0 THEN
            RAISE EXCEPTION 'Legacy Task dependency migration aborted: % missing, cross-Workspace, or self relationships; repair stash_tasks.dependencies before retrying.', invalid_count;
          END IF;

          EXECUTE $validate_cycles$
            WITH RECURSIVE normalized_edges(dependent_id, prerequisite_id) AS (
              SELECT edge.dependent_task_id, edge.prerequisite_task_id FROM stash_task_dependencies edge
              UNION
              SELECT CASE relation->>'type' WHEN 'depends_on' THEN task.id ELSE (relation->>'taskId')::uuid END,
                CASE relation->>'type' WHEN 'depends_on' THEN (relation->>'taskId')::uuid ELSE task.id END
              FROM stash_tasks task CROSS JOIN LATERAL jsonb_array_elements(task.dependencies) relation
            ), reach(source_id, target_id) AS (
              SELECT dependent_id, prerequisite_id FROM normalized_edges
              UNION
              SELECT reach.source_id, edge.prerequisite_id FROM reach
              JOIN normalized_edges edge ON edge.dependent_id = reach.target_id
            ) SELECT EXISTS (SELECT 1 FROM reach WHERE source_id = target_id)
          $validate_cycles$ INTO cycle_found;
          IF cycle_found THEN
            RAISE EXCEPTION 'Legacy Task dependency migration aborted: the normalized relationship graph contains a cycle; repair stash_tasks.dependencies before retrying.';
          END IF;

          EXECUTE $backfill$
            INSERT INTO stash_task_dependencies (dependent_task_id, prerequisite_task_id)
            SELECT CASE relation->>'type' WHEN 'depends_on' THEN task.id ELSE (relation->>'taskId')::uuid END,
              CASE relation->>'type' WHEN 'depends_on' THEN (relation->>'taskId')::uuid ELSE task.id END
            FROM stash_tasks task CROSS JOIN LATERAL jsonb_array_elements(task.dependencies) relation
            ON CONFLICT DO NOTHING
          $backfill$;
          EXECUTE 'ALTER TABLE stash_tasks DROP COLUMN dependencies';
        END IF;
      END
    $legacy_task_dependencies$`);
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

  async #ensureBoardSchema(client: PoolClient): Promise<void> {
    await this.#ensureNoteSchema(client);
    await client.query(`CREATE TABLE IF NOT EXISTS stash_boards (
      id UUID PRIMARY KEY, project_id UUID NOT NULL REFERENCES stash_projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100), group_by TEXT NOT NULL CHECK (group_by IN ('status','priority')),
      created_at TIMESTAMPTZ NOT NULL, UNIQUE (project_id, name))`);
  }

  async #ensureNoteSchemaForPool(): Promise<void> {
    const client = await this.#pool.connect();
    try { await this.#ensureNoteSchema(client); } finally { client.release(); }
  }

  async #ensureAttachmentSchema(client: PoolClient): Promise<void> {
    await this.#ensureWorkspaceProjectSchema(client);
    await client.query(`CREATE TABLE IF NOT EXISTS stash_attachments (id UUID PRIMARY KEY, workspace_id UUID NOT NULL REFERENCES stash_workspaces(id), filename TEXT NOT NULL, content_type TEXT NOT NULL, byte_size BIGINT NOT NULL CHECK (byte_size > 0), relative_path TEXT NOT NULL, storage_key TEXT NOT NULL UNIQUE, source TEXT NOT NULL CHECK (source IN ('upload','paste')), created_by_account_id UUID NOT NULL REFERENCES stash_accounts(id), created_at TIMESTAMPTZ NOT NULL)`);
    await client.query(`CREATE TABLE IF NOT EXISTS stash_attachment_operation_receipts (
      operation_key UUID NOT NULL, workspace_id UUID NOT NULL REFERENCES stash_workspaces(id),
      created_by_account_id UUID NOT NULL REFERENCES stash_accounts(id), payload_digest TEXT NOT NULL,
      attachment_id UUID NOT NULL UNIQUE REFERENCES stash_attachments(id), projection JSONB NOT NULL,
      PRIMARY KEY (operation_key, workspace_id, created_by_account_id))`);
  }

  async #ensureDiscussionSchema(client: PoolClient): Promise<void> {
    await this.#ensureNoteSchema(client);
    await client.query(`CREATE TABLE IF NOT EXISTS stash_discussions (
      id UUID PRIMARY KEY, workspace_id UUID NOT NULL REFERENCES stash_workspaces(id),
      target_kind TEXT NOT NULL CHECK (target_kind IN ('note','block','task')),
      note_id UUID REFERENCES stash_notes(id), block_id UUID, task_id UUID REFERENCES stash_tasks(id),
      created_at TIMESTAMPTZ NOT NULL, resolved_at TIMESTAMPTZ,
      CHECK ((target_kind = 'note' AND note_id IS NOT NULL AND block_id IS NULL AND task_id IS NULL)
        OR (target_kind = 'block' AND note_id IS NOT NULL AND block_id IS NOT NULL AND task_id IS NULL)
        OR (target_kind = 'task' AND note_id IS NULL AND block_id IS NULL AND task_id IS NOT NULL))
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS stash_discussion_messages (
      id UUID PRIMARY KEY, discussion_id UUID NOT NULL REFERENCES stash_discussions(id) ON DELETE CASCADE,
      content TEXT NOT NULL CHECK (char_length(content) BETWEEN 1 AND 20000),
      author_account_id UUID NOT NULL REFERENCES stash_accounts(id), created_at TIMESTAMPTZ NOT NULL
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS stash_discussion_work_links (
      id UUID PRIMARY KEY, discussion_id UUID NOT NULL REFERENCES stash_discussions(id) ON DELETE RESTRICT,
      work_kind TEXT NOT NULL CHECK (work_kind IN ('note','task')),
      note_id UUID REFERENCES stash_notes(id) ON DELETE RESTRICT, task_id UUID REFERENCES stash_tasks(id) ON DELETE RESTRICT,
      selected_message_ids JSONB NOT NULL, created_by_account_id UUID NOT NULL REFERENCES stash_accounts(id), created_at TIMESTAMPTZ NOT NULL,
      CHECK ((work_kind = 'note' AND note_id IS NOT NULL AND task_id IS NULL)
        OR (work_kind = 'task' AND note_id IS NULL AND task_id IS NOT NULL))
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS stash_discussion_work_receipts (
      account_id UUID NOT NULL REFERENCES stash_accounts(id), idempotency_key UUID NOT NULL,
      fingerprint TEXT NOT NULL, outcome JSONB NOT NULL, PRIMARY KEY (account_id, idempotency_key)
    )`);
  }

  async #readDiscussion(client: PoolClient, memberId: string, discussionId: string, lock: boolean): Promise<DiscussionRecord | undefined> {
    const result = await client.query<any>(`SELECT discussion.*, note.document FROM stash_discussions discussion
      JOIN stash_workspaces workspace ON workspace.id = discussion.workspace_id
      LEFT JOIN stash_notes note ON note.id = discussion.note_id
      LEFT JOIN stash_tasks target_task ON target_task.id = discussion.task_id
      WHERE discussion.id = $1 AND ((workspace.owner_type = 'personal' AND workspace.personal_owner_id = $2) OR EXISTS (
        SELECT 1 FROM stash_organization_memberships membership WHERE membership.organization_id = workspace.organization_owner_id
          AND membership.account_id = $2) OR (discussion.target_kind IN ('note','block') AND note.project_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM stash_project_guests guest WHERE guest.project_id = note.project_id AND guest.account_id = $2
      )) OR (discussion.target_kind = 'task' AND EXISTS (
        SELECT 1 FROM stash_project_guests guest WHERE guest.project_id = target_task.project_id AND guest.account_id = $2
      )))${lock ? " FOR UPDATE OF discussion" : ""}`, [discussionId, memberId]);
    const row = result.rows[0];
    if (!row) return undefined;
    const messages = await client.query<any>(`SELECT message.id, message.content, message.created_at,
      account.id AS author_id, account.name AS author_name FROM stash_discussion_messages message
      JOIN stash_accounts account ON account.id = message.author_account_id
      WHERE message.discussion_id = $1 ORDER BY message.created_at, message.id`, [discussionId]);
    let target: DiscussionTarget;
    if (row.target_kind === "task") target = { kind: "task", taskId: row.task_id };
    else if (row.target_kind === "note") target = { kind: "note", noteId: row.note_id };
    else {
      const matches = Array.isArray(row.document?.blocks)
        ? row.document.blocks.filter((block: { id?: string }) => block.id === row.block_id).length : 0;
      target = { kind: "block", noteId: row.note_id, blockId: row.block_id,
        state: matches === 1 ? "attached" : matches > 1 ? "ambiguous" : "block_missing" };
    }
    return { id: row.id, workspaceId: row.workspace_id, target,
      messages: messages.rows.map((message: any) => ({ id: message.id, content: message.content,
        author: { localAccountId: message.author_id, displayName: message.author_name },
        createdAt: new Date(message.created_at).toISOString() })),
      createdAt: new Date(row.created_at).toISOString(), ...(row.resolved_at ? { resolvedAt: new Date(row.resolved_at).toISOString() } : {}) };
  }

  async #canWriteDiscussion(client: PoolClient, memberId: string, workspaceId: string): Promise<boolean> {
    const result = await client.query(`SELECT 1 FROM stash_workspaces workspace WHERE workspace.id = $1
      AND ((workspace.owner_type = 'personal' AND workspace.personal_owner_id = $2) OR
        (workspace.owner_type = 'organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
          WHERE membership.organization_id = workspace.organization_owner_id AND membership.account_id = $2)))`,
    [workspaceId, memberId]);
    return result.rowCount === 1;
  }

  #portableDiscussion(discussion: DiscussionRecord): PortableDiscussionProjection {
    const target: PortableDiscussionTarget = discussion.target.kind === "block"
      ? { kind: "block", noteId: discussion.target.noteId, blockId: discussion.target.blockId }
      : discussion.target;
    return { schema: "stash.discussion.v1", id: discussion.id, workspaceId: discussion.workspaceId,
      target, messages: discussion.messages, createdAt: discussion.createdAt,
      ...(discussion.resolvedAt ? { resolvedAt: discussion.resolvedAt } : {}) };
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
    objectKind: "Workspace" | "Project" | "Workflow" | "Board" | "Note" | "NoteLocation" | "NoteLink" | "Task" | "GuestProjectAccess" | "RepositoryConnection" | "Attachment" | "Discussion" | "DiscussionWorkLink" | "Activity",
    objectId: string,
    projectionSchema: "stash.workspace.v1" | "stash.project.v1" | "stash.workflow.v1" | "stash.board.v1" | "stash.note.v1" | "stash.note.v2" | "stash.note-location.v1" | "stash.note-link.v1" | "stash.note-link.v2" | "stash.task.v1" | "stash.guest-project-access.v1" | "stash.repository-connection.v1" | "stash.attachment.v1" | "stash.discussion.v1" | "stash.discussion-work-link.v1" | "stash.activity.v1",
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

  async #recordInitialNoteLocation(client: PoolClient, noteId: string, workspaceId: string): Promise<void> {
    const projection: PortableNoteLocationProjection = { schema: "stash.note-location.v1", noteId, workspaceId,
      path: `notes/${noteId}.md`, aliases: [], revision: 1 };
    await this.#recordPortableProjection(client, "NoteLocation", noteId, projection.schema, projection);
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
      projectIds: record.projectIds, ownership: record.ownership ?? "organization", state: record.state ?? "active",
    };
    await client.query(
      `INSERT INTO stash_portable_projection_outbox (object_kind, object_id, revision, projection_schema, payload)
       VALUES ('RepositoryConnection', $1, $2, 'stash.repository-connection.v1', $3::jsonb)`,
      [record.id, revision, JSON.stringify(projection)],
    );
  }

  async findWorkspaceImport(importId: string) {
    const client = await this.#pool.connect();
    try {
      await this.#ensureWorkspaceImportSchema(client);
      const found = await client.query<{ archive_sha256: string; report: PortableWorkspaceImportReport }>(
        "SELECT archive_sha256,report FROM stash_workspace_imports WHERE import_id=$1", [importId]);
      return found.rows[0] ? { archiveSha256: found.rows[0].archive_sha256, report: found.rows[0].report } : undefined;
    } finally { client.release(); }
  }

  async importWorkspace(importId: string, bundle: PortableWorkspaceImportBundle) {
    return this.#withTransaction(async (client) => {
      await this.#ensureWorkspaceImportSchema(client);
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`workspace-import:${importId}`]);
      const receipt = await client.query<{ archive_sha256: string; report: PortableWorkspaceImportReport }>(
        "SELECT archive_sha256,report FROM stash_workspace_imports WHERE import_id=$1", [importId]);
      if (receipt.rows[0]) return receipt.rows[0].archive_sha256 === bundle.archiveSha256
        ? { status: "duplicate" as const, report: receipt.rows[0].report } : { status: "workspace_conflict" as const };
      const owner = await client.query<{name:string}>("SELECT name FROM stash_accounts WHERE id=$1", [bundle.destinationOwnerAccountId]);
      if (!owner.rowCount) return { status: "forbidden" as const };
      const state = bundle.state;
      if ((await client.query("SELECT 1 FROM stash_workspaces WHERE id=$1", [state.workspace.id])).rowCount)
        return { status: "workspace_conflict" as const };
      const identityAccounts = new Map<string, string>();
      for (const identity of bundle.identityStubs) {
        const existing = await client.query<{ account_id: string; mapped_to_account_id: string | null }>(
          "SELECT account_id,mapped_to_account_id FROM stash_identity_stubs WHERE source_account_id=$1", [identity.sourceAccountId]);
        const accountId = existing.rows[0]?.account_id ?? randomUUID();
        if (!existing.rows[0]) {
          await client.query("INSERT INTO stash_accounts(id,name,email,password_hash) VALUES($1,$2,$3,$4)", [accountId, identity.displayName,
            `identity-stub+${accountId}@invalid`, this.#authenticationSecrets.encrypt(randomUUID())]);
          await client.query("INSERT INTO stash_identity_stubs(source_account_id,account_id,display_name) VALUES($1,$2,$3)",
            [identity.sourceAccountId, accountId, identity.displayName]);
        }
        // A mapping is an explicit Instance-level decision and therefore also
        // applies to later imports carrying the same portable source identity.
        identityAccounts.set(identity.sourceAccountId, existing.rows[0]?.mapped_to_account_id ?? accountId);
      }
      const accountFor = (identity: { localAccountId: string }) => identityAccounts.get(identity.localAccountId)!;
      await client.query(`INSERT INTO stash_workspaces(id,name,owner_type,personal_owner_id,created_by_account_id)
        VALUES($1,$2,'personal',$3,$4)`, [state.workspace.id, state.workspace.name, bundle.destinationOwnerAccountId, accountFor(state.workspace.createdBy)]);
      const importedWorkspace: PortableWorkspaceProjection = {...state.workspace,owner:{type:"personal",identity:{localAccountId:bundle.destinationOwnerAccountId,displayName:owner.rows[0]!.name}}};
      await this.#recordPortableProjection(client, "Workspace", state.workspace.id, importedWorkspace.schema, importedWorkspace);
      const durable = state.durableObjects.map((item) => ({ ...item, payload: item.payload as any }));
      for (const item of durable.filter(({ kind }) => kind === "Project")) {
        const project = item.payload;
        await client.query("INSERT INTO stash_projects(id,workspace_id,name,project_key,created_by_account_id,workflow_revision) VALUES($1,$2,$3,$4,$5,$6)",
          [project.id, state.workspace.id, project.name, project.key, accountFor(project.createdBy), 0]);
        await this.#recordPortableProjection(client, "Project", item.id, item.schema as any, project);
      }
      for (const item of durable.filter(({ kind }) => kind === "Workflow")) {
        const workflow = item.payload as ProjectWorkflow;
        await client.query("UPDATE stash_projects SET workflow_revision=$2 WHERE id=$1", [workflow.projectId, workflow.revision]);
        for (const status of workflow.statuses) await client.query(`INSERT INTO stash_workflow_statuses
          (id,project_id,name,category,position,archived) VALUES($1,$2,$3,$4,$5,$6)`,
        [status.id, workflow.projectId, status.name, status.category, status.position, status.archived]);
        await this.#recordPortableProjection(client, "Workflow", item.id, item.schema as any, workflow);
      }
      for (const note of state.notes) {
        const history = state.noteHistory.filter((revision) => revision.noteId === note.id).sort((a,b) => a.revision-b.revision);
        const latest = history.at(-1); const location = state.noteLocations.find(({ noteId }) => noteId === note.id)!;
        await client.query(`INSERT INTO stash_notes(id,workspace_id,project_id,content,document,revision,tags,reminder_at,
          created_by_account_id,created_at,portable_path,location_revision) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8,$9,$10,$11,$12)`,
        [note.id,state.workspace.id,note.projectId ?? null,note.content,JSON.stringify(latest?.document ?? markdownToRichText(note.content)),
          latest?.revision ?? 1,JSON.stringify(note.tags),note.reminder?.at ?? null,accountFor(note.createdBy),note.createdAt,location.path,location.revision]);
        for (const alias of location.aliases) await client.query("INSERT INTO stash_note_path_aliases(workspace_id,note_id,path) VALUES($1,$2,$3)",
          [state.workspace.id,note.id,alias]);
        await this.#recordPortableProjection(client,"Note",note.id,note.schema,note);
        await this.#recordPortableProjection(client,"NoteLocation",note.id,location.schema,location);
      }
      for (const task of state.tasks) {
        await client.query(`INSERT INTO stash_tasks(id,workspace_id,project_id,task_key,workflow_status_id,title,created_by_account_id,created_at,
          assignee_ids,former_assignee_ids,priority,label_names,due_date,estimate,linked_note_ids,development_links)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12::jsonb,$13,$14,$15::jsonb,$16::jsonb)`,
        [task.id,state.workspace.id,task.projectId,task.key,task.status.id,task.title,accountFor(task.createdBy),task.createdAt,
          JSON.stringify(task.assigneeIds ?? []),JSON.stringify(task.formerAssigneeIds ?? []),task.priority ?? "none",
          JSON.stringify(task.labelNames ?? []),task.dueDate ?? null,task.estimate ?? null,
          JSON.stringify(task.linkedNoteIds ?? []),JSON.stringify(task.developmentLinks ?? [])]);
        for (const noteId of task.sourceNoteIds) await client.query("INSERT INTO stash_task_note_sources(task_id,note_id) VALUES($1,$2)",[task.id,noteId]);
        for (const source of task.sourceBlocks ?? []) await client.query("INSERT INTO stash_task_block_sources(task_id,note_id,block_id) VALUES($1,$2,$3)",[task.id,source.noteId,source.blockId]);
        for (const alias of task.keyAliases ?? []) await client.query("INSERT INTO stash_task_key_aliases(project_id,task_key,task_id) VALUES($1,$2,$3)",[alias.projectId,alias.key,task.id]);
        await this.#recordPortableProjection(client,"Task",task.id,task.schema,task);
      }
      for (const task of state.tasks) for (const edge of task.dependencies ?? []) if (edge.type === "depends_on")
        await client.query("INSERT INTO stash_task_dependencies(dependent_task_id,prerequisite_task_id) VALUES($1,$2) ON CONFLICT DO NOTHING",[task.id,edge.taskId]);
      for (const project of durable.filter(({ kind }) => kind === "Project").map(({ id }) => id)) {
        const numbers = state.tasks.filter(({ projectId }) => projectId === project).map(({ key }) => Number(key.slice(key.lastIndexOf("-") + 1)))
          .filter(Number.isSafeInteger);
        await client.query("UPDATE stash_projects SET next_task_number=$2 WHERE id=$1",[project,Math.max(0,...numbers)+1]);
      }
      for (const board of state.boards) { await client.query("INSERT INTO stash_boards(id,project_id,name,group_by,created_at) VALUES($1,$2,$3,$4,$5)",
        [board.id,board.projectId,board.name,board.groupBy,board.createdAt]); await this.#recordPortableProjection(client,"Board",board.id,board.schema,board); }
      for (const attachment of state.attachments) {
        await client.query(`INSERT INTO stash_attachments(id,workspace_id,filename,content_type,byte_size,relative_path,storage_key,source,created_by_account_id,created_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[attachment.id,state.workspace.id,attachment.filename,attachment.contentType,attachment.size,
          attachment.relativePath,bundle.attachmentStorageKeys.get(attachment.id),attachment.source,accountFor(attachment.createdBy),attachment.createdAt]);
        await this.#recordPortableProjection(client,"Attachment",attachment.id,attachment.schema,attachment);
      }
      for (const link of state.noteLinks) { await client.query(`INSERT INTO stash_note_links(id,workspace_id,source_note_id,target_note_id,target_path,candidate_note_ids,label,revision)
        VALUES($1,$2,$3,$4,$5,$6::uuid[],$7,$8)`,[link.id,state.workspace.id,link.sourceNoteId,link.targetNoteId ?? null,
        "targetPath" in link ? link.targetPath : null,"candidateNoteIds" in link ? link.candidateNoteIds : [],"label" in link ? link.label : "Note","revision" in link ? link.revision : 1]);
        await this.#recordPortableProjection(client,"NoteLink",link.id,link.schema,link); }
      for (const revision of state.noteHistory) await client.query(`INSERT INTO stash_note_history(note_id,workspace_id,revision,content,document,actor_account_id,cause,recorded_at)
        VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8)`,[revision.noteId,state.workspace.id,revision.revision,revision.content,JSON.stringify(revision.document),
        accountFor(revision.actor),JSON.stringify(revision.cause),revision.recordedAt]);
      for (const activity of state.activities) { await client.query(`INSERT INTO stash_workspace_activity(id,workspace_id,object_kind,object_id,action,actor_account_id,cause,occurred_at,before_state,after_state)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb)`,[activity.id,state.workspace.id,activity.object.kind,activity.object.id,activity.action,
        accountFor(activity.actor),JSON.stringify(activity.cause),activity.occurredAt,JSON.stringify(activity.before),JSON.stringify(activity.after)]);
        await this.#recordPortableProjection(client,"Activity",activity.id,activity.schema,activity); }
      for (const item of durable.filter(({ kind }) => kind === "Discussion")) {
        const discussion = item.payload as PortableDiscussionProjection; const target = discussion.target;
        await client.query(`INSERT INTO stash_discussions(id,workspace_id,target_kind,note_id,block_id,task_id,created_at,resolved_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[discussion.id,state.workspace.id,target.kind,
          target.kind === "note" || target.kind === "block" ? target.noteId : null,target.kind === "block" ? target.blockId : null,
          target.kind === "task" ? target.taskId : null,discussion.createdAt,discussion.resolvedAt ?? null]);
        for (const message of discussion.messages) await client.query(`INSERT INTO stash_discussion_messages(id,discussion_id,content,author_account_id,created_at)
          VALUES($1,$2,$3,$4,$5)`,[message.id,discussion.id,message.content,accountFor(message.author),message.createdAt]);
      }
      for (const item of durable.filter(({ kind }) => kind === "DiscussionWorkLink")) {
        const link = item.payload as PortableDiscussionWorkLinkProjection;
        await client.query(`INSERT INTO stash_discussion_work_links(id,discussion_id,work_kind,note_id,task_id,selected_message_ids,created_by_account_id,created_at)
          VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,[link.id,link.discussionId,link.work.kind,link.work.kind === "note" ? link.work.id : null,
          link.work.kind === "task" ? link.work.id : null,JSON.stringify(link.selectedMessages.map(({ id }) => id)),accountFor(link.createdBy),link.createdAt]);
      }
      for (const item of durable.filter(({ kind }) => kind === "GuestProjectAccess")) {
        const access = item.payload as any; const guestAccount = accountFor(access.guest);
        for (const project of access.projects) await client.query("INSERT INTO stash_project_guests(project_id,account_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
          [project.projectId,guestAccount]);
      }
      const integrationTransformations: ImportTransformation[] = [];
      for (const item of durable.filter(({kind})=>kind==="RepositoryConnection")) {
        const source=item.payload as any; const disconnected=source.schema==="stash.disconnected-repository-connection.v1"?source:{...source,
          schema:"stash.disconnected-repository-connection.v1",state:"disconnected",reason:"credentials_not_portable"};
        await client.query(`INSERT INTO stash_disconnected_repository_connections(id,workspace_id,payload) VALUES($1,$2,$3::jsonb)`,
          [item.id,state.workspace.id,JSON.stringify(disconnected)]);
        await this.#recordPortableProjection(client,"RepositoryConnection",item.id,disconnected.schema,disconnected);
        integrationTransformations.push({kind:source.schema===disconnected.schema?"skipped":"transformed",object:`RepositoryConnection:${item.id}`,
          reason:source.schema===disconnected.schema?"already_disconnected":"credentials_not_portable"});
      }
      for (const item of durable.filter(({ kind }) => !["Project","Workflow","RepositoryConnection"].includes(kind)))
        await this.#recordPortableProjection(client,item.kind as any,item.id,item.schema as any,item.payload);
      const ownership: ImportTransformation = {kind:"transformed",object:`Workspace:${state.workspace.id}`,
        reason:`ownership_mapped:${bundle.destinationOwnerAccountId}`};
      const transformations: ImportTransformation[] = [ownership,...bundle.identityStubs.map((identity) => ({ kind:"transformed" as const,
        object:`Identity:${identity.sourceAccountId}`,reason:"identity_stub_created" })),...integrationTransformations];
      const report: PortableWorkspaceImportReport = { schema:"stash.portable-workspace-import-report.v1",importId,
        workspaceId:state.workspace.id,archiveSha256:bundle.archiveSha256,identityStubs:bundle.identityStubs,
        transformations,transformed:transformations.filter(({kind})=>kind==="transformed"),skipped:transformations.filter(({kind})=>kind==="skipped"),
        ambiguous:transformations.filter(({kind})=>kind==="ambiguous") };
      await client.query("INSERT INTO stash_workspace_imports(import_id,archive_sha256,workspace_id,report) VALUES($1,$2,$3,$4::jsonb)",
        [importId,bundle.archiveSha256,state.workspace.id,JSON.stringify(report)]);
      return { status:"imported" as const,report };
    });
  }

  async mapImportedIdentity(input: { importId:string; sourceAccountId:string; localAccountId:string; idempotencyKey:string }) {
    return this.#withTransaction(async(client)=>{
      await this.#ensureWorkspaceImportSchema(client); await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",[`identity-map:${input.idempotencyKey}`]);
      const prior=await client.query<any>("SELECT * FROM stash_identity_mapping_receipts WHERE idempotency_key=$1",[input.idempotencyKey]);
      if(prior.rows[0]) return prior.rows[0].import_id===input.importId&&prior.rows[0].source_account_id===input.sourceAccountId&&prior.rows[0].local_account_id===input.localAccountId
        ?{status:"duplicate" as const,sourceAccountId:input.sourceAccountId,localAccountId:input.localAccountId}:{status:"conflict" as const};
      const imported=await client.query<{workspace_id:string;report:PortableWorkspaceImportReport}>("SELECT workspace_id,report FROM stash_workspace_imports WHERE import_id=$1",[input.importId]);
      if(!imported.rows[0] || !imported.rows[0].report.identityStubs.some(({sourceAccountId})=>sourceAccountId===input.sourceAccountId))
        return {status:"not_found" as const};
      const workspaceId=imported.rows[0].workspace_id;
      const local=await client.query<{name:string}>("SELECT name FROM stash_accounts WHERE id=$1",[input.localAccountId]);
      if(!local.rows[0]) return {status:"local_account_not_found" as const};
      const stub=await client.query<{account_id:string;mapped_to_account_id:string|null}>("SELECT account_id,mapped_to_account_id FROM stash_identity_stubs WHERE source_account_id=$1 FOR UPDATE",[input.sourceAccountId]);
      if(!stub.rows[0]) return {status:"not_found" as const};
      if(stub.rows[0].mapped_to_account_id&&stub.rows[0].mapped_to_account_id!==input.localAccountId) return {status:"conflict" as const};
      const stubId=stub.rows[0].account_id;
      for(const table of ["stash_workspaces","stash_projects","stash_notes","stash_tasks","stash_attachments"])
        await client.query(`UPDATE ${table} SET created_by_account_id=$1 WHERE created_by_account_id=$2 AND ${table==="stash_workspaces"?"id":"workspace_id"}=$3`,[input.localAccountId,stubId,workspaceId]);
      await client.query("UPDATE stash_note_history SET actor_account_id=$1 WHERE actor_account_id=$2 AND workspace_id=$3",[input.localAccountId,stubId,workspaceId]);
      await client.query("UPDATE stash_workspace_activity SET actor_account_id=$1 WHERE actor_account_id=$2 AND workspace_id=$3",[input.localAccountId,stubId,workspaceId]);
      await client.query(`UPDATE stash_discussion_messages message SET author_account_id=$1 FROM stash_discussions discussion
        WHERE message.discussion_id=discussion.id AND message.author_account_id=$2 AND discussion.workspace_id=$3`,[input.localAccountId,stubId,workspaceId]);
      await client.query(`UPDATE stash_discussion_work_links link SET created_by_account_id=$1 FROM stash_discussions discussion
        WHERE link.discussion_id=discussion.id AND link.created_by_account_id=$2 AND discussion.workspace_id=$3`,[input.localAccountId,stubId,workspaceId]);
      await client.query(`INSERT INTO stash_project_guests(project_id,account_id) SELECT guest.project_id,$1 FROM stash_project_guests guest
        JOIN stash_projects project ON project.id=guest.project_id WHERE guest.account_id=$2 AND project.workspace_id=$3 ON CONFLICT DO NOTHING`,[input.localAccountId,stubId,workspaceId]);
      await client.query(`DELETE FROM stash_project_guests guest USING stash_projects project WHERE guest.project_id=project.id
        AND guest.account_id=$1 AND project.workspace_id=$2`,[stubId,workspaceId]);
      const projects=await client.query<{id:string}>("SELECT id FROM stash_projects WHERE workspace_id=$1",[workspaceId]); const projectIds=new Set(projects.rows.map(({id})=>id));
      const projections=await client.query<any>("SELECT object_kind,object_id,revision,payload FROM stash_portable_projection_outbox");
      const replace=(value:unknown):unknown=>{ if(Array.isArray(value)) return value.map(replace); if(value&&typeof value==="object") { const record=value as Record<string,unknown>;
        const mapped=record.localAccountId===input.sourceAccountId&&typeof record.displayName==="string"?{...record,localAccountId:input.localAccountId,displayName:local.rows[0]!.name}:record;
        return Object.fromEntries(Object.entries(mapped).map(([key,child])=>[key,replace(child)])); } return value; };
      for(const row of projections.rows) { const payload=row.payload as any; const belongs=payload.id===workspaceId||payload.workspaceId===workspaceId||projectIds.has(payload.projectId)
        ||Array.isArray(payload.projectIds)&&payload.projectIds.some((id:string)=>projectIds.has(id))||Array.isArray(payload.projects)&&payload.projects.some((p:any)=>p.workspaceId===workspaceId);
        if(belongs&&JSON.stringify(payload).includes(input.sourceAccountId)) await client.query(`UPDATE stash_portable_projection_outbox SET payload=$4::jsonb
          WHERE object_kind=$1 AND object_id=$2 AND revision=$3`,[row.object_kind,row.object_id,row.revision,JSON.stringify(replace(payload))]); }
      const disconnected=await client.query<{id:string;payload:unknown}>("SELECT id,payload FROM stash_disconnected_repository_connections WHERE workspace_id=$1",[workspaceId]);
      for(const connection of disconnected.rows) if(JSON.stringify(connection.payload).includes(input.sourceAccountId))
        await client.query("UPDATE stash_disconnected_repository_connections SET payload=$2::jsonb WHERE id=$1",[connection.id,JSON.stringify(replace(connection.payload))]);
      await client.query("UPDATE stash_identity_stubs SET mapped_to_account_id=$2,mapped_at=now() WHERE source_account_id=$1",[input.sourceAccountId,input.localAccountId]);
      await client.query("INSERT INTO stash_identity_mapping_receipts(idempotency_key,import_id,source_account_id,local_account_id) VALUES($1,$2,$3,$4)",
        [input.idempotencyKey,input.importId,input.sourceAccountId,input.localAccountId]);
      return {status:"mapped" as const,sourceAccountId:input.sourceAccountId,localAccountId:input.localAccountId};
    });
  }

  async readExportSnapshot(memberId: string, workspaceId: string): Promise<
    { status: "found"; snapshot: PortableWorkspaceExportSnapshot }
    | { status: "workspace_forbidden" | "workspace_not_found" }
  > {
    // Schema preparation is deliberately outside the read-only snapshot transaction.
    const setup = await this.#pool.connect();
    try {
      await this.#ensureNoteSchema(setup);
      await this.#ensureNoteHistorySchema(setup);
      await this.#backfillLegacyNoteHistory(setup);
      await this.#ensureAttachmentSchema(setup);
      await this.#ensureInvitationSchema(setup);
      await this.#ensureBoardSchema(setup);
    } finally { setup.release(); }

    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const access = await client.query<{ member: boolean; guest_project_ids: string[]; workspace_projection: PortableWorkspaceProjection | null }>(
        `SELECT
          ((workspace.owner_type = 'personal' AND workspace.personal_owner_id = $2)
            OR (workspace.owner_type = 'organization' AND EXISTS (
              SELECT 1 FROM stash_organization_memberships membership
              WHERE membership.organization_id = workspace.organization_owner_id AND membership.account_id = $2))) AS member,
          ARRAY(SELECT project.id FROM stash_projects project JOIN stash_project_guests guest ON guest.project_id = project.id
            WHERE project.workspace_id = workspace.id AND guest.account_id = $2 ORDER BY project.id) AS guest_project_ids,
          projection.payload AS workspace_projection
        FROM stash_workspaces workspace
        LEFT JOIN LATERAL (SELECT payload FROM stash_portable_projection_outbox
          WHERE object_kind = 'Workspace' AND object_id = workspace.id ORDER BY revision DESC LIMIT 1) projection ON TRUE
        WHERE workspace.id = $1`, [workspaceId, memberId]);
      const permission = access.rows[0];
      if (!permission) { await client.query("COMMIT"); return { status: "workspace_not_found" }; }
      const guestProjectIds = permission.guest_project_ids ?? [];
      if (!permission.member && guestProjectIds.length === 0) { await client.query("COMMIT"); return { status: "workspace_forbidden" }; }
      if (!permission.workspace_projection) throw new Error("workspace_projection_unavailable");

      const notes = await client.query<{ id: string; payload: PortableNoteProjection | null }>(
        `SELECT note.id, projection.payload FROM stash_notes note
         LEFT JOIN LATERAL (SELECT payload FROM stash_portable_projection_outbox
           WHERE object_kind = 'Note' AND object_id = note.id ORDER BY revision DESC LIMIT 1) projection ON TRUE
         WHERE note.workspace_id = $1 AND ($2::boolean OR note.project_id = ANY($3::uuid[]))
         ORDER BY note.id`, [workspaceId, permission.member, guestProjectIds]);
      const noteLocations = await client.query<{ note_id: string; payload: PortableNoteLocationProjection | null }>(
        `SELECT note.id AS note_id, projection.payload FROM stash_notes note
         LEFT JOIN LATERAL (SELECT payload FROM stash_portable_projection_outbox
           WHERE object_kind='NoteLocation' AND object_id=note.id ORDER BY revision DESC LIMIT 1) projection ON TRUE
         WHERE note.workspace_id=$1 AND ($2::boolean OR note.project_id=ANY($3::uuid[])) ORDER BY note.id`,
      [workspaceId, permission.member, guestProjectIds]);
      const noteLinks = await client.query<{ id: string; payload: PortableNoteLinkStateProjection | PortableNoteLinkProjection | null }>(
        `SELECT link.id, projection.payload FROM stash_note_links link
         JOIN stash_notes source ON source.id=link.source_note_id
         LEFT JOIN stash_notes target ON target.id=link.target_note_id
         LEFT JOIN LATERAL (SELECT payload FROM stash_portable_projection_outbox
           WHERE object_kind='NoteLink' AND object_id=link.id ORDER BY revision DESC LIMIT 1) projection ON TRUE
         WHERE link.workspace_id=$1 AND ($2::boolean OR
           source.project_id=ANY($3::uuid[]) AND target.project_id=ANY($3::uuid[])) ORDER BY link.id`,
      [workspaceId, permission.member, guestProjectIds]);
      const tasks = await client.query<{ id: string; payload: PortableTaskProjection | null }>(
        `SELECT task.id, projection.payload FROM stash_tasks task
         LEFT JOIN LATERAL (SELECT payload FROM stash_portable_projection_outbox
           WHERE object_kind = 'Task' AND object_id = task.id ORDER BY revision DESC LIMIT 1) projection ON TRUE
         WHERE task.workspace_id = $1 AND ($2::boolean OR task.project_id = ANY($3::uuid[]))
         ORDER BY task.id`, [workspaceId, permission.member, guestProjectIds]);
      const boards = await client.query<{ id: string; payload: Board | null }>(
        `SELECT board.id, projection.payload FROM stash_boards board
         JOIN stash_projects project ON project.id = board.project_id
         LEFT JOIN LATERAL (SELECT payload FROM stash_portable_projection_outbox
           WHERE object_kind = 'Board' AND object_id = board.id ORDER BY revision DESC LIMIT 1) projection ON TRUE
         WHERE project.workspace_id = $1 AND ($2::boolean OR board.project_id = ANY($3::uuid[]))
         ORDER BY board.id`, [workspaceId, permission.member, guestProjectIds]);
      const attachments = await client.query<{ id: string; storage_key: string; payload: PortableAttachmentProjection | null }>(
        `SELECT attachment.id, attachment.storage_key, projection.payload FROM stash_attachments attachment
         LEFT JOIN LATERAL (SELECT payload FROM stash_portable_projection_outbox
           WHERE object_kind = 'Attachment' AND object_id = attachment.id ORDER BY revision DESC LIMIT 1) projection ON TRUE
         WHERE attachment.workspace_id = $1 AND ($2::boolean OR EXISTS (
           SELECT 1 FROM stash_notes note WHERE note.workspace_id = attachment.workspace_id
             AND note.project_id = ANY($3::uuid[])
             AND (strpos(note.content, attachment.relative_path) > 0
               OR strpos(note.content, replace(attachment.relative_path, '%', '%25')) > 0)))
         ORDER BY attachment.id`, [workspaceId, permission.member, guestProjectIds]);
      const activities = permission.member ? await client.query<{ payload: ActivityRecord }>(`SELECT projection.payload
        FROM stash_workspace_activity activity JOIN LATERAL (SELECT payload FROM stash_portable_projection_outbox
          WHERE object_kind='Activity' AND object_id=activity.id ORDER BY revision DESC LIMIT 1) projection ON TRUE
        WHERE activity.workspace_id=$1 ORDER BY activity.occurred_at,activity.id`, [workspaceId]) : { rows: [] };
      const histories = await client.query<any>(`SELECT history.*, actor.name AS actor_name,
        COALESCE(stub.source_account_id,history.actor_account_id::text) AS portable_actor_id FROM stash_note_history history
        JOIN stash_accounts actor ON actor.id=history.actor_account_id LEFT JOIN stash_identity_stubs stub ON stub.account_id=actor.id
        JOIN stash_notes note ON note.id=history.note_id
        WHERE history.workspace_id=$1 AND ($2::boolean OR note.project_id=ANY($3::uuid[]))
        ORDER BY history.note_id,history.revision`, [workspaceId, permission.member, guestProjectIds]);
      const durableObjects = await client.query<{ object_kind: string; object_id: string; projection_schema: string; payload: unknown }>(
        `SELECT DISTINCT ON (projection.object_kind, projection.object_id)
           projection.object_kind,projection.object_id,projection.projection_schema,projection.payload
         FROM stash_portable_projection_outbox projection
         WHERE projection.object_kind IN ('Project','Workflow','GuestProjectAccess','RepositoryConnection','Discussion','DiscussionWorkLink')
           AND (
             (projection.object_kind='Project' AND projection.payload->>'workspaceId'=$1
               AND ($2::boolean OR projection.object_id=ANY($3::uuid[])))
             OR (projection.object_kind='Workflow'
               AND (projection.payload->>'projectId')::uuid IN (SELECT id FROM stash_projects WHERE workspace_id=$1)
               AND ($2::boolean OR (projection.payload->>'projectId')::uuid=ANY($3::uuid[])))
             OR (projection.object_kind='GuestProjectAccess' AND $2::boolean AND EXISTS (
               SELECT 1 FROM jsonb_array_elements(projection.payload->'projects') selected
               WHERE selected->>'workspaceId'=$1))
             OR (projection.object_kind IN ('Discussion','DiscussionWorkLink') AND projection.payload->>'workspaceId'=$1
               AND $2::boolean)
             OR (projection.object_kind='RepositoryConnection' AND $2::boolean AND EXISTS (
               SELECT 1 FROM jsonb_array_elements_text(projection.payload->'projectIds') project_id
               WHERE project_id::uuid IN (SELECT id FROM stash_projects WHERE workspace_id=$1)))
           )
         ORDER BY projection.object_kind,projection.object_id,projection.revision DESC`,
        [workspaceId, permission.member, guestProjectIds]);
      if (notes.rows.some(({ payload }) => !payload) || tasks.rows.some(({ payload }) => !payload)
        || boards.rows.some(({ payload }) => !payload)
        || noteLocations.rows.some(({ payload }) => !payload) || noteLinks.rows.some(({ payload }) => !payload)
        || attachments.rows.some(({ payload }) => !payload)) throw new Error("portable_projection_unavailable");
      await client.query("COMMIT");
      const noteProjections = notes.rows.map(({ payload }) => payload!); const taskProjections = tasks.rows.map(({ payload }) => payload!);
      const visibleNoteIds = new Set(noteProjections.map(({ id }) => id));
      const visibleTaskIds = new Set(taskProjections.map(({ id }) => id));
      const visibleProjectIds = new Set(guestProjectIds);
      const visibleTasks = permission.member ? taskProjections : taskProjections.map((payload) => ({
        ...payload,
        sourceNoteIds: payload.sourceNoteIds.filter((id) => visibleNoteIds.has(id)),
        ...(payload.sourceBlocks ? { sourceBlocks: payload.sourceBlocks.filter(({ noteId }) => visibleNoteIds.has(noteId)) } : {}),
        ...(payload.linkedNoteIds ? { linkedNoteIds: payload.linkedNoteIds.filter((id) => visibleNoteIds.has(id)) } : {}),
        ...(payload.dependencies ? { dependencies: payload.dependencies.filter(({ taskId }) => visibleTaskIds.has(taskId)) } : {}),
        ...(payload.keyAliases ? { keyAliases: payload.keyAliases.filter(({ projectId }) => visibleProjectIds.has(projectId)) } : {}),
      }));
      return { status: "found", snapshot: {
        workspace: permission.workspace_projection,
        notes: noteProjections,
        tasks: visibleTasks,
        boards: boards.rows.map(({ payload }) => payload!),
        attachments: attachments.rows.map(({ storage_key, payload }) => ({ storageKey: storage_key, projection: payload! })),
        noteLocations: noteLocations.rows.map(({ payload }) => payload!),
        noteLinks: noteLinks.rows.map(({ payload }) => payload!),
        activities: activities.rows.map(({ payload }) => payload),
        noteHistory: histories.rows.map((row): NoteHistoryRevision => ({ noteId: row.note_id, workspaceId: row.workspace_id,
          revision: Number(row.revision), content: row.content, document: row.document, recordedAt: new Date(row.recorded_at).toISOString(),
          actor: { localAccountId: row.portable_actor_id, displayName: row.actor_name }, cause: this.#parseActivityCause(row.cause) })),
        durableObjects: durableObjects.rows.map((row) => ({ kind: row.object_kind, id: row.object_id,
          schema: row.projection_schema, payload: row.payload })),
      } };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
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

  #parseActivityCause(value: string): ActivityCause {
    try {
      const parsed = JSON.parse(value) as ActivityCause;
      if (parsed && typeof parsed === "object" && typeof parsed.kind === "string") return parsed;
    } catch { /* Legacy rows stored just the cause kind. */ }
    return value === "member" ? { kind: "member" } : { kind: "member" };
  }

  #noteFromRow(row: any): NoteRecord {
    return { id: row.id, workspaceId: row.workspace_id, content: row.content, document: row.document,
      revision: Number(row.revision), tags: row.tags ?? [], createdByMemberId: row.created_by_account_id,
      createdAt: new Date(row.created_at).toISOString(), ...(row.project_id ? { projectId: row.project_id } : {}),
      ...(row.reminder_at ? { reminder: { at: new Date(row.reminder_at).toISOString() } } : {}),
      ...(row.archived_at ? { archivedAt: new Date(row.archived_at).toISOString() } : {}) };
  }

  async #ensureNoteHistorySchema(client: PoolClient): Promise<void> {
    await this.#ensureNoteSchema(client);
    await client.query(`
      CREATE TABLE IF NOT EXISTS stash_note_history (
        note_id UUID NOT NULL REFERENCES stash_notes(id) ON DELETE CASCADE,
        workspace_id UUID NOT NULL REFERENCES stash_workspaces(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL CHECK (revision > 0),
        content TEXT NOT NULL,
        document JSONB NOT NULL,
        actor_account_id UUID NOT NULL REFERENCES stash_accounts(id),
        cause TEXT NOT NULL,
        recorded_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (note_id, revision)
      );
      CREATE TABLE IF NOT EXISTS stash_identity_stubs (
        source_account_id TEXT PRIMARY KEY, account_id UUID NOT NULL UNIQUE REFERENCES stash_accounts(id), display_name TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS stash_note_restore_receipts (
        note_id UUID NOT NULL REFERENCES stash_notes(id) ON DELETE CASCADE,
        idempotency_key UUID NOT NULL,
        target_revision INTEGER NOT NULL CHECK (target_revision > 0),
        activity_id UUID NOT NULL REFERENCES stash_workspace_activity(id),
        restore_result JSONB NOT NULL,
        PRIMARY KEY (note_id, idempotency_key)
      );
      ALTER TABLE stash_note_restore_receipts ADD COLUMN IF NOT EXISTS restore_result JSONB;
      UPDATE stash_note_restore_receipts receipt SET restore_result=jsonb_build_object('revision',history.revision,
        'content',history.content,'document',history.document) FROM stash_workspace_activity activity
      JOIN stash_note_history history ON history.note_id=activity.object_id
        AND history.revision=(activity.after_state->>'revision')::integer
      WHERE receipt.activity_id=activity.id AND receipt.restore_result IS NULL;
      ALTER TABLE stash_note_restore_receipts ALTER COLUMN restore_result SET NOT NULL;
    `);
  }

  async #ensureMemberDepartureSchema(client: PoolClient): Promise<void> {
    await this.#ensureWorkspaceProjectSchema(client);
    await client.query(`CREATE TABLE IF NOT EXISTS stash_agent_grants (
      id UUID PRIMARY KEY,
      organization_id UUID NOT NULL REFERENCES stash_organizations(id),
      project_id UUID REFERENCES stash_projects(id),
      sponsoring_member_id UUID NOT NULL REFERENCES stash_accounts(id),
      capabilities JSONB NOT NULL CHECK (jsonb_typeof(capabilities) = 'array'),
      expires_at TIMESTAMPTZ NOT NULL,
      confirmation_policy JSONB NOT NULL CHECK (jsonb_typeof(confirmation_policy) = 'object'),
      revoked_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS stash_personal_access_tokens (
      id UUID PRIMARY KEY,
      organization_id UUID NOT NULL REFERENCES stash_organizations(id) ON DELETE CASCADE,
      account_id UUID NOT NULL REFERENCES stash_accounts(id) ON DELETE CASCADE,
      token_lookup TEXT NOT NULL UNIQUE,
      token_hash TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS stash_operator_audit (
      id UUID PRIMARY KEY, action TEXT NOT NULL, actor_account_id UUID NOT NULL REFERENCES stash_accounts(id),
      organization_id UUID NOT NULL REFERENCES stash_organizations(id), target_account_id UUID NOT NULL REFERENCES stash_accounts(id),
      occurred_at TIMESTAMPTZ NOT NULL, before_state JSONB NOT NULL, after_state JSONB NOT NULL
    )`);
  }

  async #markFormerAssignments(client: PoolClient, organizationId: string, accountId: string, actorId: string): Promise<string[]> {
    const table = await client.query<{ exists: boolean }>("SELECT to_regclass('stash_tasks') IS NOT NULL AS exists");
    if (!table.rows[0]?.exists) return [];
    await client.query("ALTER TABLE stash_tasks ADD COLUMN IF NOT EXISTS former_assignee_ids JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(former_assignee_ids) = 'array')");
    const affected = await client.query<{ id: string }>(`SELECT task.id FROM stash_tasks task
      JOIN stash_workspaces workspace ON task.workspace_id = workspace.id
      WHERE workspace.owner_type = 'organization' AND workspace.organization_owner_id = $1
        AND task.assignee_ids ? $2 ORDER BY task.id FOR UPDATE OF task`, [organizationId, accountId]);
    const before = new Map<string, TaskPlanningReadModel>();
    for (const { id } of affected.rows) {
      const current = await client.query<any>(taskPlanningSelectById, [id, actorId]);
      if (current.rows[0]) before.set(id, taskPlanningReadModelFromRow(current.rows[0]));
    }
    await client.query(`UPDATE stash_tasks task
      SET former_assignee_ids = CASE WHEN former_assignee_ids ? $2 THEN former_assignee_ids ELSE former_assignee_ids || to_jsonb($2::text) END
      FROM stash_workspaces workspace WHERE task.workspace_id = workspace.id AND workspace.owner_type = 'organization'
        AND workspace.organization_owner_id = $1 AND task.assignee_ids ? $2`, [organizationId, accountId]);
    const ids = affected.rows.map(({ id }) => id).sort();
    for (const taskId of ids) {
      const refreshed = await client.query<any>(taskPlanningSelectById, [taskId, actorId]);
      if (!refreshed.rows[0]) continue;
      const projection = taskProjectionFromRow(refreshed.rows[0]);
      await this.#recordPortableProjection(client, "Task", taskId, projection.schema, projection);
      const previous = before.get(taskId);
      if (previous) await this.#recordTaskActivity(client, actorId, projection.workspaceId, taskId,
        "task_departed_assignee_marked", previous, taskPlanningReadModelFromRow(refreshed.rows[0]));
    }
    return ids;
  }

  async #revokeDepartedMemberAuthority(client: PoolClient, organizationId: string, accountId: string) {
    const authorityTables = await client.query<{ tablename: string }>(`SELECT tablename FROM pg_tables
      WHERE schemaname = current_schema() AND tablename = ANY($1::text[])`,
    [["stash_sessions", "stash_personal_access_tokens"]]);
    const present = new Set(authorityTables.rows.map(({ tablename }) => tablename));
    const sessions = present.has("stash_sessions") ? await client.query("DELETE FROM stash_sessions WHERE account_id = $1", [accountId]) : { rowCount: 0 };
    const personalTokens = present.has("stash_personal_access_tokens") ? await client.query(
      `UPDATE stash_personal_access_tokens SET revoked_at = CURRENT_TIMESTAMP
       WHERE organization_id = $1 AND account_id = $2 AND revoked_at IS NULL`, [organizationId, accountId]) : { rowCount: 0 };
    const grants = await client.query(`UPDATE stash_agent_grants SET revoked_at = CURRENT_TIMESTAMP
      WHERE organization_id = $1 AND sponsoring_member_id = $2 AND revoked_at IS NULL`, [organizationId, accountId]);
    return { revokedSessions: sessions.rowCount ?? 0,
      revokedCredentials: personalTokens.rowCount ?? 0,
      revokedAgentGrants: grants.rowCount ?? 0 };
  }

  async #degradePersonalConnections(client: PoolClient, organizationId: string, accountId: string): Promise<string[]> {
    const table = await client.query<{ exists: boolean }>("SELECT to_regclass('stash_repository_connections') IS NOT NULL AS exists");
    if (!table.rows[0]?.exists) return [];
    await this.#ensureRepositoryConnectionStateColumns(client);
    const degraded = await client.query<{ id: string }>(`UPDATE stash_repository_connections SET state = 'degraded'
      WHERE organization_id = $1 AND created_by_account_id = $2 AND ownership = 'personal' AND state = 'active' RETURNING id`,
    [organizationId, accountId]);
    const ids = degraded.rows.map(({ id }) => id).sort();
    for (const connectionId of ids) {
      const refreshed = await client.query<RepositoryConnectionRow>(`${repositoryConnectionSelect} WHERE connection.id = $1`, [connectionId]);
      const record = repositoryConnectionRecord(refreshed.rows[0]!);
      const revision = await client.query<{ revision: number }>("SELECT COALESCE(MAX(revision),0)+1 AS revision FROM stash_portable_projection_outbox WHERE object_kind='RepositoryConnection' AND object_id=$1", [connectionId]);
      await this.#recordRepositoryConnectionProjection(client, record, Number(revision.rows[0]!.revision));
    }
    return ids;
  }

  async #ensureRepositoryConnectionStateColumns(client: PoolClient): Promise<void> {
    await client.query(`ALTER TABLE stash_repository_connections ADD COLUMN IF NOT EXISTS ownership TEXT NOT NULL DEFAULT 'organization';
      ALTER TABLE stash_repository_connections ADD COLUMN IF NOT EXISTS state TEXT NOT NULL DEFAULT 'active';
      UPDATE stash_repository_connections SET ownership='organization' WHERE ownership NOT IN ('organization','personal');
      UPDATE stash_repository_connections SET state='active' WHERE state NOT IN ('active','degraded');
      DO $connection_state_constraints$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='stash_repository_connections'::regclass AND conname='stash_repository_connections_ownership_check') THEN
          ALTER TABLE stash_repository_connections ADD CONSTRAINT stash_repository_connections_ownership_check CHECK (ownership IN ('organization','personal'));
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='stash_repository_connections'::regclass AND conname='stash_repository_connections_state_check') THEN
          ALTER TABLE stash_repository_connections ADD CONSTRAINT stash_repository_connections_state_check CHECK (state IN ('active','degraded'));
        END IF;
      END $connection_state_constraints$`);
  }

  async #recordMemberDepartureAudit(client: PoolClient, input: { organizationId: string; actorId: string; accountId: string;
    role: BuiltInOrganizationRole; affectedTaskIds: string[]; degradedRepositoryConnectionIds: string[];
    revokedSessions: number; revokedCredentials: number; revokedAgentGrants: number }): Promise<void> {
    const { organizationId, actorId, accountId, role, ...after } = input;
    await client.query(`INSERT INTO stash_operator_audit
      (id, action, actor_account_id, organization_id, target_account_id, occurred_at, before_state, after_state)
      VALUES ($1,'organization_member_departed',$2,$3,$4,CURRENT_TIMESTAMP,$5::jsonb,$6::jsonb)`,
    [randomUUID(), actorId, organizationId, accountId, JSON.stringify({ role, active: true }), JSON.stringify({ active: false, ...after })]);
  }

  async #ensureWorkspaceImportSchema(client: PoolClient): Promise<void> {
    await this.#ensureNoteHistorySchema(client);
    await this.#ensureAttachmentSchema(client);
    await this.#ensureBoardSchema(client);
    await this.#ensureDiscussionSchema(client);
    await this.#ensureInvitationSchema(client);
    await client.query(`CREATE TABLE IF NOT EXISTS stash_identity_stubs (
      source_account_id TEXT PRIMARY KEY, account_id UUID NOT NULL UNIQUE REFERENCES stash_accounts(id), display_name TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS stash_workspace_imports (
      import_id UUID PRIMARY KEY, archive_sha256 TEXT NOT NULL, workspace_id UUID NOT NULL UNIQUE REFERENCES stash_workspaces(id),
      report JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS stash_disconnected_repository_connections (
      id UUID PRIMARY KEY, workspace_id UUID NOT NULL REFERENCES stash_workspaces(id), payload JSONB NOT NULL
    );
    ALTER TABLE stash_identity_stubs ADD COLUMN IF NOT EXISTS mapped_to_account_id UUID REFERENCES stash_accounts(id);
    ALTER TABLE stash_identity_stubs ADD COLUMN IF NOT EXISTS mapped_at TIMESTAMPTZ;
    CREATE TABLE IF NOT EXISTS stash_identity_mapping_receipts (
      idempotency_key UUID PRIMARY KEY, import_id UUID NOT NULL REFERENCES stash_workspace_imports(import_id), source_account_id TEXT NOT NULL,
      local_account_id UUID NOT NULL REFERENCES stash_accounts(id)
    )`);
  }

  async #backfillLegacyNoteHistory(client: PoolClient): Promise<void> {
    await client.query(`INSERT INTO stash_note_history
      (note_id,workspace_id,revision,content,document,actor_account_id,cause,recorded_at)
      SELECT note.id,note.workspace_id,note.revision,note.content,note.document,note.created_by_account_id,
        '{"kind":"migration","source":"existing_note"}',note.created_at FROM stash_notes note
      WHERE NOT EXISTS (SELECT 1 FROM stash_note_history history WHERE history.note_id=note.id)
      ON CONFLICT (note_id,revision) DO NOTHING`);
  }

  async #recordNoteRevisionAndActivity(client: PoolClient, memberId: string, before: NoteRecord | undefined,
    note: NoteRecord, action: string, cause: ActivityCause): Promise<ActivityRecord> {
    await this.#ensureNoteHistorySchema(client);
    if (before) await client.query(`INSERT INTO stash_note_history
      (note_id,workspace_id,revision,content,document,actor_account_id,cause,recorded_at)
      VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8) ON CONFLICT (note_id,revision) DO NOTHING`, [before.id,
      before.workspaceId,before.revision,before.content,JSON.stringify(before.document),before.createdByMemberId,
      JSON.stringify({ kind: "migration", source: "existing_note" }),before.createdAt]);
    const actor = await client.query<{ name: string }>("SELECT name FROM stash_accounts WHERE id=$1", [memberId]);
    if (!actor.rows[0]) throw new Error("member_identity_unavailable");
    const occurredAt = new Date().toISOString();
    const activity: ActivityRecord = { schema: "stash.activity.v1", id: randomUUID(), workspaceId: note.workspaceId,
      object: { kind: "Note", id: note.id }, action,
      actor: { localAccountId: memberId, displayName: actor.rows[0].name }, cause, occurredAt,
      before: before ? { revision: before.revision, content: before.content } : {},
      after: { revision: note.revision, content: note.content } };
    await client.query(`INSERT INTO stash_note_history
      (note_id,workspace_id,revision,content,document,actor_account_id,cause,recorded_at)
      VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8) ON CONFLICT (note_id,revision) DO NOTHING`,
      [note.id, note.workspaceId, note.revision, note.content, JSON.stringify(note.document), memberId, JSON.stringify(cause), occurredAt]);
    await client.query(`INSERT INTO stash_workspace_activity
      (id,workspace_id,object_kind,object_id,action,actor_account_id,cause,occurred_at,before_state,after_state)
      VALUES ($1,$2,'Note',$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)`, [activity.id, note.workspaceId, note.id, action,
      memberId, JSON.stringify(cause), occurredAt, JSON.stringify(activity.before), JSON.stringify(activity.after)]);
    await this.#recordPortableProjection(client, "Activity", activity.id, activity.schema, activity);
    if (JSON.stringify(activity.before) !== JSON.stringify(activity.after)) await this.#recordProjectActivityNotifications(client, activity);
    return activity;
  }

  async #recordTaskActivity(client: PoolClient, memberId: string, workspaceId: string, taskId: string,
    action: string, before: TaskPlanningReadModel, after: TaskPlanningReadModel, cause: ActivityCause = { kind: "member" }): Promise<ActivityRecord> {
    const actor = await client.query<{ name: string }>("SELECT name FROM stash_accounts WHERE id=$1", [memberId]);
    if (!actor.rows[0]) throw new Error("member_identity_unavailable");
    const activity: ActivityRecord = { schema: "stash.activity.v1", id: randomUUID(), workspaceId,
      object: { kind: "Task", id: taskId }, action, actor: { localAccountId: memberId, displayName: actor.rows[0].name },
      cause, occurredAt: new Date().toISOString(), before: { ...before }, after: { ...after } };
    await this.#persistTaskActivity(client, activity);
    return activity;
  }

  async #persistTaskActivity(client: PoolClient, activity: ActivityRecord): Promise<void> {
    if (activity.object.kind !== "Task") throw new Error("task_activity_object_required");
    await client.query(`INSERT INTO stash_workspace_activity
      (id,workspace_id,object_kind,object_id,action,actor_account_id,cause,occurred_at,before_state,after_state)
      VALUES ($1,$2,'Task',$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)`, [activity.id, activity.workspaceId, activity.object.id, activity.action,
      activity.actor.localAccountId, JSON.stringify(activity.cause), activity.occurredAt, JSON.stringify(activity.before), JSON.stringify(activity.after)]);
    await this.#recordPortableProjection(client, "Activity", activity.id, activity.schema, activity);
    if (activity.action !== "automation_execution_failed" && JSON.stringify(activity.before) !== JSON.stringify(activity.after)) {
      await this.#recordProjectActivityNotifications(client, activity);
    }
  }

  async #recordProjectActivityNotifications(client: PoolClient, activity: ActivityRecord): Promise<void> {
    await this.#ensureNoteSchema(client);
    await this.#ensureDiscussionSchema(client);
    await this.#ensureNotificationSchema(client);
    const scope = await client.query<any>(`WITH activity_scope AS (
      SELECT COALESCE(task.project_id, note.project_id, location_note.project_id, link_note.project_id,
        discussion_task.project_id, discussion_note.project_id) AS project_id
      FROM (SELECT 1) seed
      LEFT JOIN stash_tasks task ON $2='Task' AND task.id=$1
      LEFT JOIN stash_notes note ON $2='Note' AND note.id=$1
      LEFT JOIN stash_notes location_note ON $2='NoteLocation' AND location_note.id=$1
      LEFT JOIN stash_note_links link ON $2='NoteLink' AND link.id=$1
      LEFT JOIN stash_notes link_note ON link_note.id=link.source_note_id
      LEFT JOIN stash_discussions discussion ON $2='Discussion' AND discussion.id=$1
      LEFT JOIN stash_tasks discussion_task ON discussion_task.id=discussion.task_id
      LEFT JOIN stash_notes discussion_note ON discussion_note.id=discussion.note_id
    ) SELECT scope.project_id, account.id AS member_id,
      COALESCE(preference.activity,'followed') AS activity_preference, COALESCE(preference.digest,'off') AS digest,
      preference.quiet_start, preference.quiet_end, preference.quiet_time_zone
      FROM activity_scope scope JOIN stash_projects project ON project.id=scope.project_id
      JOIN stash_workspaces workspace ON workspace.id=project.workspace_id
      JOIN stash_accounts account ON (workspace.owner_type='personal' AND account.id=workspace.personal_owner_id) OR
        (workspace.owner_type='organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
          WHERE membership.organization_id=workspace.organization_owner_id AND membership.account_id=account.id))
      LEFT JOIN stash_notification_preferences preference ON preference.project_id=project.id AND preference.member_id=account.id
      LEFT JOIN stash_project_follows follow ON follow.project_id=project.id AND follow.member_id=account.id
      WHERE account.id<>$3 AND COALESCE(preference.activity,'followed')<>'muted'
        AND (COALESCE(preference.activity,'followed')='all' OR follow.member_id IS NOT NULL)
      ORDER BY account.id`, [activity.object.id, activity.object.kind, activity.actor.localAccountId]);
    for (const recipient of scope.rows) {
      const preferences: NotificationPreferences = { activity: recipient.activity_preference, digest: recipient.digest,
        ...(recipient.quiet_start ? { quietHours: { start: recipient.quiet_start, end: recipient.quiet_end, timeZone: recipient.quiet_time_zone } } : {}) };
      await client.query(`INSERT INTO stash_notifications
        (id,member_id,workspace_id,project_id,trigger,summary,activity,created_at,delivery)
        VALUES($1,$2,$3,$4,'followed_change',$5,$6::jsonb,$7,$8)
        ON CONFLICT(member_id,activity_id,trigger) DO NOTHING`, [randomUUID(), recipient.member_id, activity.workspaceId,
        recipient.project_id, `${activity.actor.displayName} changed ${activity.object.kind === "Note" ? "a Note" : activity.object.kind === "Task" ? "a Task" : "Project content"}`, JSON.stringify(activity), activity.occurredAt,
        notificationDeliveryMode(new Date(activity.occurredAt), preferences)]);
    }
  }

  async #recordAssignmentNotifications(client: PoolClient, projectId: string, activity: ActivityRecord,
    before: { assigneeIds?: string[] }, after: { assigneeIds?: string[]; key?: string; title?: string }): Promise<void> {
    const inputs = assignmentNotificationInputs(activity, projectId, before, after);
    if (!inputs.length) return;
    await this.#ensureNotificationSchema(client);
    for (const input of inputs) {
      await client.query(`DELETE FROM stash_notifications WHERE member_id=$1 AND activity_id=$2 AND trigger='followed_change'`,
        [input.memberId, activity.id]);
      const settings = await client.query<any>(`SELECT preference.* FROM stash_projects project
        JOIN stash_workspaces workspace ON workspace.id=project.workspace_id
        LEFT JOIN stash_notification_preferences preference ON preference.project_id=project.id AND preference.member_id=$1
        WHERE project.id=$2 AND ((workspace.owner_type='personal' AND workspace.personal_owner_id=$1) OR
          (workspace.owner_type='organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
            WHERE membership.organization_id=workspace.organization_owner_id AND membership.account_id=$1)))`, [input.memberId, projectId]);
      if (!settings.rowCount) throw new Error("notification_recipient_forbidden");
      const row = settings.rows[0];
      const preferences: NotificationPreferences = row.member_id ? { activity: row.activity, digest: row.digest,
        ...(row.quiet_start ? { quietHours: { start: row.quiet_start, end: row.quiet_end, timeZone: row.quiet_time_zone } } : {}) }
        : { activity: "followed", digest: "off" };
      await client.query(`INSERT INTO stash_notifications
        (id,member_id,workspace_id,project_id,trigger,summary,activity,created_at,delivery)
        VALUES ($1,$2,$3,$4,'assignment',$5,$6::jsonb,$7,$8)
        ON CONFLICT (member_id,activity_id,trigger) DO NOTHING`, [randomUUID(), input.memberId, activity.workspaceId,
        projectId, input.summary, JSON.stringify(activity), activity.occurredAt,
        notificationDeliveryMode(new Date(activity.occurredAt), preferences)]);
    }
  }

  async #recordDiscussionMentionNotifications(client: PoolClient, memberId: string, discussion: DiscussionRecord,
    message: DiscussionMessage): Promise<void> {
    const requestedMemberIds = directMentionMemberIds(message.content).filter((id) => id !== memberId);
    if (!requestedMemberIds.length) return;
    const scope = await client.query<{ project_id: string | null }>(`SELECT COALESCE(task.project_id,note.project_id) AS project_id
      FROM stash_discussions discussion
      LEFT JOIN stash_tasks task ON task.id=discussion.task_id
      LEFT JOIN stash_notes note ON note.id=discussion.note_id
      WHERE discussion.id=$1`, [discussion.id]);
    if (!scope.rows[0]) return;
    const projectId = scope.rows[0].project_id;
    const recipients = await client.query<{ id: string }>(`SELECT account.id FROM stash_accounts account
      JOIN stash_workspaces workspace ON workspace.id=$2
      WHERE account.id=ANY($1::uuid[]) AND account.id<>$3 AND (
        (workspace.owner_type='personal' AND workspace.personal_owner_id=account.id) OR
        (workspace.owner_type='organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
          WHERE membership.organization_id=workspace.organization_owner_id AND membership.account_id=account.id)))
      AND ($4::uuid IS NULL OR EXISTS (SELECT 1 FROM stash_projects project WHERE project.id=$4 AND project.workspace_id=workspace.id))
      ORDER BY account.id`, [requestedMemberIds, discussion.workspaceId, memberId, projectId]);
    if (!recipients.rowCount) return;
    const activity: ActivityRecord = { schema: "stash.activity.v1", id: message.id, workspaceId: discussion.workspaceId,
      object: { kind: "Discussion", id: discussion.id }, action: "discussion_message_mentioned_members", actor: message.author,
      cause: { kind: "member" }, occurredAt: message.createdAt, before: {},
      after: { messageId: message.id, mentionedMemberIds: recipients.rows.map(({ id }) => id) } };
    await client.query(`INSERT INTO stash_workspace_activity
      (id,workspace_id,object_kind,object_id,action,actor_account_id,cause,occurred_at,before_state,after_state)
      VALUES($1,$2,'Discussion',$3,$4,$5,'member',$6,$7::jsonb,$8::jsonb) ON CONFLICT (id) DO NOTHING`,
    [activity.id, activity.workspaceId, discussion.id, activity.action, memberId, activity.occurredAt,
      JSON.stringify(activity.before), JSON.stringify(activity.after)]);
    await this.#recordPortableProjection(client, "Activity", activity.id, activity.schema, activity);
    if (projectId) await this.#recordProjectActivityNotifications(client, activity);
    await this.#ensureNotificationSchema(client);
    const inputs = projectId ? directMentionNotificationInputs(activity, projectId, recipients.rows.map(({ id }) => id))
      : recipients.rows.map(({ id }) => ({ memberId: id, trigger: "direct_mention" as const,
        summary: `${activity.actor.displayName} mentioned you in a Discussion`, activity }));
    for (const input of inputs) {
      if (projectId) await client.query(`DELETE FROM stash_notifications WHERE member_id=$1 AND activity_id=$2 AND trigger='followed_change'`,
        [input.memberId, activity.id]);
      const settings = projectId ? await client.query<any>(`SELECT preference.* FROM stash_notification_preferences preference
        WHERE preference.project_id=$2 AND preference.member_id=$1`, [input.memberId, projectId]) : { rows: [] };
      const row = settings.rows[0];
      const preferences: NotificationPreferences = row ? { activity: row.activity, digest: row.digest,
        ...(row.quiet_start ? { quietHours: { start: row.quiet_start, end: row.quiet_end, timeZone: row.quiet_time_zone } } : {}) }
        : { activity: "followed", digest: "off" };
      await client.query(`INSERT INTO stash_notifications
        (id,member_id,workspace_id,project_id,trigger,summary,activity,created_at,delivery)
        VALUES($1,$2,$3,$4,'direct_mention',$5,$6::jsonb,$7,$8)
        ON CONFLICT (member_id,activity_id,trigger) DO NOTHING`, [randomUUID(), input.memberId, activity.workspaceId,
        projectId, input.summary, JSON.stringify(activity), activity.occurredAt,
        notificationDeliveryMode(new Date(activity.occurredAt), preferences)]);
    }
  }

  async #recordDomainActivity(client: PoolClient, memberId: string, workspaceId: string,
    kind: ActivityRecord["object"]["kind"], objectId: string, action: string, before: object, after: object): Promise<void> {
    const actor=await client.query<{name:string}>("SELECT name FROM stash_accounts WHERE id=$1",[memberId]);
    if(!actor.rows[0]) throw new Error("member_identity_unavailable");
    const activity:ActivityRecord={schema:"stash.activity.v1",id:randomUUID(),workspaceId,object:{kind,id:objectId},action,
      actor:{localAccountId:memberId,displayName:actor.rows[0].name},cause:{kind:"member"},occurredAt:new Date().toISOString(),
      before:{...before},after:{...after}};
    await client.query(`INSERT INTO stash_workspace_activity
      (id,workspace_id,object_kind,object_id,action,actor_account_id,cause,occurred_at,before_state,after_state)
      VALUES($1,$2,$3,$4,$5,$6,'member',$7,$8::jsonb,$9::jsonb)`,[activity.id,workspaceId,kind,objectId,action,memberId,
      activity.occurredAt,JSON.stringify(activity.before),JSON.stringify(activity.after)]);
    await this.#recordPortableProjection(client,"Activity",activity.id,activity.schema,activity);
    if (JSON.stringify(activity.before) !== JSON.stringify(activity.after)) await this.#recordProjectActivityNotifications(client, activity);
  }

  async loadNoteCollaboration(memberId: string, noteId: string): Promise<CollaborationSnapshot | undefined> {
    return this.#withTransaction(async (client) => {
      await this.#ensureCollaborationSchema(client);
      const access = await this.#authorizeNote(client, memberId, noteId);
      if (access === "none") return undefined;
      let row = (await client.query<any>(`SELECT note_id,sequence,update,updated_at,updated_by_account_id
        FROM stash_note_collaboration WHERE note_id=$1`, [noteId])).rows[0];
      if (!row) row = await this.#seedNoteCollaboration(client, noteId);
      return { noteId: row.note_id, sequence: Number(row.sequence), update: new Uint8Array(row.update),
        updatedAt: new Date(row.updated_at).toISOString(), updatedByMemberId: row.updated_by_account_id, access };
    });
  }

  async appendNoteCollaboration(memberId: string, noteId: string, update: Uint8Array): Promise<CollaborationSnapshot | undefined> {
    return this.#withTransaction(async (client) => {
      await this.#ensureCollaborationSchema(client); await this.#ensureNoteHistorySchema(client);
      if (await this.#authorizeNote(client, memberId, noteId) !== "edit") return undefined;
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`note-collaboration:${noteId}`]);
      const noteRow = (await client.query<any>(`SELECT note.*, creator.name AS creator_name FROM stash_notes note
        JOIN stash_accounts creator ON creator.id=note.created_by_account_id WHERE note.id=$1 FOR UPDATE OF note`, [noteId])).rows[0];
      if (!noteRow) return undefined;
      const before = this.#noteFromRow(noteRow);
      let current = (await client.query<any>(`SELECT note_id,sequence,update,updated_at,updated_by_account_id
        FROM stash_note_collaboration WHERE note_id=$1 FOR UPDATE`, [noteId])).rows[0];
      if (!current) current = await this.#seedNoteCollaboration(client, noteId);
      const document = new Y.Doc();
      if (current) Y.applyUpdate(document, new Uint8Array(current.update));
      const beforeUpdate = Y.encodeStateAsUpdate(document);
      Y.applyUpdate(document, update);
      const merged = Y.encodeStateAsUpdate(document);
      if (Buffer.from(beforeUpdate).equals(Buffer.from(merged))) {
        document.destroy();
        return { noteId: current.note_id, sequence: Number(current.sequence), update: new Uint8Array(current.update),
          updatedAt: new Date(current.updated_at).toISOString(), updatedByMemberId: current.updated_by_account_id, access: "edit" };
      }
      let canonicalDocument: import("./rich-text.js").RichTextDocument;
      try { canonicalDocument = validatedRichTextFromCollaborativeDocument(document); }
      finally { document.destroy(); }
      const note: NoteRecord = { ...before, document: canonicalDocument, content: richTextToMarkdown(canonicalDocument), revision: before.revision + 1 };
      await client.query("UPDATE stash_notes SET content=$2,document=$3::jsonb,revision=$4 WHERE id=$1",
        [noteId, note.content, JSON.stringify(note.document), note.revision]);
      const row = (await client.query<any>(`INSERT INTO stash_note_collaboration(note_id,sequence,update,updated_by_account_id)
        VALUES($1,$2,$3,$4) ON CONFLICT(note_id) DO UPDATE SET sequence=EXCLUDED.sequence,update=EXCLUDED.update,
        updated_by_account_id=EXCLUDED.updated_by_account_id,updated_at=now()
        RETURNING note_id,sequence,update,updated_at,updated_by_account_id`,
      [noteId, Number(current?.sequence ?? 0) + 1, Buffer.from(merged), memberId])).rows[0];
      await client.query(`INSERT INTO stash_note_collaboration_activity(note_id,sequence,actor_account_id,update_bytes)
        VALUES($1,$2,$3,$4)`, [noteId, row.sequence, memberId, update.byteLength]);
      const projection: PortableNoteProjection = { schema: "stash.note.v1", id: note.id, workspaceId: note.workspaceId,
        content: note.content, tags: note.tags, createdAt: note.createdAt,
        createdBy: { localAccountId: before.createdByMemberId, displayName: noteRow.creator_name },
        ...(note.projectId ? { projectId: note.projectId } : {}), ...(note.reminder ? { reminder: note.reminder } : {}) };
      await this.#recordPortableProjection(client, "Note", note.id, projection.schema, projection);
      await this.#recordNoteRevisionAndActivity(client, memberId, before, note, "note_edited", { kind: "member" });
      return { noteId: row.note_id, sequence: Number(row.sequence), update: new Uint8Array(row.update),
        updatedAt: new Date(row.updated_at).toISOString(), updatedByMemberId: row.updated_by_account_id, access: "edit" };
    });
  }

  async #authorizeNote(client: Pool | PoolClient, memberId: string, noteId: string): Promise<"edit" | "read" | "none"> {
    const result = await client.query<{ can_edit: boolean; can_read: boolean }>(`SELECT
      ((workspace.owner_type='personal' AND workspace.personal_owner_id=$2) OR
       (workspace.owner_type='organization' AND EXISTS(SELECT 1 FROM stash_organization_memberships membership
         WHERE membership.organization_id=workspace.organization_owner_id AND membership.account_id=$2))) AS can_edit,
      ((workspace.owner_type='personal' AND workspace.personal_owner_id=$2) OR
       (workspace.owner_type='organization' AND EXISTS(SELECT 1 FROM stash_organization_memberships membership
         WHERE membership.organization_id=workspace.organization_owner_id AND membership.account_id=$2)) OR
       (note.project_id IS NOT NULL AND EXISTS(SELECT 1 FROM stash_project_guests guest
         WHERE guest.project_id=note.project_id AND guest.account_id=$2))) AS can_read
      FROM stash_notes note JOIN stash_workspaces workspace ON workspace.id=note.workspace_id WHERE note.id=$1`, [noteId, memberId]);
    return result.rows[0]?.can_edit ? "edit" : result.rows[0]?.can_read ? "read" : "none";
  }

  async #seedNoteCollaboration(client: PoolClient, noteId: string): Promise<any> {
    const note = (await client.query<any>("SELECT document,created_by_account_id,created_at FROM stash_notes WHERE id=$1", [noteId])).rows[0];
    if (!note) throw new Error("note_not_found");
    const document = collaborativeDocumentFromRichText(note.document);
    const update = Y.encodeStateAsUpdate(document); document.destroy();
    return (await client.query<any>(`INSERT INTO stash_note_collaboration(note_id,sequence,update,updated_by_account_id,updated_at)
      VALUES($1,0,$2,$3,$4) ON CONFLICT(note_id) DO UPDATE SET note_id=EXCLUDED.note_id
      RETURNING note_id,sequence,update,updated_at,updated_by_account_id`,
    [noteId, Buffer.from(update), note.created_by_account_id, note.created_at])).rows[0];
  }

  async #ensureCollaborationSchema(client: PoolClient): Promise<void> {
    await this.#ensureNoteSchema(client);
    await client.query(`CREATE TABLE IF NOT EXISTS stash_note_collaboration(
      note_id uuid PRIMARY KEY REFERENCES stash_notes(id) ON DELETE CASCADE,sequence bigint NOT NULL CHECK(sequence>=0),
      update bytea NOT NULL,updated_by_account_id uuid NOT NULL REFERENCES stash_accounts(id),updated_at timestamptz NOT NULL DEFAULT now())`);
    await client.query(`CREATE TABLE IF NOT EXISTS stash_note_collaboration_activity(
      note_id uuid NOT NULL REFERENCES stash_notes(id) ON DELETE CASCADE,sequence bigint NOT NULL,
      actor_account_id uuid NOT NULL REFERENCES stash_accounts(id),update_bytes integer NOT NULL CHECK(update_bytes>0),
      occurred_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(note_id,sequence))`);
  }
}

function hasDependencyCycle(taskIds: ReadonlySet<string>, edges: ReadonlyArray<{ dependent_task_id: string; prerequisite_task_id: string }>): boolean {
  const outgoing = new Map<string, Set<string>>([...taskIds].map((id) => [id, new Set()]));
  for (const edge of edges) outgoing.get(edge.dependent_task_id)?.add(edge.prerequisite_task_id);
  const visiting = new Set<string>(); const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const target of outgoing.get(id) ?? []) if (visit(target)) return true;
    visiting.delete(id); visited.add(id); return false;
  };
  return [...outgoing.keys()].some(visit);
}

export function planLegacyTaskDependencyMigration(rows: ReadonlyArray<{ id: string; workspaceId: string; dependencies: unknown }>,
  existingEdges: ReadonlyArray<{ dependentTaskId: string; prerequisiteTaskId: string }> = []) {
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const tasks = new Map(rows.map((row) => [row.id, row]));
  const normalized = new Map(existingEdges.map((edge) => [`${edge.dependentTaskId}:${edge.prerequisiteTaskId}`,
    { dependent_task_id: edge.dependentTaskId, prerequisite_task_id: edge.prerequisiteTaskId }]));
  for (const row of rows) {
    if (!Array.isArray(row.dependencies)) throw new Error("Legacy Task dependency migration aborted: malformed relationship collection.");
    for (const value of row.dependencies) {
      if (value === null || typeof value !== "object" || Array.isArray(value))
        throw new Error("Legacy Task dependency migration aborted: malformed relationship entry.");
      const relation = value as Record<string, unknown>;
      if (Object.keys(relation).length !== 2 || typeof relation.taskId !== "string" || !uuidPattern.test(relation.taskId)
        || (relation.type !== "depends_on" && relation.type !== "required_by"))
        throw new Error("Legacy Task dependency migration aborted: malformed relationship entry.");
      const related = tasks.get(relation.taskId);
      if (!related || related.workspaceId !== row.workspaceId || related.id === row.id)
        throw new Error("Legacy Task dependency migration aborted: missing, cross-Workspace, or self relationship.");
      const edge = relation.type === "depends_on"
        ? { dependent_task_id: row.id, prerequisite_task_id: related.id }
        : { dependent_task_id: related.id, prerequisite_task_id: row.id };
      normalized.set(`${edge.dependent_task_id}:${edge.prerequisite_task_id}`, edge);
    }
  }
  const edges = [...normalized.values()];
  if (hasDependencyCycle(new Set(tasks.keys()), edges))
    throw new Error("Legacy Task dependency migration aborted: normalized relationship graph contains a cycle.");
  return edges;
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
interface RepositoryConnectionRow { id: string; organization_id: string; provider: "github"; installation_id: string | number; repository_id: string; repository_url: string; created_by_account_id: string; created_by_attribution: "recorded" | "inferred-during-upgrade"; project_ids: string[]; ownership: "organization" | "personal"; state: "active" | "degraded" }
function githubSignalFromRow(row: any): GitHubSignal {
  return { id: row.id, deliveryId: row.delivery_id, installationId: Number(row.installation_id), repositoryId: row.repository_id, kind: row.kind,
    providerId: row.provider_id, url: row.url, label: row.label, occurredAt: new Date(row.occurred_at).toISOString(),
    ...(row.automation_trigger ? { trigger: row.automation_trigger } : {}) };
}
function automationRecipeFromRow(row: any): AutomationRecipe {
  return { id: row.id, trigger: row.trigger, targetStatus: { id: row.target_status_id, name: row.target_status_name }, enabled: row.enabled };
}
function automationTransitionFromRow(row: any): AutomationTransition {
  return { id: row.id, automationId: row.automation_id, signalId: row.signal_id,
    before: { id: row.before_status_id, name: row.before_status_name }, after: { id: row.after_status_id, name: row.after_status_name },
    occurredAt: new Date(row.occurred_at).toISOString(), ...(row.reversed_at ? { reversedAt: new Date(row.reversed_at).toISOString() } : {}) };
}
interface AttachmentRow { id: string; workspace_id: string; filename: string; content_type: string; byte_size: string | number; relative_path: string; storage_key: string; source: "upload" | "paste"; created_by_account_id: string; created_at: Date | string }
function attachmentRecord(row: AttachmentRow): AttachmentRecord {
  return { id: row.id, workspaceId: row.workspace_id, filename: row.filename, contentType: row.content_type,
    size: Number(row.byte_size), relativePath: row.relative_path, storageKey: row.storage_key, source: row.source,
    createdByMemberId: row.created_by_account_id, createdAt: new Date(row.created_at).toISOString() };
}
function repositoryConnectionRecord(row: RepositoryConnectionRow): RepositoryConnectionRecord {
  return { id: row.id, organizationId: row.organization_id, provider: row.provider, installationId: Number(row.installation_id), repositoryId: row.repository_id, repositoryUrl: row.repository_url, createdByMemberId: row.created_by_account_id, createdByAttribution: row.created_by_attribution, projectIds: row.project_ids, ownership: row.ownership, state: row.state };
}
function developmentArtifactFromUrl(value: string): DevelopmentArtifact[] {
  try {
    const url = new URL(value); if (url.protocol !== "https:" || url.hostname !== "github.com") return [];
    const match = url.pathname.match(/^\/[^/]+\/[^/]+\/(tree|commit|pull)\/(.+)$/); if (!match) return [];
    const kind = match[1] === "tree" ? "branch" : match[1] === "commit" ? "commit" : "pull_request";
    const label = decodeURIComponent(match[2]!); return [{ kind, providerId: label, label, url: value }];
  } catch { return []; }
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

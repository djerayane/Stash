import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { DatabaseProbe } from "./instance.js";
import { noteOperationDigest, type NoteConflictResolution, type NoteEditBatch, type NoteEditConflict, type NoteRecord, type NoteRepository, type NoteTriageChange, type NoteTriageResult, type PortableExportTaskProjection, type PortableNoteLinkProjection, type PortableNoteProjection, type PortableNoteStateProjection, type PortableTaskProjection, type TaskCreation } from "./notes.js";
import { isRichTextDocument, markdownToRichText, paragraphDocument, richTextToMarkdown } from "./rich-text.js";
import type { BootstrapRecord, OwnerBootstrapRepository } from "./owner-bootstrap.js";
import type { AccountAuthenticationRecord, PasswordAuthRepository, SessionRecord } from "./password-auth.js";
import type { AccountRegistrationRepository, RegistrationRecord } from "./account-registration.js";
import type { OidcAuthRepository, OidcIdentityKey, OidcIdentityRecord, OidcOrganizationConfiguration } from "./oidc-auth.js";
import type { AccountRecoveryRepository, ClaimedEmailRecoveryDelivery, EmailRecoveryDeliveryClaim, EmailRecoveryDeliveryJob, EmailRecoveryRecord, PasskeyRecord, RecoveryCodeRecord } from "./account-recovery.js";
import type { BuiltInOrganizationRole, CustomOrganizationRole, OrganizationRoleRepository } from "./organization-roles.js";
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
import type { PortableRepositoryConnectionProjection, RepositoryConnectionRecord } from "./repository-connections.js";
import { taskEditDigest, type CreateTaskFromBlockDraft, type CreateTaskFromBlockOutcome, type CreateWorkspaceTaskFromBlockOutcome, type LinkedTaskReadModel, type StructuredTaskEditRepository, type TaskEditBatch, type TaskEditConflict, type TaskFromBlockRepository, type TaskMoveActivity, type TaskMoveRepository, type TaskPlanningReadModel, type TaskPlanningRepository, type TaskPlanningUpdate, type TaskSourceBlockReference } from "./tasks.js";
import type { AttachmentRecord, AttachmentRepository, PortableAttachmentProjection } from "./attachments.js";
import type { MobileCaptureRepository } from "./mobile-captures.js";
import type { CreateDiscussionWorkDraft, DiscussionDraft, DiscussionMessage, DiscussionRecord, DiscussionRepository, DiscussionTarget, DiscussionWorkActivity, DiscussionWorkOutcome, PortableDiscussionProjection, PortableDiscussionTarget, PortableDiscussionWorkLinkProjection } from "./discussions.js";
import { initialWorkflowStatus, type ProjectWorkflow, type ProjectWorkflowRepository, type WorkflowStatus } from "./project-workflows.js";
import type { PortableWorkspaceExportRepository, PortableWorkspaceExportSnapshot } from "./portable-workspace-export.js";
import type { ImportTransformation, PortableWorkspaceImportBundle, PortableWorkspaceImportReport, PortableWorkspaceImportRepository } from "./portable-workspace-import.js";
import type { Board, BoardRepository, BoardTask } from "./boards.js";
import type { NoteLinkRecord, NoteLinkRepository, NoteLocationRecord, PortableNoteLinkStateProjection, PortableNoteLocationProjection } from "./note-links.js";
import type { ActivityCause, ActivityRecord, ActivityRepository, NoteHistoryRevision } from "./activity.js";
import type { DevelopmentArtifact, GitHubArtifactRepository } from "./github-artifacts.js";
import type { GitHubSignal } from "./github-signals.js";
import { assignmentNotificationInputs, directMentionMemberIds, directMentionNotificationInputs, notificationDeliveryMode, requestedReviewNotificationInput, type NotificationDelivery, type NotificationPreferences, type NotificationRepository } from "./notifications.js";
import type { AutomationCandidate, AutomationFailureNotification, AutomationRecipe, AutomationRepository, AutomationState, AutomationTransition, AutomationTrigger } from "./automations.js";
import * as Y from "yjs";
import { prosemirrorJSONToYDoc, yDocToProsemirrorJSON } from "y-prosemirror";
import { Schema } from "prosemirror-model";
import { InvalidCollaborationUpdate, type CollaborationSnapshot, type NoteCollaborationRepository } from "./note-collaboration.js";
import type { WorkspaceSearchFacet, WorkspaceSearchKind, WorkspaceSearchQuery, WorkspaceSearchRepository, WorkspaceSearchResult } from "./workspace-search.js";
import { proseMirrorToRichText, richTextToProseMirror } from "@stash/rich-text";
import type { AgentGrant, AgentGrantOption, AgentGrantRepository, AgentProposal, StoredAgentGrant } from "./agent-grants.js";
import type { ImportedIdentityAdministration } from "./imported-identity-administration-routes.js";
import type { NoteTreeRepository } from "./knowledge-authoring/note-tree.js";
import { PostgresNoteTreeRepository } from "./knowledge-authoring/postgres-note-tree-repository.js";
import type { FirstPersonalInstanceSetup, InstanceSetupRepository } from "./identity-access/instance-setup.js";
import { PostgresInstanceSetupRepository } from "./identity-access/postgres-instance-setup-repository.js";
import { PostgresOrganizationRoleRepository } from "./identity-access/postgres-organization-role-repository.js";
import { PostgresIdentityAccessRepositories } from "./identity-access/postgres-identity-access-repositories.js";
import type { CollectionRepository, TutorialContributionRepository } from "./knowledge-authoring/collections.js";
import { PostgresTutorialContributionRepository } from "./knowledge-authoring/postgres-tutorial-contribution-repository.js";
import { PostgresCollectionRepository } from "./knowledge-authoring/postgres-collection-repository.js";
import { PostgresRelationshipQueryRepository } from "./knowledge-authoring/postgres-relationship-query-repository.js";
import type { RelationshipQueryRepository } from "./knowledge-authoring/relationship-query.js";
import { PostgresVisualizationBlockRepository } from "./knowledge-authoring/postgres-visualization-block-repository.js";
import type { VisualizationBlockRepository } from "./knowledge-authoring/visualization-block.js";
import { PostgresKnowledgeAuthoringRepositories } from "./knowledge-authoring/postgres-knowledge-authoring-repositories.js";
import { effectiveNoteReadSql, workspaceMemberSql } from "./knowledge-authoring/postgres-note-access.js";
import type { PostgresPortableProjectionContributor } from "./instance-operations/storage/portable-projection-contributor.js";
import { PostgresProjectlessTaskRepository } from "./work-planning/postgres-projectless-task-repository.js";
import { PostgresProjectPermissionRepository } from "./work-planning/postgres-project-permission-repository.js";
import type { ProjectlessTaskRepository } from "./work-planning/projectless-tasks.js";
import type { CanonicalTaskRepository } from "./work-planning/canonical-tasks.js";
import { PostgresCanonicalTaskRepository } from "./work-planning/postgres-canonical-task-repository.js";
import { PostgresWorkPlanningRepositories } from "./work-planning/postgres-work-planning-repositories.js";
import {
  PostgresDevelopmentIntegrationRepositories,
  type DevelopmentIntegrationPostgresRepositories,
} from "./development-integration/postgres-development-integration-repositories.js";
import {
  PostgresKernel,
  type PostgresKernelOptions,
  type PostgresQueryable,
} from "./instance-operations/storage/postgres-kernel.js";

export type { IdlePostgresClientFailure } from "./instance-operations/storage/postgres-kernel.js";

export interface PostgresDatabaseOptions extends PostgresKernelOptions {}

export type IdentityAccessPostgresRepositories = PasswordAuthRepository & AccountRegistrationRepository
  & OidcAuthRepository & AccountRecoveryRepository & OrganizationRoleRepository & InvitationRepository
  & MemberLocalizationRepository & WorkspaceProjectRepository & AgentGrantRepository & ImportedIdentityAdministration;
export type KnowledgeAuthoringPostgresRepositories = NoteRepository & NoteCollaborationRepository
  & NoteLinkRepository & DiscussionRepository & WorkspaceSearchRepository & AttachmentRepository & ActivityRepository
  & PortableWorkspaceExportRepository & PortableWorkspaceImportRepository & MobileCaptureRepository;
export type WorkPlanningPostgresRepositories = TaskFromBlockRepository & TaskPlanningRepository
  & StructuredTaskEditRepository & TaskMoveRepository & ProjectWorkflowRepository & BoardRepository
  & NotificationRepository & AutomationRepository;
export type { DevelopmentIntegrationPostgresRepositories } from "./development-integration/postgres-development-integration-repositories.js";

// First 31 bits of SHA-256("stash:authentication-key-check:v1"); reserved in Stash's
// PostgreSQL advisory-lock ID domain for serializing only the authentication key-check transaction.
const authenticationKeyCheckLockId = 795_541_992;
function agentGrantFromRow(row: any): AgentGrant {
  return { id: row.id, organizationId: row.organization_id, sponsoringMemberId: row.sponsoring_member_id, name: row.name,
    ...(row.project_id ? { projectId: row.project_id } : {}), scopes: row.capabilities,
    expiresAt: new Date(row.expires_at).toISOString(), createdAt: new Date(row.created_at).toISOString(),
    ...(row.revoked_at ? { revokedAt: new Date(row.revoked_at).toISOString() } : {}) };
}
function agentProposalFromRow(row: any): AgentProposal {
  return { id: row.id, grantId: row.grant_id, organizationId: row.organization_id, sponsoringMemberId: row.sponsoring_member_id,
    agentName: row.agent_name, ...(row.project_id ? { projectId: row.project_id } : {}), capability: row.capability, input: row.input,
    ...(row.base_revision ? { baseRevision: Number(row.base_revision) } : {}), createdAt: new Date(row.created_at).toISOString(), status: row.status,
    ...(row.operation_id ? { operationId: row.operation_id } : {}), ...(row.reviewed_at ? { reviewedAt: new Date(row.reviewed_at).toISOString() } : {}),
    ...(row.reviewed_by_account_id ? { reviewedByMemberId: row.reviewed_by_account_id } : {}), ...(row.result ? { result: row.result } : {}),
    ...(row.conflict ? { conflict: row.conflict } : {}) };
}
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
const portableProjectionObjectKinds = ["Workspace", "Project", "Workflow", "WorkspaceWorkflow", "Collection", "ViewBlock", "Board", "Note", "NoteLocation", "NoteLink", "Task", "GuestProjectAccess", "RepositoryConnection", "Attachment", "Discussion", "DiscussionWorkLink", "Activity",
  ...PostgresVisualizationBlockRepository.portableObjectKinds] as const;
const portableProjectionObjectKindSql = portableProjectionObjectKinds.map((kind) => `'${kind}'`).join(", ");
export const workflowTemporaryRenameSql = `UPDATE stash_workflow_statuses
  SET position = -position - 1, name = repeat('__stash_workflow_transition__', 4) || id::text
  WHERE project_id = $1`;
const repositoryConnectionSelect = `SELECT connection.id, connection.organization_id, connection.provider, connection.installation_id,
  connection.repository_id, connection.repository_url, connection.created_by_account_id, connection.created_by_attribution,
  connection.ownership, connection.state,
  ARRAY(SELECT project_id FROM stash_repository_connection_projects link WHERE link.connection_id = connection.id ORDER BY project_id) AS project_ids
  FROM stash_repository_connections connection`;
const taskPlanningSelect = `SELECT task.*, COALESCE(workspace_status.name,status.name) AS status_name,
  COALESCE(workspace_status.category,status.category) AS status_category,
  creator.name AS created_by_name,
  ARRAY(SELECT source.note_id FROM stash_task_note_sources source WHERE source.task_id = task.id ORDER BY source.note_id) AS source_note_ids,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('noteId', source.note_id, 'blockId', source.block_id) ORDER BY source.note_id, source.block_id)
    FROM stash_task_block_sources source WHERE source.task_id = task.id), '[]'::jsonb) AS source_blocks,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('projectId', alias.project_id, 'key', alias.task_key) ORDER BY alias.created_at)
    FROM stash_task_key_aliases alias WHERE alias.task_id = task.id), '[]'::jsonb) AS key_aliases
  , COALESCE((SELECT jsonb_agg(jsonb_build_object('projectId', association.project_id, 'key', association.task_key) ORDER BY association.project_id)
    FROM stash_task_projects association WHERE association.task_id = task.id), '[]'::jsonb) AS project_keys
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
  LEFT JOIN stash_workflow_statuses status ON status.id = task.workflow_status_id
  LEFT JOIN stash_workspace_workflow_statuses workspace_status ON workspace_status.id = task.workspace_workflow_status_id
  JOIN stash_accounts creator ON creator.id = task.created_by_account_id
  JOIN stash_workspaces workspace ON workspace.id = task.workspace_id
  WHERE (task.project_id = $1 AND task.task_key = $2 OR EXISTS (SELECT 1 FROM stash_task_projects association
      WHERE association.task_id=task.id AND association.project_id=$1 AND association.task_key=$2) OR EXISTS (SELECT 1 FROM stash_task_key_aliases alias
      WHERE alias.task_id = task.id AND alias.project_id = $1 AND alias.task_key = $2))
    AND ((workspace.owner_type = 'personal' AND workspace.personal_owner_id = $3)
      OR (workspace.owner_type = 'organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
        WHERE membership.organization_id = workspace.organization_owner_id AND membership.account_id = $3))
      OR EXISTS (SELECT 1 FROM stash_project_guests guest JOIN stash_task_projects association ON association.project_id=guest.project_id
        WHERE association.task_id=task.id AND guest.account_id=$3))`;
const taskPlanningSelectById = taskPlanningSelect
  .replace(/\(task\.project_id = \$1[\s\S]*?alias\.task_key = \$2\)\)/, "task.id = $1")
  .replaceAll("$3", "$2");

function taskProjectionFromRow(row: any): PortableExportTaskProjection {
  return {
    schema: "stash.task.v1", id: row.id, workspaceId: row.workspace_id, ...(row.project_id ? { projectId: row.project_id } : {}),
    ...(row.task_key ? { key: row.task_key } : {}), ...(row.project_keys?.length ? { projectKeys: row.project_keys,
      projectAssociations: row.project_keys.map((entry: any) => entry.projectId) } : {}),
    ...(row.key_aliases?.length ? { keyAliases: row.key_aliases } : {}), title: row.title,
    status: { id: row.workspace_workflow_status_id ?? row.workflow_status_id, name: row.status_name, category: row.status_category },
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
  return { ...taskProjectionFromRow(row), revision: Number(row.revision), dependencyWarnings: row.dependency_warnings ?? [] } as TaskPlanningReadModel;
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

export class PostgresDatabase implements DatabaseProbe {
  readonly #kernel: PostgresKernel;
  readonly #noteTreeRepository: PostgresNoteTreeRepository;
  readonly #instanceSetupRepository: PostgresInstanceSetupRepository;
  readonly #tutorialContributionRepository: PostgresTutorialContributionRepository;
  readonly #collectionRepository: PostgresCollectionRepository;
  readonly #projectlessTaskRepository: PostgresProjectlessTaskRepository;
  readonly #canonicalTaskRepository: PostgresCanonicalTaskRepository;
  readonly #organizationRoleRepository: PostgresOrganizationRoleRepository;
  readonly #projectPermissionRepository: PostgresProjectPermissionRepository;
  readonly #relationshipQueryRepository: PostgresRelationshipQueryRepository;
  readonly #visualizationBlockRepository: PostgresVisualizationBlockRepository;
  readonly #portableProjectionContributors: readonly PostgresPortableProjectionContributor[];
  readonly #authenticationSecrets: AuthenticationSecretCodec;
  readonly #identityAccessAdapter: PostgresIdentityAccessRepositories;
  readonly #knowledgeAuthoringAdapter: PostgresKnowledgeAuthoringRepositories;
  readonly #workPlanningAdapter: PostgresWorkPlanningRepositories;
  readonly #developmentIntegrationAdapter: PostgresDevelopmentIntegrationRepositories;

  constructor(connectionString: string, authenticationSecrets: AuthenticationSecretCodec, options: PostgresDatabaseOptions = {}) {
    this.#kernel = new PostgresKernel(connectionString, options);
    this.#authenticationSecrets = authenticationSecrets;
    this.#noteTreeRepository = new PostgresNoteTreeRepository(this.#kernel, (client) => this.#ensureNoteSchema(client), {
      beforeStateChange: (client, noteIds, state) => this.#tutorialContributionRepository.beforeStateChange(client, noteIds, state),
    });
    this.#tutorialContributionRepository = new PostgresTutorialContributionRepository(this.#kernel,
      (client) => this.#noteTreeRepository.prepare(client));
    this.#instanceSetupRepository = new PostgresInstanceSetupRepository(this.#kernel, authenticationSecrets, async (client) => {
      await this.#ensureBootstrapSchema(client);
      await this.#ensureAuthSchema(client);
      await this.#noteTreeRepository.prepare(client);
    }, this.#tutorialContributionRepository);
    this.#identityAccessAdapter = new PostgresIdentityAccessRepositories(this.#kernel, authenticationSecrets, {
      prepareRegistration: async (client) => {
        await this.#ensureWorkspaceProjectSchema(client);
        await this.#ensureAuthSchema(client);
      },
      recordWorkspaceProjection: (client, record) => this.#recordPortableProjection(client, "Workspace", record.workspace.id, "stash.workspace.v1", {
        schema: "stash.workspace.v1", id: record.workspace.id, name: record.workspace.name,
        owner: { type: "personal", identity: { localAccountId: record.account.id, displayName: record.account.name } },
        createdBy: { localAccountId: record.account.id, displayName: record.account.name },
      }),
    });
    this.#projectlessTaskRepository = new PostgresProjectlessTaskRepository(this.#kernel,
      (client) => this.#instanceSetupRepository.prepare(client));
    this.#canonicalTaskRepository = new PostgresCanonicalTaskRepository(this.#kernel,
      (client) => this.#instanceSetupRepository.prepare(client), async (memberId, noteId) =>
        (await this.#noteTreeRepository.readNoteTreeContext(memberId, noteId)).status === "found");
    this.#collectionRepository = new PostgresCollectionRepository(this.#kernel,
      (client) => this.#noteTreeRepository.prepare(client),
      (memberId, workspaceId) => this.#canonicalTaskRepository.listTasks(memberId, workspaceId));
    this.#organizationRoleRepository = new PostgresOrganizationRoleRepository(this.#kernel,
      (client) => this.#ensureWorkspaceProjectSchema(client));
    this.#projectPermissionRepository = new PostgresProjectPermissionRepository(this.#kernel, async (client) => {
      await this.#ensureWorkspaceProjectSchema(client);
      await this.#organizationRoleRepository.prepare(client);
    });
    this.#relationshipQueryRepository = new PostgresRelationshipQueryRepository(this.#kernel,
      (client) => this.#noteTreeRepository.prepare(client));
    this.#visualizationBlockRepository = new PostgresVisualizationBlockRepository(this.#kernel,
      (client) => this.#noteTreeRepository.prepare(client));
    this.#portableProjectionContributors = [this.#visualizationBlockRepository];
    this.#knowledgeAuthoringAdapter = new PostgresKnowledgeAuthoringRepositories(this.#kernel, {
      prepare: (client) => this.#ensureNoteSchema(client),
      prepareInvitations: (client) => this.#ensureInvitationSchema(client),
      prepareAttachments: (client) => this.#ensureAttachmentSchema(client),
      prepareWorkspaceProjects: (client) => this.#ensureWorkspaceProjectSchema(client),
      recordProjection: (client, kind, id, schema, projection) => this.#recordPortableProjection(client, kind, id, schema, projection),
      authorizeNote: (client, memberId, noteId) => this.#authorizeNote(client, memberId, noteId),
      recordNoteRevisionAndActivity: (client, memberId, before, after, action, cause) =>
        this.#recordNoteRevisionAndActivity(client, memberId, before, after, action, cause),
      recordDomainActivity: (client, memberId, workspaceId, kind, objectId, action, before, after) =>
        this.#recordDomainActivity(client, memberId, workspaceId, kind, objectId, action, before, after),
      recordCreatedNote: async (client, memberId, note, projection, cause) => {
        await this.#recordInitialNoteLocation(client, note.id, note.workspaceId);
        await this.#recordPortableProjection(client, "Note", note.id, "stash.note.v1", projection);
        await this.#recordNoteRevisionAndActivity(client, memberId, undefined, note, "note_created", cause);
      },
      recordAgentAudit: (client, memberId, note, cause) =>
        this.#recordAgentExecutionAudit(client, memberId, note.workspaceId, "agent_note_created", note.id, cause),
    });
    this.#workPlanningAdapter = new PostgresWorkPlanningRepositories(this.#kernel, {
      prepare: async (client) => { await this.#ensureNoteSchema(client); await this.#ensureInvitationSchema(client); },
      recordProjection: (client, task) => this.#recordPortableProjection(client, "Task", task.id, task.schema, task),
      recordActivity: (client, memberId, workspaceId, taskId, before, after, cause) =>
        this.#recordTaskActivity(client, memberId, workspaceId, taskId, "task_planning_updated", before, after, cause),
      recordAgentAudit: (client, memberId, workspaceId, taskId, cause) =>
        this.#recordAgentExecutionAudit(client, memberId, workspaceId, "agent_task_updated", taskId, cause),
      recordAssignmentNotifications: (client, projectId, activity, before, after) =>
        this.#recordAssignmentNotifications(client, projectId, activity, before, after),
    });
    this.#developmentIntegrationAdapter = new PostgresDevelopmentIntegrationRepositories(this.#kernel, {
      organizationRole: (organizationId, accountId) => this.organizationRole(organizationId, accountId),
      prepareConnections: (client) => this.#ensureRepositoryConnectionSchema(client),
      lockedMemberships: (client, organizationId) => this.#lockedOrganizationMemberships(client, organizationId),
      recordConnectionProjection: (client, record, revision) => this.#recordRepositoryConnectionProjection(client, record, revision),
      prepareSignals: (client) => this.#ensureGitHubSignalSchema(client),
      resolveTask: async (memberId, projectId, taskKey) => {
        const result = await this.#workPlanningAdapter.findTaskByKey(memberId, projectId, taskKey);
        return result.status === "found" ? { status: "found", task: { id: result.task.id, key: result.task.key,
          title: result.task.title, ...(result.task.developmentLinks ? { developmentLinks: result.task.developmentLinks } : {}) } }
          : { status: result.status };
      },
      linkArtifact: (memberId, projectId, taskKey, artifact) => this.#linkDevelopmentArtifact(memberId, projectId, taskKey, artifact),
      linkSignalArtifact: (client, taskId, signal, confirmingMemberId, organizationId) =>
        this.#linkSignalArtifact(client, taskId, signal, confirmingMemberId, organizationId),
    });
  }

  noteTreeRepository(): NoteTreeRepository {
    return this.#noteTreeRepository;
  }

  relationshipQueryRepository(): RelationshipQueryRepository {
    return this.#relationshipQueryRepository;
  }

  visualizationBlockRepository(): VisualizationBlockRepository {
    return this.#visualizationBlockRepository;
  }

  instanceSetupRepository(): InstanceSetupRepository {
    return this.#instanceSetupRepository;
  }

  tutorialContributionRepository(): TutorialContributionRepository {
    return this.#tutorialContributionRepository;
  }

  collectionRepository(): CollectionRepository {
    return this.#collectionRepository;
  }

  projectlessTaskRepository(): ProjectlessTaskRepository {
    return this.#projectlessTaskRepository;
  }

  canonicalTaskRepository(): CanonicalTaskRepository {
    return this.#canonicalTaskRepository;
  }

  identityAccessRepositories(): IdentityAccessPostgresRepositories {
    return Object.assign(this.#identityAccessAdapter, {
      findMemberLocalizationPreferences: this.findMemberLocalizationPreferences.bind(this),
      saveMemberLocalizationPreferences: this.saveMemberLocalizationPreferences.bind(this),
      createWorkspace: this.createWorkspace.bind(this), listAccessibleWorkspaces: this.listAccessibleWorkspaces.bind(this),
      canCreateProject: this.canCreateProject.bind(this), createProject: this.createProject.bind(this),
      findPortableMemberIdentity: this.findPortableMemberIdentity.bind(this),
      findOidcIdentity: this.findOidcIdentity.bind(this), findOidcConfiguration: this.findOidcConfiguration.bind(this),
      organizationRole: this.organizationRole.bind(this), saveOidcConfiguration: this.saveOidcConfiguration.bind(this),
      linkOidcIdentity: this.linkOidcIdentity.bind(this),
      assignBuiltInRole: this.assignBuiltInRole.bind(this), removeOrganizationMember: this.removeOrganizationMember.bind(this),
      listCustomRoles: this.listCustomRoles.bind(this), createCustomRole: this.createCustomRole.bind(this),
      updateCustomRole: this.updateCustomRole.bind(this), assignCustomRole: this.assignCustomRole.bind(this),
      revokeCustomRole: this.revokeCustomRole.bind(this),
      createInvitation: this.createInvitation.bind(this), acceptInvitation: this.acceptInvitation.bind(this),
      readProject: this.readProject.bind(this), canWriteProject: this.canWriteProject.bind(this),
      savePasskey: this.savePasskey.bind(this), findPasskey: this.findPasskey.bind(this),
      updatePasskeyCounterAndCreateSession: this.updatePasskeyCounterAndCreateSession.bind(this),
      replaceRecoveryCodes: this.replaceRecoveryCodes.bind(this),
      consumeRecoveryCodeAndCreateSession: this.consumeRecoveryCodeAndCreateSession.bind(this),
      enqueueEmailRecovery: this.enqueueEmailRecovery.bind(this), claimEmailRecoveryDelivery: this.claimEmailRecoveryDelivery.bind(this),
      renewEmailRecoveryDelivery: this.renewEmailRecoveryDelivery.bind(this), completeEmailRecoveryDelivery: this.completeEmailRecoveryDelivery.bind(this),
      retryEmailRecoveryDelivery: this.retryEmailRecoveryDelivery.bind(this), findEmailRecoveryAccount: this.findEmailRecoveryAccount.bind(this),
      consumeEmailRecoveryAndCreateSession: this.consumeEmailRecoveryAndCreateSession.bind(this),
      createAgentGrant: this.createAgentGrant.bind(this), listAgentGrants: this.listAgentGrants.bind(this),
      revokeAgentGrant: this.revokeAgentGrant.bind(this), findActiveAgentGrant: this.findActiveAgentGrant.bind(this),
      agentGrantOptions: this.agentGrantOptions.bind(this), createAgentProposal: this.createAgentProposal.bind(this),
      listAgentProposals: this.listAgentProposals.bind(this), findAgentProposal: this.findAgentProposal.bind(this),
      claimAgentProposal: this.claimAgentProposal.bind(this), finishAgentProposal: this.finishAgentProposal.bind(this),
      releaseAgentProposal: this.releaseAgentProposal.bind(this), agentGrantTargetAllowed: this.agentGrantTargetAllowed.bind(this),
      listPendingImportedIdentities: this.listPendingImportedIdentities.bind(this),
      mapImportedIdentityAsMember: this.mapImportedIdentityAsMember.bind(this),
    });
  }

  knowledgeAuthoringRepositories(): KnowledgeAuthoringPostgresRepositories {
    return {
      findPortableMemberIdentity: this.findPortableMemberIdentity.bind(this),
      createNote: this.#knowledgeAuthoringAdapter.createNote.bind(this.#knowledgeAuthoringAdapter),
      listInboxNotes: this.#knowledgeAuthoringAdapter.listInboxNotes.bind(this.#knowledgeAuthoringAdapter),
      listNotes: this.#knowledgeAuthoringAdapter.listNotes.bind(this.#knowledgeAuthoringAdapter),
      listNotesByTag: this.#knowledgeAuthoringAdapter.listNotesByTag.bind(this.#knowledgeAuthoringAdapter),
      triageNote: this.#knowledgeAuthoringAdapter.triageNote.bind(this.#knowledgeAuthoringAdapter), findNoteForMember: this.#knowledgeAuthoringAdapter.findNoteForMember.bind(this.#knowledgeAuthoringAdapter),
      applyNoteOperations: this.#knowledgeAuthoringAdapter.applyNoteOperations.bind(this.#knowledgeAuthoringAdapter), listNoteEditConflicts: this.#knowledgeAuthoringAdapter.listNoteEditConflicts.bind(this.#knowledgeAuthoringAdapter),
      resolveNoteEditConflict: this.#knowledgeAuthoringAdapter.resolveNoteEditConflict.bind(this.#knowledgeAuthoringAdapter),
      loadNoteCollaboration: this.loadNoteCollaboration.bind(this), appendNoteCollaboration: this.appendNoteCollaboration.bind(this),
      createNoteLink: this.#knowledgeAuthoringAdapter.createNoteLink.bind(this.#knowledgeAuthoringAdapter),
      createImportedNoteLink: this.#knowledgeAuthoringAdapter.createImportedNoteLink.bind(this.#knowledgeAuthoringAdapter),
      listNoteLinks: this.#knowledgeAuthoringAdapter.listNoteLinks.bind(this.#knowledgeAuthoringAdapter),
      repairNoteLink: this.#knowledgeAuthoringAdapter.repairNoteLink.bind(this.#knowledgeAuthoringAdapter),
      moveNote: this.#knowledgeAuthoringAdapter.moveNote.bind(this.#knowledgeAuthoringAdapter),
      createDiscussion: this.createDiscussion.bind(this), findDiscussion: this.findDiscussion.bind(this),
      listNoteDiscussions: this.listNoteDiscussions.bind(this), listTaskDiscussions: this.listTaskDiscussions.bind(this),
      listBlockDiscussions: this.listBlockDiscussions.bind(this), addMessage: this.addMessage.bind(this),
      resolveDiscussion: this.resolveDiscussion.bind(this), createWorkFromMessages: this.createWorkFromMessages.bind(this),
      searchWorkspace: this.searchWorkspace.bind(this),
      findAttachmentReceipt: this.#knowledgeAuthoringAdapter.findAttachmentReceipt.bind(this.#knowledgeAuthoringAdapter),
      createAttachment: this.#knowledgeAuthoringAdapter.createAttachment.bind(this.#knowledgeAuthoringAdapter),
      canCreateAttachment: this.#knowledgeAuthoringAdapter.canCreateAttachment.bind(this.#knowledgeAuthoringAdapter),
      findAttachmentForMember: this.#knowledgeAuthoringAdapter.findAttachmentForMember.bind(this.#knowledgeAuthoringAdapter),
      listWorkspaceActivity: this.listWorkspaceActivity.bind(this),
      listNoteHistory: this.listNoteHistory.bind(this), restoreNote: this.restoreNote.bind(this),
      readExportSnapshot: this.readExportSnapshot.bind(this), findWorkspaceImport: this.findWorkspaceImport.bind(this),
      importWorkspace: this.importWorkspace.bind(this), mapImportedIdentity: this.mapImportedIdentity.bind(this),
      createMobileCapture: this.#knowledgeAuthoringAdapter.createMobileCapture.bind(this.#knowledgeAuthoringAdapter),
      listMobileCaptureOptions: this.#knowledgeAuthoringAdapter.listMobileCaptureOptions.bind(this.#knowledgeAuthoringAdapter),
    };
  }

  workPlanningRepositories(): WorkPlanningPostgresRepositories {
    return {
      createTaskFromBlock: this.createTaskFromBlock.bind(this),
      createWorkspaceTaskFromBlock: this.createWorkspaceTaskFromBlock.bind(this),
      listLinkedTasks: this.listLinkedTasks.bind(this),
      linkTaskToBlock: this.linkTaskToBlock.bind(this),
      listTaskSourceBlocks: this.listTaskSourceBlocks.bind(this),
      findTaskByKey: this.#workPlanningAdapter.findTaskByKey.bind(this.#workPlanningAdapter),
      updateTaskByKey: this.#workPlanningAdapter.updateTaskByKey.bind(this.#workPlanningAdapter),
      applyStructuredTaskEdit: this.applyStructuredTaskEdit.bind(this),
      listStructuredTaskConflicts: this.listStructuredTaskConflicts.bind(this),
      resolveStructuredTaskConflict: this.resolveStructuredTaskConflict.bind(this),
      moveTask: this.moveTask.bind(this),
      findWorkflow: this.findWorkflow.bind(this), replaceWorkflow: this.replaceWorkflow.bind(this),
      listBoards: this.listBoards.bind(this), createBoard: this.createBoard.bind(this),
      readBoard: this.readBoard.bind(this), moveTaskOnBoard: this.moveTaskOnBoard.bind(this),
      saveNotification: this.#workPlanningAdapter.saveNotification.bind(this.#workPlanningAdapter),
      getNotificationPreferences: this.#workPlanningAdapter.getNotificationPreferences.bind(this.#workPlanningAdapter),
      saveNotificationPreferences: this.#workPlanningAdapter.saveNotificationPreferences.bind(this.#workPlanningAdapter),
      listNotifications: this.#workPlanningAdapter.listNotifications.bind(this.#workPlanningAdapter),
      markNotificationRead: this.#workPlanningAdapter.markNotificationRead.bind(this.#workPlanningAdapter),
      claimDigestNotifications: this.#workPlanningAdapter.claimDigestNotifications.bind(this.#workPlanningAdapter),
      getProjectFollow: this.#workPlanningAdapter.getProjectFollow.bind(this.#workPlanningAdapter),
      saveProjectFollow: this.#workPlanningAdapter.saveProjectFollow.bind(this.#workPlanningAdapter),
      listProjectNotificationAudience: this.#workPlanningAdapter.listProjectNotificationAudience.bind(this.#workPlanningAdapter),
      listAutomationState: this.listAutomationState.bind(this), enableAutomation: this.enableAutomation.bind(this),
      reverseAutomation: this.reverseAutomation.bind(this), applySignalAutomations: this.applySignalAutomations.bind(this),
    };
  }

  developmentIntegrationRepositories(): DevelopmentIntegrationPostgresRepositories {
    return this.#developmentIntegrationAdapter;
  }

  async verifyConnection(): Promise<void> {
    await this.#kernel.query("SELECT 1");
    await this.#verifyAuthenticationKey();
  }

  /** Prepare every storage capability for contract validation or an empty semantic migration target. */
  async prepareInstanceStore(transactionClient?: PostgresQueryable): Promise<void> {
    const prepare = async (client: PostgresQueryable) => {
      await this.#ensureBootstrapSchema(client); await this.#ensureWorkspaceProjectSchema(client);
      await this.#ensureAuthSchema(client); await this.#ensureOidcSchema(client); await this.#ensureRecoverySchema(client);
      await this.#ensureRepositoryConnectionSchema(client); await this.#ensureGitHubSignalSchema(client); await this.#ensureNotificationSchema(client);
      await this.#ensureMemberLocalizationSchema(client);
      await this.#ensureAutomationSchema(client, true);
      await this.#ensureNoteSchema(client); await this.#noteTreeRepository.prepare(client);
      await this.#ensureBoardSchema(client); await this.#ensureAttachmentSchema(client);
      await this.#ensureDiscussionSchema(client); await this.#ensureInvitationSchema(client); await this.#ensurePortableProjectionSchema(client);
      await this.#ensureNoteHistorySchema(client); await this.#ensureMemberDepartureSchema(client); await this.#ensureWorkspaceImportSchema(client);
      await this.#ensureCollaborationSchema(client);
      await this.#instanceSetupRepository.prepare(client);
      await this.#canonicalTaskRepository.prepare(client);
      await this.#tutorialContributionRepository.prepare(client);
      await this.#organizationRoleRepository.prepare(client);
    };
    if (transactionClient) await prepare(transactionClient);
    else await this.#kernel.transaction(prepare);
  }

  async prepareEmptyMigrationDestination(targetVersion: string, beforeCommit?: () => Promise<void>): Promise<void> {
    await this.#kernel.prepareEmptySchemaVersion(targetVersion, async (client) => {
      await this.#verifyAuthenticationKey(client);
      await this.prepareInstanceStore(client);
    }, beforeCommit);
  }

  async createFirstOrganizationOwner(record: BootstrapRecord): Promise<boolean> {
    const workspaceId = record.workspaceId ?? randomUUID();
    const workspaceName = record.workspaceName ?? `${record.organizationName} Workspace`;
    const createdAt = record.createdAt ?? new Date().toISOString();
    return this.#kernel.preparedControlledTransaction(
      (client) => this.#ensureWorkspaceProjectSchema(client),
      async (client) => {
        await this.#kernel.advisoryTransactionLock(client, 2_080_289_093);
        const existing = await client.query("SELECT 1 FROM stash_instance_bootstrap WHERE singleton = TRUE");
        if (existing.rowCount) return { commit: false, value: false };

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
        await client.query(
          `INSERT INTO stash_workspaces
            (id, name, owner_type, personal_owner_id, organization_owner_id, created_by_account_id, created_at)
           VALUES ($1, $2, 'organization', NULL, $3, $4, $5)`,
          [workspaceId, workspaceName, record.organizationId, record.ownerId, createdAt],
        );
        await this.#recordPortableProjection(client, "Workspace", workspaceId, "stash.workspace.v1", {
          schema: "stash.workspace.v1", id: workspaceId, name: workspaceName,
          owner: { type: "organization", identity: { localOrganizationId: record.organizationId, displayName: record.organizationName } },
          createdBy: { localAccountId: record.ownerId, displayName: record.ownerName },
        });
        await client.query("INSERT INTO stash_instance_bootstrap (singleton) VALUES (TRUE)");
        return { commit: true, value: true };
      },
    );
  }

  async setupComplete(): Promise<boolean> {
    return this.#instanceSetupRepository.setupComplete();
  }

  async createFirstPersonalInstance(setup: FirstPersonalInstanceSetup): Promise<boolean> {
    return this.#instanceSetupRepository.createFirstPersonalInstance(setup);
  }

  async findPortableMemberIdentity(memberId: string): Promise<PortableIdentity | undefined> {
    return this.#kernel.withSession(async (client) => {
      await this.#ensureBootstrapSchema(client);
      const result = await client.query<{ id: string; name: string }>(
        "SELECT id, name FROM stash_accounts WHERE id = $1",
        [memberId],
      );
      const member = result.rows[0];
      return member
        ? { localAccountId: member.id, displayName: member.name }
        : undefined;
    });
  }

  async findMemberLocalizationPreferences(memberId: string): Promise<MemberLocalizationPreferences | undefined> {
    await this.#ensureMemberLocalizationSchema();
    const result = await this.#kernel.query<MemberLocalizationRow>(
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
    await this.#kernel.query(
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

  async listAccessibleWorkspaces(memberId: string) {
    return this.#kernel.withSession(async (client) => {
      await this.#ensureWorkspaceProjectSchema(client);
      const result = await client.query<{ workspace_id: string; workspace_name: string; owner_type: "personal" | "organization"; project_id: string | null; project_name: string | null; project_key: string | null }>(`
        SELECT workspace.id AS workspace_id, workspace.name AS workspace_name, workspace.owner_type,
          project.id AS project_id, project.name AS project_name, project.project_key
        FROM stash_workspaces workspace
        LEFT JOIN stash_projects project ON project.workspace_id=workspace.id AND (
          (workspace.owner_type='personal' AND workspace.personal_owner_id=$1)
          OR (workspace.owner_type='organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership WHERE membership.organization_id=workspace.organization_owner_id AND membership.account_id=$1))
          OR EXISTS (SELECT 1 FROM stash_project_guests guest WHERE guest.project_id=project.id AND guest.account_id=$1))
        WHERE (workspace.owner_type='personal' AND workspace.personal_owner_id=$1)
          OR (workspace.owner_type='organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership WHERE membership.organization_id=workspace.organization_owner_id AND membership.account_id=$1))
          OR EXISTS (SELECT 1 FROM stash_projects visible JOIN stash_project_guests guest ON guest.project_id=visible.id WHERE visible.workspace_id=workspace.id AND guest.account_id=$1)
        ORDER BY workspace.name, project.name`, [memberId]);
      const workspaces = new Map<string, { id: string; name: string; ownerType: "personal" | "organization"; projects: Array<{ id: string; name: string; key: string }> }>();
      for (const row of result.rows) { const workspace = workspaces.get(row.workspace_id) ?? { id: row.workspace_id, name: row.workspace_name, ownerType: row.owner_type, projects: [] }; if (row.project_id) workspace.projects.push({ id: row.project_id, name: row.project_name!, key: row.project_key! }); workspaces.set(row.workspace_id, workspace); }
      return [...workspaces.values()];
    });
  }

  async canCreateProject(memberId: string, workspaceId: string): Promise<boolean> {
    return this.#projectPermissionRepository.canCreateProject(memberId, workspaceId);
  }

  async createProject(
    memberId: string,
    record: WorkspaceProjectRecord,
    projection: PortableProjectProjection,
  ): Promise<"created" | "workspace_forbidden" | "workspace_not_found" | "key_conflict"> {
    return this.#withTransaction(async (client) => {
      await this.#ensureNoteSchema(client);
      const access = await this.#projectPermissionRepository.authorize(client, memberId, record.workspaceId);
      if (!access.found) return "workspace_not_found";
      if (!access.allowed) return "workspace_forbidden";
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
    return this.#kernel.withSession(async (client) => {
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
    });
  }

  async listInboxNotes(memberId: string, workspaceId: string) {
    return this.#kernel.withSession(async (client) => {
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
    });
  }

  async listNotesByTag(memberId: string, workspaceId: string, tag: string) {
    return this.#kernel.withSession(async (client) => {
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
    });
  }

  async listNotes(memberId: string, workspaceId: string) {
    return this.#kernel.withSession(async (client) => {
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
        WHERE note.workspace_id = $1 AND note.archived_at IS NULL AND (
          (workspace.owner_type = 'personal' AND workspace.personal_owner_id = $2) OR
          (workspace.owner_type = 'organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
            WHERE membership.organization_id = workspace.organization_owner_id AND membership.account_id = $2)) OR
          (note.project_id IS NOT NULL AND EXISTS (SELECT 1 FROM stash_project_guests guest
            WHERE guest.project_id = note.project_id AND guest.account_id = $2))) ORDER BY note.created_at, note.id`, [workspaceId, memberId]);
      return { status: "found" as const, notes: result.rows.map((row: any) => ({ id: row.id, workspaceId: row.workspace_id,
        content: row.content, document: row.document, revision: row.revision, tags: row.tags, createdByMemberId: row.created_by_account_id,
        createdAt: new Date(row.created_at).toISOString(), ...(row.project_id ? { projectId: row.project_id } : {}),
        ...(row.reminder_at ? { reminder: { at: new Date(row.reminder_at).toISOString() } } : {}) })) };
    });
  }

  async findAttachmentReceipt(memberId: string, workspaceId: string, operationKey: string) {
    return this.#kernel.withSession(async (client) => {
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
    });
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
    return this.#kernel.withSession(async (client) => {
      await this.#ensureWorkspaceProjectSchema(client);
      const access = await client.query(`SELECT 1 FROM stash_workspaces workspace WHERE workspace.id = $1 AND ((workspace.owner_type = 'personal' AND workspace.personal_owner_id = $2) OR EXISTS (SELECT 1 FROM stash_organization_memberships membership WHERE membership.organization_id = workspace.organization_owner_id AND membership.account_id = $2))`, [workspaceId, memberId]);
      return access.rowCount === 1;
    });
  }

  async findAttachmentForMember(memberId: string, attachmentId: string): Promise<AttachmentRecord | undefined> {
    return this.#kernel.withSession(async (client) => {
      await this.#ensureAttachmentSchema(client);
      const result = await client.query<AttachmentRow>(`SELECT attachment.* FROM stash_attachments attachment JOIN stash_workspaces workspace ON workspace.id = attachment.workspace_id WHERE attachment.id = $1 AND ((workspace.owner_type = 'personal' AND workspace.personal_owner_id = $2) OR EXISTS (SELECT 1 FROM stash_organization_memberships membership WHERE membership.organization_id = workspace.organization_owner_id AND membership.account_id = $2))`, [attachmentId, memberId]);
      const row = result.rows[0];
      return row ? attachmentRecord(row) : undefined;
    });
  }

  createTaskFromBlock(memberId: string,noteId: string,blockKey: string,draft: CreateTaskFromBlockDraft): Promise<CreateTaskFromBlockOutcome> {
    return this.#createTaskFromBlock(memberId,noteId,blockKey,draft) as Promise<CreateTaskFromBlockOutcome>;
  }
  createWorkspaceTaskFromBlock(memberId: string,noteId: string,blockKey: string,draft: Omit<CreateTaskFromBlockDraft,"projectId">): Promise<CreateWorkspaceTaskFromBlockOutcome> {
    return this.#createTaskFromBlock(memberId,noteId,blockKey,draft) as Promise<CreateWorkspaceTaskFromBlockOutcome>;
  }
  async #createTaskFromBlock(memberId: string, noteId: string, blockKey: string, draft: CreateTaskFromBlockDraft | Omit<CreateTaskFromBlockDraft,"projectId">) {
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
      if ("projectId" in draft) { const project = await client.query("SELECT 1 FROM stash_projects WHERE id = $1 AND workspace_id = $2", [draft.projectId, row.workspace_id]);
        if (!project.rowCount) return { status: "project_forbidden" as const }; }
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
      let task: any;
      if ("projectId" in draft) {
        task = await this.#createTask(client, { ...draft, workspaceId: row.workspace_id, sourceNoteIds: [noteId], sourceBlocks: [{ noteId, blockId }] });
        await client.query("INSERT INTO stash_tasks (id, workspace_id, project_id, task_key, workflow_status_id, title, created_by_account_id, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
          [task.id,row.workspace_id,task.projectId,task.key,task.status.id,task.title,memberId,task.createdAt]);
      } else {
        const workflow = await this.#canonicalTaskRepository.ensureWorkflow(client,row.workspace_id); const status=workflow.statuses.find(({category})=>category==="unstarted")!;
        task={schema:"stash.task.v1",...draft,workspaceId:row.workspace_id,status,sourceNoteIds:[noteId],sourceBlocks:[{noteId,blockId}]};
        await client.query(`INSERT INTO stash_tasks(id,workspace_id,project_id,task_key,workflow_status_id,workspace_workflow_status_id,title,description,
          created_by_account_id,created_at) VALUES($1,$2,NULL,NULL,NULL,$3,$4,'',$5,$6)`,[task.id,row.workspace_id,status.id,task.title,memberId,task.createdAt]);
      }
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
        const noteAccess = await this.#authorizeNote(client, memberId, draft.target.noteId);
        if (noteAccess === "none") return { status: "target_not_found" as const };
        if (noteAccess === "read") return { status: "forbidden" as const };
        const note = await client.query<any>(`SELECT note.*, creator.name AS created_by_name
          FROM stash_notes note
          JOIN stash_accounts creator ON creator.id = note.created_by_account_id
          WHERE note.id = $1 FOR UPDATE OF note`, [draft.target.noteId]);
        const row = note.rows[0];
        if (!row) return { status: "target_not_found" as const };
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
    return this.#kernel.withSession(async (client) => {
      await this.#ensureDiscussionSchema(client);
      const discussion = await this.#readDiscussion(client, memberId, discussionId, false);
      return discussion ? { status: "found" as const, discussion } : { status: "not_found" as const };
    });
  }

  async listNoteDiscussions(memberId: string, noteId: string) {
    return this.#kernel.withSession(async (client) => {
      await this.#ensureDiscussionSchema(client);
      const access = await this.#authorizeNote(client, memberId, noteId);
      if (access === "none") return { status: "not_found" as const };
      const ids = await client.query<{ id: string }>("SELECT id FROM stash_discussions WHERE note_id = $1 ORDER BY created_at, id", [noteId]);
      const discussions: DiscussionRecord[] = [];
      for (const { id } of ids.rows) {
        const discussion = await this.#readDiscussion(client, memberId, id, false);
        if (discussion) discussions.push(discussion);
      }
      return { status: "found" as const, access, discussions };
    });
  }

  async listTaskDiscussions(memberId: string, taskId: string) {
    return this.#kernel.withSession(async (client) => {
      await this.#ensureDiscussionSchema(client);
      const access = await client.query<{ can_write: boolean }>(`SELECT ((workspace.owner_type = 'personal' AND workspace.personal_owner_id = $2) OR EXISTS (
          SELECT 1 FROM stash_organization_memberships membership WHERE membership.organization_id = workspace.organization_owner_id
            AND membership.account_id = $2)) AS can_write FROM stash_tasks task JOIN stash_workspaces workspace ON workspace.id = task.workspace_id
        WHERE task.id = $1 AND (((workspace.owner_type = 'personal' AND workspace.personal_owner_id = $2) OR EXISTS (
          SELECT 1 FROM stash_organization_memberships membership WHERE membership.organization_id = workspace.organization_owner_id
            AND membership.account_id = $2)) OR EXISTS (
          SELECT 1 FROM stash_project_guests guest WHERE guest.project_id = task.project_id AND guest.account_id = $2))`, [taskId, memberId]);
      if (!access.rowCount) return { status: "not_found" as const };
      const ids = await client.query<{ id: string }>("SELECT id FROM stash_discussions WHERE task_id = $1 ORDER BY created_at, id", [taskId]);
      const discussions: DiscussionRecord[] = [];
      for (const { id } of ids.rows) {
        const discussion = await this.#readDiscussion(client, memberId, id, false);
        if (discussion) discussions.push(discussion);
      }
      return { status: "found" as const, access: access.rows[0]!.can_write ? "edit" as const : "read" as const, discussions };
    });
  }

  async listBlockDiscussions(memberId: string, noteId: string, blockKey: string) {
    return this.#kernel.withSession(async (client) => {
      await this.#ensureDiscussionSchema(client);
      const access = await this.#authorizeNote(client, memberId, noteId);
      if (access === "none") return { status: "not_found" as const };
      const note = await client.query<any>("SELECT document FROM stash_notes WHERE id = $1", [noteId]);
      if (!note.rowCount) return { status: "not_found" as const };
      const blocks = Array.isArray(note.rows[0].document?.blocks) ? note.rows[0].document.blocks as Array<{ blockKey?: string; id?: string }> : [];
      const matches = blocks.filter((block) => block.blockKey === blockKey);
      if (matches.length !== 1 || typeof matches[0]!.id !== "string"
        || blocks.filter((block) => block.id === matches[0]!.id).length !== 1) return { status: "not_found" as const };
      const ids = await client.query<{ id: string }>(`SELECT id FROM stash_discussions
        WHERE target_kind = 'block' AND note_id = $1 AND block_id = $2 ORDER BY created_at, id`, [noteId, matches[0]!.id]);
      const discussions: DiscussionRecord[] = [];
      for (const { id } of ids.rows) {
        const discussion = await this.#readDiscussion(client, memberId, id, false);
        if (discussion?.target.kind === "block") discussions.push(discussion);
      }
      return { status: "found" as const, access, discussions };
    });
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
    return this.#kernel.withSession(async (client) => {
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
    });
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
    return this.#kernel.withSession(async (client) => {
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
    });
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

  async #findProjectWorkflowAccess(client: PostgresQueryable, memberId: string, projectId: string, lock = false): Promise<"member" | "forbidden" | "not_found"> {
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

  async #loadWorkflow(client: PostgresQueryable, projectId: string): Promise<ProjectWorkflow> {
    const project = await client.query<{ workflow_revision: number }>("SELECT workflow_revision FROM stash_projects WHERE id = $1", [projectId]);
    const statuses = await client.query<{ id: string; name: string; category: WorkflowStatus["category"]; position: number; archived: boolean }>(
      "SELECT id, name, category, position, archived FROM stash_workflow_statuses WHERE project_id = $1 ORDER BY position, id", [projectId]);
    return { schema: "stash.workflow.v1", projectId, revision: project.rows[0]!.workflow_revision, statuses: statuses.rows };
  }

  async listBoards(memberId: string, projectId: string) {
    return this.#kernel.withSession(async (client) => {
      await this.#ensureBoardSchema(client); await this.#ensureInvitationSchema(client);
      if (await this.#findProjectWorkflowAccess(client, memberId, projectId) === "not_found") return { status: "not_found" as const };
      const result = await client.query<any>("SELECT id, project_id, name, group_by, created_at FROM stash_boards WHERE project_id = $1 ORDER BY created_at, id", [projectId]);
      return { status: "found" as const, boards: result.rows.map(boardFromRow) };
    });
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
    return this.#kernel.withSession(async (client) => {
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
    });
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
            "task_structured_edit_applied", beforeTask, afterTask, batch.cause);
          if (batch.cause?.kind === "agent") await this.#recordAgentExecutionAudit(client, memberId, row.workspace_id,
            "agent_proposal_task_applied", row.id, batch.cause);
          await this.#recordAssignmentNotifications(client, projectId, activity, beforeTask, afterTask);
        }
      }
      await client.query("INSERT INTO stash_task_edit_operations (task_id,operation_id,digest,outcome) VALUES ($1,$2,$3,$4::jsonb)",
        [row.id, batch.operationId, digest, JSON.stringify(outcome)]);
      return outcome;
    });
  }

  async listStructuredTaskConflicts(memberId: string, projectId: string, taskKey: string) {
    return this.#kernel.withSession(async (client) => {
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
    });
  }

  async resolveStructuredTaskConflict(memberId: string, projectId: string, taskKey: string, conflictId: string,
    resolution: "keep_current" | "apply_contribution", expectedRevision: number, operationId?: string) {
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
      if (conflictRow.resolved_at) {
        if (operationId && conflictRow.resolution_operation_id === operationId && conflictRow.resolution === resolution)
          return { status: "resolved" as const, task: taskPlanningReadModelFromRow(row), revision: row.revision, activity: undefined };
        return { status: "already_resolved" as const };
      }
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
      await client.query("UPDATE stash_task_edit_conflicts SET resolved_at = $2, resolution = $3, resolution_operation_id = $4 WHERE id = $1", [conflictId, occurredAt, resolution, operationId ?? null]);
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

  async #applyStructuredTaskChanges(client: PostgresQueryable, memberId: string, row: any, update: TaskPlanningUpdate): Promise<boolean> {
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

  async #createTask(client: PostgresQueryable, draft: TaskCreation): Promise<PortableTaskProjection> {
    await client.query("SELECT id FROM stash_projects WHERE id = $1 FOR UPDATE", [draft.projectId]);
    await this.#ensureDefaultWorkflow(client, draft.projectId);
    const workflowStatus = initialWorkflowStatus(await this.#loadWorkflow(client, draft.projectId));
    const allocation = await client.query<{ project_key: string; task_number: number }>(
      `UPDATE stash_projects SET next_task_number = next_task_number + 1 WHERE id = $1
       RETURNING project_key, next_task_number - 1 AS task_number`, [draft.projectId]);
    const key = allocation.rows[0];
    if (!key) throw new Error("task_project_unavailable");
    return { schema: "stash.task.v1", ...draft, key: `${key.project_key}-${key.task_number}`, status: workflowStatus };
  }

  async #ensureDefaultWorkflow(client: PostgresQueryable, projectId: string): Promise<void> {
    const statuses = [[randomUUID(), projectId, "Backlog", "unstarted", 0], [randomUUID(), projectId, "Ready", "unstarted", 1],
      [randomUUID(), projectId, "In Progress", "started", 2], [randomUUID(), projectId, "In Review", "started", 3],
      [randomUUID(), projectId, "Done", "completed", 4]] as const;
    await client.query(`INSERT INTO stash_workflow_statuses (id, project_id, name, category, position)
      VALUES ${statuses.map((_, index) => `($${index * 5 + 1}, $${index * 5 + 2}, $${index * 5 + 3}, $${index * 5 + 4}, $${index * 5 + 5})`).join(", ")}
      ON CONFLICT DO NOTHING`, statuses.flat());
    const initialized = await client.query("UPDATE stash_projects SET workflow_revision = 1 WHERE id = $1 AND workflow_revision = 0 RETURNING id", [projectId]);
    if (initialized.rowCount) {
      const workflow = await this.#loadWorkflow(client, projectId);
      await this.#recordPortableProjection(client, "Workflow", projectId, workflow.schema, workflow);
    }
  }

  async searchWorkspace(memberId: string, workspaceId: string, query: WorkspaceSearchQuery) {
    return this.#kernel.withSession(async (client) => {
      await this.#ensureDiscussionSchema(client);
      await this.#ensureAttachmentSchema(client);
      await this.#ensureInvitationSchema(client);
      const access = await client.query<{ full_member: boolean; requested_project_visible: boolean }>(`SELECT
        ((workspace.owner_type='personal' AND workspace.personal_owner_id=$2) OR
         (workspace.owner_type='organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
           WHERE membership.organization_id=workspace.organization_owner_id AND membership.account_id=$2))) AS full_member,
        ($3::uuid IS NULL OR EXISTS (SELECT 1 FROM stash_projects requested_project
          WHERE requested_project.id=$3 AND requested_project.workspace_id=workspace.id AND
            (((workspace.owner_type='personal' AND workspace.personal_owner_id=$2) OR
              (workspace.owner_type='organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
                WHERE membership.organization_id=workspace.organization_owner_id AND membership.account_id=$2)))
             OR EXISTS (SELECT 1 FROM stash_project_guests guest
                WHERE guest.project_id=requested_project.id AND guest.account_id=$2)))) AS requested_project_visible
        FROM stash_workspaces workspace WHERE workspace.id=$1 AND (((workspace.owner_type='personal' AND workspace.personal_owner_id=$2) OR
         (workspace.owner_type='organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
           WHERE membership.organization_id=workspace.organization_owner_id AND membership.account_id=$2))) OR EXISTS (
             SELECT 1 FROM stash_projects project JOIN stash_project_guests guest ON guest.project_id=project.id
             WHERE project.workspace_id=workspace.id AND guest.account_id=$2))`, [workspaceId, memberId, query.projectId ?? null]);
      if (!access.rowCount || !access.rows[0]!.requested_project_visible) return { status: "forbidden" as const };
      const values = [workspaceId, memberId, query.q, query.projectId ?? null, query.object ?? null, query.author ?? null,
        query.assignee ?? null, query.status ?? null, query.from ?? null, query.to ?? null, access.rows[0]!.full_member];
      const rows = await client.query<any>(`WITH visible_projects AS (
          SELECT project.id FROM stash_projects project JOIN stash_workspaces workspace ON workspace.id=project.workspace_id
          WHERE project.workspace_id=$1 AND ($11::boolean OR EXISTS (SELECT 1 FROM stash_project_guests guest
            WHERE guest.project_id=project.id AND guest.account_id=$2))
        ), candidates AS (
          SELECT note.id::text, 'note'::text AS kind, split_part(note.content,E'\\n',1) AS title,
            left(note.content,240) AS excerpt, '/app/notes/'||note.id AS href, note.project_id,
            author.name AS author, NULL::text AS assignee, CASE WHEN note.archived_at IS NULL THEN 'active' ELSE 'archived' END AS status,
            note.created_at AS occurred_at, note.content AS searchable
          FROM stash_notes note JOIN stash_accounts author ON author.id=note.created_by_account_id
          WHERE note.workspace_id=$1 AND (($11 AND note.project_id IS NULL) OR note.project_id IN (SELECT id FROM visible_projects))
          UNION ALL
          SELECT task.id::text,'task',CASE WHEN association.task_key IS NULL THEN task.title ELSE association.task_key||' · '||task.title END,
            task.title,'/app/tasks/'||task.id,association.project_id,
            author.name, (SELECT string_agg(account.name,', ' ORDER BY account.name) FROM stash_accounts account
              WHERE task.assignee_ids ? account.id::text), COALESCE(workspace_status.name,status.name), task.created_at,
            concat_ws(' ',association.task_key,task.task_key,task.title,task.label_names::text,task.development_links::text,
              (SELECT string_agg(visible_key,' ') FROM (
                SELECT active.task_key visible_key FROM stash_task_projects active
                  WHERE active.task_id=task.id AND active.project_id IN(SELECT id FROM visible_projects)
                UNION SELECT alias.task_key FROM stash_task_key_aliases alias
                  WHERE alias.task_id=task.id AND alias.project_id IN(SELECT id FROM visible_projects)
              ) visible_keys))
          FROM stash_tasks task JOIN stash_accounts author ON author.id=task.created_by_account_id
          LEFT JOIN stash_workflow_statuses status ON status.id=task.workflow_status_id
          LEFT JOIN stash_workspace_workflow_statuses workspace_status ON workspace_status.id=task.workspace_workflow_status_id
          LEFT JOIN LATERAL (SELECT link.project_id,link.task_key FROM stash_task_projects link
            WHERE link.task_id=task.id AND link.project_id IN(SELECT id FROM visible_projects)
              AND ($4::uuid IS NULL OR link.project_id=$4) ORDER BY link.project_id LIMIT 1) association ON TRUE
          WHERE task.workspace_id=$1 AND ($11 OR association.project_id IS NOT NULL)
          UNION ALL
          SELECT discussion.id::text,'discussion',left(message.content,120),left(message.content,240),
            CASE discussion.target_kind WHEN 'task' THEN '/app/tasks/'||discussion.task_id||'/discussions' ELSE '/app/notes/'||discussion.note_id||'/discussions' END,
            COALESCE(note.project_id,task.project_id),author.name,NULL,CASE WHEN discussion.resolved_at IS NULL THEN 'open' ELSE 'resolved' END,
            message.created_at,message.content
          FROM stash_discussions discussion JOIN stash_discussion_messages message ON message.discussion_id=discussion.id
          JOIN stash_accounts author ON author.id=message.author_account_id LEFT JOIN stash_notes note ON note.id=discussion.note_id
          LEFT JOIN stash_tasks task ON task.id=discussion.task_id WHERE discussion.workspace_id=$1
            AND ($11 OR COALESCE(note.project_id,task.project_id) IN (SELECT id FROM visible_projects))
          UNION ALL
          SELECT attachment.id::text,'file',attachment.filename,attachment.content_type,attachment.relative_path,NULL,
            author.name,NULL,NULL,attachment.created_at,attachment.filename||' '||attachment.content_type
          FROM stash_attachments attachment JOIN stash_accounts author ON author.id=attachment.created_by_account_id
          WHERE attachment.workspace_id=$1 AND $11
          UNION ALL
          SELECT task.id::text||':'||label.value,'label',label.value,NULL,'/app/projects/'||task.project_id||'/tasks/'||task.task_key,task.project_id,
            NULL,NULL,status.name,task.created_at,label.value
          FROM stash_tasks task CROSS JOIN LATERAL jsonb_array_elements_text(task.label_names) label(value)
          JOIN stash_workflow_statuses status ON status.id=task.workflow_status_id
          WHERE task.workspace_id=$1 AND task.project_id IN (SELECT id FROM visible_projects)
          UNION ALL
          SELECT account.id::text,'member',account.name,account.email,NULL,NULL,account.name,NULL,NULL,NULL,
            account.name||' '||account.email FROM stash_accounts account JOIN stash_organization_memberships membership ON membership.account_id=account.id
          JOIN stash_workspaces workspace ON workspace.organization_owner_id=membership.organization_id WHERE workspace.id=$1 AND $11
          UNION ALL
          SELECT task.id::text||':'||development.ordinality,'development',COALESCE(development.value->>'label',development.value->>'url'),
            development.value->>'url',development.value->>'url',task.project_id,author.name,NULL,status.name,task.created_at,development.value::text
          FROM stash_tasks task CROSS JOIN LATERAL jsonb_array_elements(task.development_links) WITH ORDINALITY development(value,ordinality)
          JOIN stash_accounts author ON author.id=task.created_by_account_id JOIN stash_workflow_statuses status ON status.id=task.workflow_status_id
          WHERE task.workspace_id=$1 AND task.project_id IN (SELECT id FROM visible_projects)
        ), filtered AS (
          SELECT id,kind,title,excerpt,href,project_id,author,assignee,status,occurred_at FROM candidates
          WHERE searchable ILIKE '%'||$3||'%' AND ($4::uuid IS NULL OR project_id=$4) AND ($5::text IS NULL OR kind=$5)
            AND ($6::text IS NULL OR author ILIKE '%'||$6||'%') AND ($7::text IS NULL OR assignee ILIKE '%'||$7||'%')
            AND ($8::text IS NULL OR status ILIKE $8) AND ($9::timestamptz IS NULL OR occurred_at >= $9)
            AND ($10::timestamptz IS NULL OR occurred_at <= $10)
        ), page AS (
          SELECT * FROM filtered ORDER BY occurred_at DESC NULLS LAST, kind, title LIMIT 100
        ) SELECT
          COALESCE((SELECT jsonb_agg(to_jsonb(page) ORDER BY occurred_at DESC NULLS LAST,kind,title) FROM page),'[]'::jsonb) AS results,
          (SELECT count(*)::integer FROM filtered) AS total,
          COALESCE((SELECT jsonb_agg(jsonb_build_object('value',kind,'count',count) ORDER BY kind)
            FROM (SELECT kind,count(*)::integer AS count FROM filtered GROUP BY kind) facet),'[]'::jsonb) AS kind_facets,
          COALESCE((SELECT jsonb_agg(jsonb_build_object('value',project_id,'count',count) ORDER BY project_id)
            FROM (SELECT project_id,count(*)::integer AS count FROM filtered WHERE project_id IS NOT NULL GROUP BY project_id) facet),'[]'::jsonb) AS project_facets,
          COALESCE((SELECT jsonb_agg(jsonb_build_object('value',status,'count',count) ORDER BY status)
            FROM (SELECT status,count(*)::integer AS count FROM filtered WHERE status IS NOT NULL GROUP BY status) facet),'[]'::jsonb) AS status_facets`, values);
      const envelope = rows.rows[0]!;
      return { status: "found" as const, results: envelope.results.map((row: any): WorkspaceSearchResult => ({ id: row.id, kind: row.kind,
        title: row.title, ...(row.excerpt ? { excerpt: row.excerpt } : {}), ...(row.href ? { href: row.href } : {}),
        ...(row.project_id ? { projectId: row.project_id } : {}), ...(row.author ? { author: row.author } : {}),
        ...(row.assignee ? { assignee: row.assignee } : {}), ...(row.status ? { status: row.status } : {}),
        ...(row.occurred_at ? { occurredAt: new Date(row.occurred_at).toISOString() } : {}) })), total: envelope.total,
        facets: { kinds: envelope.kind_facets as WorkspaceSearchFacet<WorkspaceSearchKind>[],
          projects: envelope.project_facets as WorkspaceSearchFacet[], statuses: envelope.status_facets as WorkspaceSearchFacet[] } };
    });
  }

  async listWorkspaceActivity(memberId: string, workspaceId: string) {
    return this.#kernel.withSession(async (client) => {
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
    });
  }

  async listNoteHistory(memberId: string, noteId: string) {
    return this.#kernel.withSession(async (client) => {
      await this.#ensureNoteHistorySchema(client);
      await this.#backfillLegacyNoteHistory(client);
      const access = await this.#authorizeNote(client, memberId, noteId);
      if (access === "none") return { status: "not_found" as const };
      const rows = await client.query<any>(`SELECT history.*, actor.name AS actor_name FROM stash_note_history history
        JOIN stash_accounts actor ON actor.id=history.actor_account_id
        WHERE history.note_id=$1 ORDER BY history.revision`, [noteId]);
      return { status: "found" as const, access, revisions: rows.rows.map((row): NoteHistoryRevision => ({ noteId: row.note_id,
        workspaceId: row.workspace_id, revision: Number(row.revision), content: row.content, document: row.document,
        recordedAt: new Date(row.recorded_at).toISOString(), actor: { localAccountId: row.actor_account_id, displayName: row.actor_name },
        cause: this.#parseActivityCause(row.cause) })) };
    });
  }

  async restoreNote(memberId: string, noteId: string, targetRevision: number, expectedRevision: number, idempotencyKey: string) {
    return this.#withTransaction(async (client) => {
      await this.#ensureNoteHistorySchema(client);
      await this.#backfillLegacyNoteHistory(client);
      if (await this.#authorizeNote(client, memberId, noteId) !== "edit") return { status: "not_found" as const };
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [noteId, idempotencyKey]);
      const found = await client.query<any>(`SELECT note.*, creator.name AS creator_name FROM stash_notes note
        JOIN stash_accounts creator ON creator.id=note.created_by_account_id
        WHERE note.id=$1 FOR UPDATE OF note`, [noteId]);
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
    await this.#kernel.close();
  }

  async resolveClientSessionPrincipal(accountId: string) {
    return this.#kernel.withSession(async (client) => {
      await this.#ensureInvitationSchema(client);
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
    });
  }

  async findOidcIdentity(key: OidcIdentityKey): Promise<OidcIdentityRecord | undefined> {
    await this.#ensureOidcSchema();
    const result = await this.#kernel.query<OidcIdentityRow>(`
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
    const result = await this.#kernel.query<OidcConfigurationRow>(
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
    const result = await this.#kernel.query<{ role: BuiltInOrganizationRole }>(
      "SELECT role FROM stash_organization_memberships WHERE organization_id = $1 AND account_id = $2",
      [organizationId, accountId],
    );
    return result.rows[0]?.role;
  }

  async #linkDevelopmentArtifact(memberId: string, projectId: string, taskKey: string, artifact: DevelopmentArtifact) {
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

  async listAutomationState(memberId: string, projectId: string, taskKey: string): Promise<AutomationState | undefined> {
    await this.#ensureGitHubSignalSchema();
    return this.#withTransaction(async (client) => {
      await this.#ensureAutomationSchema(client, true);
      const visible = await client.query<any>(taskPlanningSelect, [projectId, taskKey, memberId]);
      const task = visible.rows[0]; if (!task) return undefined;
      const recipes = await client.query<any>(`SELECT recipe.*,
        COALESCE(workspace_status.id,legacy_status.id) target_status_id,
        COALESCE(workspace_status.name,legacy_status.name) AS target_status_name FROM stash_automation_recipes recipe
        LEFT JOIN stash_workflow_statuses legacy_status ON legacy_status.id=recipe.target_status_id
        LEFT JOIN stash_workspace_workflow_statuses workspace_status ON workspace_status.id=recipe.workspace_target_status_id
        WHERE recipe.project_id=$1 ORDER BY recipe.created_at,recipe.id`, [projectId]);
      const transitions = await client.query<any>(`SELECT transition.*,
        COALESCE(workspace_before.id,legacy_before.id) before_status_id,COALESCE(workspace_after.id,legacy_after.id) after_status_id,
        COALESCE(workspace_before.name,legacy_before.name) before_status_name,COALESCE(workspace_after.name,legacy_after.name) after_status_name
        FROM stash_automation_transitions transition
        LEFT JOIN stash_workflow_statuses legacy_before ON legacy_before.id=transition.before_status_id
        LEFT JOIN stash_workflow_statuses legacy_after ON legacy_after.id=transition.after_status_id
        LEFT JOIN stash_workspace_workflow_statuses workspace_before ON workspace_before.id=transition.workspace_before_status_id
        LEFT JOIN stash_workspace_workflow_statuses workspace_after ON workspace_after.id=transition.workspace_after_status_id
        WHERE transition.task_id=$1 ORDER BY transition.occurred_at DESC`, [task.id]);
      const statuses = task.workspace_workflow_status_id
        ? await client.query<{ id: string; name: string }>("SELECT id,name FROM stash_workspace_workflow_statuses WHERE workspace_id=$1 ORDER BY position", [task.workspace_id])
        : await client.query<{ id: string; name: string }>("SELECT id,name FROM stash_workflow_statuses WHERE project_id=$1 AND archived=FALSE ORDER BY position", [projectId]);
      return { recipes: recipes.rows.map(automationRecipeFromRow), transitions: transitions.rows.map(automationTransitionFromRow), availableStatuses: statuses.rows };
    });
  }

  async enableAutomation(memberId: string, projectId: string, trigger: AutomationTrigger, targetStatusId: string) {
    await this.#ensureGitHubSignalSchema();
    return this.#withTransaction(async (client) => {
      await this.#ensureAutomationSchema(client, true);
      const access = await this.#findProjectWorkflowAccess(client, memberId, projectId, true);
      if (access === "forbidden") return "forbidden" as const;
      if (access === "not_found") return "not_found" as const;
      const status = await client.query<{ name: string; canonical: boolean }>(`SELECT status.name,FALSE canonical FROM stash_workflow_statuses status
        WHERE status.id=$1 AND status.project_id=$2 AND status.archived=FALSE UNION ALL
        SELECT status.name,TRUE canonical FROM stash_workspace_workflow_statuses status JOIN stash_projects project ON project.workspace_id=status.workspace_id
        WHERE status.id=$1 AND project.id=$2`, [targetStatusId, projectId]);
      if (!status.rowCount) return "invalid_status" as const;
      const id = randomUUID();
      const canonical=status.rows[0]!.canonical;
      const result = await client.query<any>(`INSERT INTO stash_automation_recipes(id,project_id,trigger,target_status_id,workspace_target_status_id,created_by_account_id,created_at)
        VALUES($1,$2,$3,$4,$5,$6,now()) ON CONFLICT(project_id,trigger) DO UPDATE SET target_status_id=EXCLUDED.target_status_id,
        workspace_target_status_id=EXCLUDED.workspace_target_status_id,
        enabled=TRUE,created_by_account_id=EXCLUDED.created_by_account_id,created_at=EXCLUDED.created_at
        RETURNING *`, [id,projectId,trigger,canonical?null:targetStatusId,canonical?targetStatusId:null,memberId]);
      return { status: "enabled" as const, recipe: automationRecipeFromRow({ ...result.rows[0], target_status_id:targetStatusId,target_status_name:status.rows[0]!.name }) };
    });
  }

  async reverseAutomation(memberId: string, projectId: string, taskKey: string, transitionId: string) {
    await this.#ensureGitHubSignalSchema();
    return this.#withTransaction(async (client) => {
      await this.#ensureAutomationSchema(client, true);
      const access = await this.#findProjectWorkflowAccess(client, memberId, projectId, true);
      if (access === "forbidden") return "forbidden" as const;
      if (access === "not_found") return "not_found" as const;
      const result = await client.query<any>(`SELECT transition.*,
        COALESCE(workspace_before.id,legacy_before.id) before_status_id,COALESCE(workspace_after.id,legacy_after.id) after_status_id,
        COALESCE(workspace_before.name,legacy_before.name) before_status_name,COALESCE(workspace_after.name,legacy_after.name) after_status_name,
        task.workflow_status_id,task.workspace_workflow_status_id,task.workspace_id
        FROM stash_automation_transitions transition JOIN stash_tasks task ON task.id=transition.task_id
        LEFT JOIN stash_workflow_statuses legacy_before ON legacy_before.id=transition.before_status_id
        LEFT JOIN stash_workflow_statuses legacy_after ON legacy_after.id=transition.after_status_id
        LEFT JOIN stash_workspace_workflow_statuses workspace_before ON workspace_before.id=transition.workspace_before_status_id
        LEFT JOIN stash_workspace_workflow_statuses workspace_after ON workspace_after.id=transition.workspace_after_status_id
        WHERE transition.id=$1 AND transition.project_id=$2 AND (task.task_key=$3
          OR EXISTS(SELECT 1 FROM stash_task_projects association WHERE association.task_id=task.id AND association.project_id=$2 AND association.task_key=$3)
          OR EXISTS(SELECT 1 FROM stash_task_key_aliases alias WHERE alias.task_id=task.id AND alias.project_id=$2 AND alias.task_key=$3))
        FOR UPDATE OF transition,task`, [transitionId,projectId,taskKey]);
      const row = result.rows[0]; if (!row) return "not_found" as const;
      if (row.reversed_at) return { status: "reversed" as const, transition: automationTransitionFromRow(row) };
      const canonical=row.workspace_after_status_id!==null; const currentStatusId=row.workspace_workflow_status_id??row.workflow_status_id;
      if (currentStatusId !== row.after_status_id) return "conflict" as const;
      const before = await client.query<any>(taskPlanningSelectById, [row.task_id, memberId]);
      await client.query(`UPDATE stash_tasks SET workflow_status_id=CASE WHEN $3 THEN workflow_status_id ELSE $2 END,
        workspace_workflow_status_id=CASE WHEN $3 THEN $2 ELSE workspace_workflow_status_id END,revision=revision+1,
        field_revisions=jsonb_set(field_revisions,'{statusId}',to_jsonb(revision+1),true) WHERE id=$1`, [row.task_id,row.before_status_id,canonical]);
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
    await this.#ensureGitHubSignalSchema();
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
          await this.#ensureAutomationSchema(client, true);
        const result = await client.query<any>(`SELECT recipe.id AS automation_id,
          COALESCE(recipe.workspace_target_status_id,recipe.target_status_id) target_status_id,
          recipe.workspace_target_status_id IS NOT NULL canonical_status,recipe.created_by_account_id,
          configurer.name AS created_by_name,task.*,
          COALESCE(current_workspace.name,current_legacy.name) status_name,
          COALESCE(current_workspace.category,current_legacy.category) status_category
          FROM stash_automation_recipes recipe JOIN stash_tasks task ON task.id=$1 AND
            (task.project_id=recipe.project_id OR EXISTS(SELECT 1 FROM stash_task_projects association
              WHERE association.task_id=task.id AND association.project_id=recipe.project_id))
          LEFT JOIN stash_workflow_statuses current_legacy ON current_legacy.id=task.workflow_status_id
          LEFT JOIN stash_workspace_workflow_statuses current_workspace ON current_workspace.id=task.workspace_workflow_status_id
          JOIN stash_accounts configurer ON configurer.id=recipe.created_by_account_id
          WHERE recipe.project_id=$2 AND recipe.trigger=$3 AND recipe.enabled=TRUE FOR UPDATE OF task,recipe`, [candidate.taskId, candidate.projectId, triggeredSignal.trigger]);
        const row = result.rows[0]; const currentStatusId=row?.workspace_workflow_status_id??row?.workflow_status_id;
        if (!row || currentStatusId === row.target_status_id) return;
        failedRun = { automationId: row.automation_id, configuringMemberId: row.created_by_account_id,
          configuringMemberName: row.created_by_name, workspaceId: row.workspace_id, projectId: candidate.projectId,
          taskId: row.id, taskKey: candidate.taskKey??candidate.matchedKey??row.task_key??"Task", taskTitle: row.title };
        const inserted = await client.query<any>(`INSERT INTO stash_automation_transitions(id,automation_id,signal_id,task_id,project_id,
          before_status_id,after_status_id,workspace_before_status_id,workspace_after_status_id,occurred_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()) ON CONFLICT(automation_id,signal_id,task_id) DO NOTHING RETURNING id,occurred_at`,
        [randomUUID(),row.automation_id,signal.id,row.id,candidate.projectId,row.canonical_status?null:currentStatusId,
          row.canonical_status?null:row.target_status_id,row.canonical_status?currentStatusId:null,row.canonical_status?row.target_status_id:null]);
        if (!inserted.rowCount) return;
        const before = taskPlanningReadModelFromRow(row);
        await client.query(`UPDATE stash_tasks SET workflow_status_id=CASE WHEN $3 THEN workflow_status_id ELSE $2 END,
          workspace_workflow_status_id=CASE WHEN $3 THEN $2 ELSE workspace_workflow_status_id END,revision=revision+1,
          field_revisions=jsonb_set(field_revisions,'{statusId}',to_jsonb(revision+1),true) WHERE id=$1`, [row.id,row.target_status_id,row.canonical_status]);
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
    await this.#ensureGitHubSignalSchema();
    return this.#withTransaction(async (client) => {
      await this.#ensureAutomationSchema(client, true);
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
    await this.#ensureGitHubSignalSchema();
    return this.#withTransaction(async (client) => {
      await this.#ensureAutomationSchema(client, true);
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

  async #canReceiveProjectNotification(client: PostgresQueryable, memberId: string, projectId: string, workspaceId: string): Promise<boolean> {
    const access = await client.query(`SELECT 1 FROM stash_projects project JOIN stash_workspaces workspace ON workspace.id=project.workspace_id
      WHERE project.id=$1 AND workspace.id=$2 AND ((workspace.owner_type='personal' AND workspace.personal_owner_id=$3) OR
        (workspace.owner_type='organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
          WHERE membership.organization_id=workspace.organization_owner_id AND membership.account_id=$3)))`, [projectId, workspaceId, memberId]);
    return Boolean(access.rowCount);
  }

  async #linkSignalArtifact(client: PostgresQueryable, taskId: string, signal: GitHubSignal, confirmingMemberId?: string, organizationId?: string) {
    const actor = confirmingMemberId ? { id: confirmingMemberId, cause: { kind: "member" } as ActivityCause }
      : (await client.query<{ id: string }>(`SELECT membership.account_id AS id FROM stash_organization_memberships membership
        WHERE membership.organization_id=$1 AND membership.role='Owner' ORDER BY membership.account_id LIMIT 1`, [organizationId])).rows[0];
    if (!actor) return;
    const task = await client.query<any>(`${taskPlanningSelectById} FOR UPDATE OF task`, [taskId, actor.id]);
    const row = task.rows[0]; if (!row) return;
    await this.#persistTaskDevelopmentArtifact(client, row, actor.id, signal, "task_development_signal_linked",
      confirmingMemberId ? { kind: "member" } : { kind: "signal", signalId: signal.id });
  }

  async #persistTaskDevelopmentArtifact(client: PostgresQueryable, row: any, actorId: string,
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

  listCustomRoles(organizationId: string): Promise<CustomOrganizationRole[]> {
    return this.#organizationRoleRepository.listCustomRoles(organizationId);
  }

  createCustomRole(organizationId: string, actorId: string, role: CustomOrganizationRole) {
    return this.#organizationRoleRepository.createCustomRole(organizationId, actorId, role);
  }

  updateCustomRole(organizationId: string, actorId: string, roleId: string,
    input: { name: string; permissions: Array<"create_project"> }) {
    return this.#organizationRoleRepository.updateCustomRole(organizationId, actorId, roleId, input);
  }

  assignCustomRole(organizationId: string, actorId: string, roleId: string, memberId: string) {
    return this.#organizationRoleRepository.assignCustomRole(organizationId, actorId, roleId, memberId);
  }

  revokeCustomRole(organizationId: string, actorId: string, roleId: string, memberId: string) {
    return this.#organizationRoleRepository.revokeCustomRole(organizationId, actorId, roleId, memberId);
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
      await this.#organizationRoleRepository.removeAssignmentsForMember(client, organizationId, accountId);
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
    return this.#kernel.withSession(async (client) => {
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
    });
  }

  async canWriteProject(accountId: string, projectId: string): Promise<boolean> {
    return this.#kernel.withSession(async (client) => {
      await this.#ensureInvitationSchema(client);
      const result = await client.query(
        `SELECT 1 FROM stash_projects project JOIN stash_workspaces workspace ON workspace.id = project.workspace_id
         JOIN stash_organization_memberships membership ON membership.organization_id = workspace.organization_owner_id
         WHERE project.id = $1 AND membership.account_id = $2`, [projectId, accountId],
      );
      return result.rowCount === 1;
    });
  }

  async #lockedOrganizationMemberships(client: PostgresQueryable, organizationId: string) {
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
    await this.#kernel.query(`
      INSERT INTO stash_oidc_configurations (organization_id, issuer, client_id, client_secret)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (organization_id) DO UPDATE SET issuer = EXCLUDED.issuer, client_id = EXCLUDED.client_id, client_secret = EXCLUDED.client_secret
    `, [configuration.organizationId, configuration.issuer, configuration.clientId, this.#authenticationSecrets.encrypt(configuration.clientSecret)]);
  }

  async linkOidcIdentity(key: OidcIdentityKey, accountId: string): Promise<boolean> {
    await this.#ensureOidcSchema();
    const result = await this.#kernel.query(`
      INSERT INTO stash_oidc_identities (organization_id, issuer, subject_lookup, subject_secret, account_id)
      SELECT $1, $3, $4, $5, account_id FROM stash_organization_memberships
      WHERE organization_id = $1 AND account_id = $2
      ON CONFLICT (organization_id, issuer, account_id) DO UPDATE
      SET subject_lookup = EXCLUDED.subject_lookup, subject_secret = EXCLUDED.subject_secret
    `, [key.organizationId, accountId, key.issuer, this.#oidcIdentityLookup(key), this.#authenticationSecrets.encrypt(key.subject)]);
    return result.rowCount === 1;
  }

  async savePasskey(record: PasskeyRecord): Promise<void> {
    await this.#ensureRecoverySchema();
    await this.#kernel.query(
      "INSERT INTO stash_passkeys (credential_id, account_id, public_key, signature_counter, transports, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
      [record.credentialId, record.accountId, this.#authenticationSecrets.encrypt(record.publicKey), record.counter, record.transports ?? null, record.createdAt],
    );
  }

  async findPasskey(credentialId: string): Promise<PasskeyRecord | undefined> {
    await this.#ensureRecoverySchema();
    const result = await this.#kernel.query<{ credential_id: string; account_id: string; public_key: string; signature_counter: number; transports: string[] | null; created_at: Date | string }>(
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
    const result = await this.#kernel.query<{ account_id: string }>("SELECT account_id FROM stash_email_recoveries WHERE token_lookup = $1 AND expires_at > $2", [this.#authenticationSecrets.blindIndex(lookup), now]);
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
    const result = await this.#kernel.query("UPDATE stash_email_recovery_delivery_jobs SET lease_until = $4 WHERE id = $1 AND claim_owner = $2 AND claim_version = $3", [claim.jobId, claim.owner, claim.version, leaseUntil]);
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
    const result = await this.#kernel.query("UPDATE stash_email_recovery_delivery_jobs SET attempts = attempts + 1, last_error = $4, available_at = NOW() + INTERVAL '1 minute', claim_owner = NULL, lease_until = NULL WHERE id = $1 AND claim_owner = $2 AND claim_version = $3", [claim.jobId, claim.owner, claim.version, reason.slice(0, 500)]);
    return result.rowCount === 1;
  }

  async #insertSession(client: PostgresQueryable, session: SessionRecord): Promise<void> {
    await client.query(
      "INSERT INTO stash_sessions (id, account_id, token_lookup, token_hash, created_at, last_seen_at, user_agent) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [session.id, session.accountId, this.#authenticationSecrets.blindIndex(session.tokenHash), this.#authenticationSecrets.encrypt(session.tokenHash), session.createdAt, session.lastSeenAt, session.userAgent ?? null],
    );
  }

  async #transaction<T>(work: (client: PostgresQueryable) => Promise<{ commit: boolean; value: T }>): Promise<T> {
    return this.#kernel.controlledTransaction(work);
  }

  async #ensureAuthSchema(client: PostgresQueryable = this.#kernel): Promise<void> {
    await client.query(`
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

  async #ensureOidcSchema(client: PostgresQueryable = this.#kernel): Promise<void> {
    await client.query(`
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

  async #ensureRecoverySchema(client: PostgresQueryable = this.#kernel): Promise<void> {
    await this.#ensureAuthSchema(client);
    await client.query(`
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
  async #verifyAuthenticationKey(transactionClient?: PostgresQueryable): Promise<void> {
    const prepareTable = (client: PostgresQueryable) => client.query(`
        CREATE TABLE IF NOT EXISTS stash_authentication_key_check (
          singleton BOOLEAN PRIMARY KEY CHECK (singleton),
          encrypted_check TEXT NOT NULL
        )
      `);
    const verify = async (client: PostgresQueryable) => {
      await this.#kernel.advisoryTransactionLock(client, authenticationKeyCheckLockId);
      const result = await client.query<{ encrypted_check: string }>(
        "SELECT encrypted_check FROM stash_authentication_key_check WHERE singleton = TRUE",
      );
      const existing = result.rows[0];
      if (existing) verifyAuthenticationKeyCheck(this.#authenticationSecrets, existing.encrypted_check);
      else await client.query(
        "INSERT INTO stash_authentication_key_check (singleton, encrypted_check) VALUES (TRUE, $1)",
        [createAuthenticationKeyCheck(this.#authenticationSecrets)],
      );
    };
    if (transactionClient) {
      await prepareTable(transactionClient);
      await verify(transactionClient);
    } else {
      await prepareTable(this.#kernel);
      await this.#kernel.transaction(verify);
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

  async #ensureBootstrapSchema(client: PostgresQueryable): Promise<void> {
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

  async #ensureRepositoryConnectionSchema(transactionClient?: PostgresQueryable): Promise<void> {
    const prepare = async (client: PostgresQueryable) => {
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
    };
    const upgrade = async (client: PostgresQueryable) => {
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
    };
    if (transactionClient) {
      await prepare(transactionClient);
      await this.#kernel.advisoryTransactionLock(transactionClient, 1_094_218_495);
      await upgrade(transactionClient);
    } else {
      await this.#kernel.advisorySessionTransaction(1_094_218_495, prepare, upgrade);
    }
  }

  async #ensureGitHubSignalSchema(transactionClient?: PostgresQueryable): Promise<void> {
    const prepare = async (client: PostgresQueryable) => {
      await this.#ensureRepositoryConnectionSchema(client);
      await this.#ensureNoteSchema(client);
      await client.query(`
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
    };
    if (transactionClient) await prepare(transactionClient);
    else await this.#kernel.transaction(prepare);
  }

  async #ensureAutomationSchema(client: PostgresQueryable, dependenciesPrepared = false): Promise<void> {
    await this.#instanceSetupRepository.prepare(client);
    if (!dependenciesPrepared) await this.#ensureGitHubSignalSchema(client);
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
      ALTER TABLE stash_automation_recipes ALTER COLUMN target_status_id DROP NOT NULL;
      ALTER TABLE stash_automation_recipes ADD COLUMN IF NOT EXISTS workspace_target_status_id UUID REFERENCES stash_workspace_workflow_statuses(id);
      ALTER TABLE stash_automation_transitions ALTER COLUMN before_status_id DROP NOT NULL;
      ALTER TABLE stash_automation_transitions ALTER COLUMN after_status_id DROP NOT NULL;
      ALTER TABLE stash_automation_transitions ADD COLUMN IF NOT EXISTS workspace_before_status_id UUID REFERENCES stash_workspace_workflow_statuses(id);
      ALTER TABLE stash_automation_transitions ADD COLUMN IF NOT EXISTS workspace_after_status_id UUID REFERENCES stash_workspace_workflow_statuses(id);
    `);
  }

  async #ensureWorkspaceProjectSchema(client: PostgresQueryable): Promise<void> {
    await this.#ensureBootstrapSchema(client);
    await client.query(`
      CREATE TABLE IF NOT EXISTS stash_workspaces (
        id UUID PRIMARY KEY,
        name TEXT NOT NULL,
        owner_type TEXT NOT NULL CHECK (owner_type IN ('personal', 'organization')),
        personal_owner_id UUID REFERENCES stash_accounts(id),
        organization_owner_id UUID REFERENCES stash_organizations(id),
        created_by_account_id UUID NOT NULL REFERENCES stash_accounts(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CHECK (
          (owner_type = 'personal' AND personal_owner_id IS NOT NULL AND organization_owner_id IS NULL)
          OR
          (owner_type = 'organization' AND personal_owner_id IS NULL AND organization_owner_id IS NOT NULL)
        )
      );
      ALTER TABLE stash_workspaces ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
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
      CREATE TABLE IF NOT EXISTS stash_project_guests (
        project_id UUID NOT NULL REFERENCES stash_projects(id),
        account_id UUID NOT NULL REFERENCES stash_accounts(id),
        PRIMARY KEY (project_id, account_id)
      );
      ALTER TABLE stash_projects ADD COLUMN IF NOT EXISTS next_task_number INTEGER NOT NULL DEFAULT 1 CHECK (next_task_number > 0);
      ALTER TABLE stash_projects ADD COLUMN IF NOT EXISTS workflow_revision INTEGER NOT NULL DEFAULT 0 CHECK (workflow_revision >= 0);
      ALTER TABLE stash_projects ADD COLUMN IF NOT EXISTS parent_project_id UUID REFERENCES stash_projects(id) ON DELETE SET NULL;
    `);
    await this.#ensurePortableProjectionSchema(client);
  }

  async #ensureNotificationSchema(transactionClient?: PostgresQueryable): Promise<void> {
    const prepare = async (client: PostgresQueryable) => {
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
    };
    if (transactionClient) await prepare(transactionClient);
    else await this.#kernel.withSession(prepare);
  }

  async #ensureNoteSchema(client: PostgresQueryable): Promise<void> {
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
      CREATE TABLE IF NOT EXISTS stash_note_capture_operation_receipts (
        account_id UUID NOT NULL REFERENCES stash_accounts(id), operation_id UUID NOT NULL,
        workspace_id UUID NOT NULL REFERENCES stash_workspaces(id), payload_digest TEXT NOT NULL,
        note_id UUID NOT NULL REFERENCES stash_notes(id), PRIMARY KEY (account_id, operation_id)
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
      CREATE TABLE IF NOT EXISTS stash_task_projects(
        task_id UUID NOT NULL REFERENCES stash_tasks(id) ON DELETE CASCADE,
        project_id UUID NOT NULL REFERENCES stash_projects(id) ON DELETE CASCADE,
        task_key TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(task_id,project_id), UNIQUE(project_id,task_key)
      );
      INSERT INTO stash_task_projects(task_id,project_id,task_key)
        SELECT id,project_id,task_key FROM stash_tasks WHERE project_id IS NOT NULL AND task_key IS NOT NULL ON CONFLICT DO NOTHING;
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
      ALTER TABLE stash_tasks ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';
      ALTER TABLE stash_tasks ADD COLUMN IF NOT EXISTS parent_task_id UUID REFERENCES stash_tasks(id) ON DELETE SET NULL;
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
        resolved_at TIMESTAMPTZ, resolution TEXT CHECK (resolution IN ('keep_current','apply_contribution')), resolution_operation_id UUID
      );
      ALTER TABLE stash_task_edit_conflicts ADD COLUMN IF NOT EXISTS resolution_operation_id UUID;
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

  async #ensureBoardSchema(client: PostgresQueryable): Promise<void> {
    await this.#ensureNoteSchema(client);
    await client.query(`CREATE TABLE IF NOT EXISTS stash_boards (
      id UUID PRIMARY KEY, project_id UUID NOT NULL REFERENCES stash_projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100), group_by TEXT NOT NULL CHECK (group_by IN ('status','priority')),
      created_at TIMESTAMPTZ NOT NULL, UNIQUE (project_id, name))`);
  }

  async #ensureNoteSchemaForPool(): Promise<void> {
    await this.#kernel.withSession((client) => this.#ensureNoteSchema(client));
  }

  async #ensureAttachmentSchema(client: PostgresQueryable): Promise<void> {
    await this.#ensureWorkspaceProjectSchema(client);
    await client.query(`CREATE TABLE IF NOT EXISTS stash_attachments (id UUID PRIMARY KEY, workspace_id UUID NOT NULL REFERENCES stash_workspaces(id), filename TEXT NOT NULL, content_type TEXT NOT NULL, byte_size BIGINT NOT NULL CHECK (byte_size > 0), relative_path TEXT NOT NULL, storage_key TEXT NOT NULL UNIQUE, source TEXT NOT NULL CHECK (source IN ('upload','paste')), created_by_account_id UUID NOT NULL REFERENCES stash_accounts(id), created_at TIMESTAMPTZ NOT NULL)`);
    await client.query(`CREATE TABLE IF NOT EXISTS stash_attachment_operation_receipts (
      operation_key UUID NOT NULL, workspace_id UUID NOT NULL REFERENCES stash_workspaces(id),
      created_by_account_id UUID NOT NULL REFERENCES stash_accounts(id), payload_digest TEXT NOT NULL,
      attachment_id UUID NOT NULL UNIQUE REFERENCES stash_attachments(id), projection JSONB NOT NULL,
      PRIMARY KEY (operation_key, workspace_id, created_by_account_id))`);
  }

  async #ensureDiscussionSchema(client: PostgresQueryable): Promise<void> {
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

  async #readDiscussion(client: PostgresQueryable, memberId: string, discussionId: string, lock: boolean): Promise<DiscussionRecord | undefined> {
    const result = await client.query<any>(`SELECT discussion.*, note.document FROM stash_discussions discussion
      LEFT JOIN stash_notes note ON note.id = discussion.note_id
      WHERE discussion.id = $1${lock ? " FOR UPDATE OF discussion" : ""}`, [discussionId]);
    const row = result.rows[0];
    if (!row) return undefined;
    if (row.target_kind === "note" || row.target_kind === "block") {
      if (await this.#authorizeNote(client, memberId, row.note_id) === "none") return undefined;
    } else {
      const taskAccess = await client.query(`SELECT 1 FROM stash_tasks task JOIN stash_workspaces workspace ON workspace.id=task.workspace_id
        WHERE task.id=$1 AND ((workspace.owner_type='personal' AND workspace.personal_owner_id=$2) OR EXISTS (
          SELECT 1 FROM stash_organization_memberships membership WHERE membership.organization_id=workspace.organization_owner_id
            AND membership.account_id=$2) OR EXISTS (
          SELECT 1 FROM stash_project_guests guest WHERE guest.project_id=task.project_id AND guest.account_id=$2))`, [row.task_id, memberId]);
      if (!taskAccess.rowCount) return undefined;
    }
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

  async #canWriteDiscussion(client: PostgresQueryable, memberId: string, workspaceId: string): Promise<boolean> {
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

  async #ensureMemberLocalizationSchema(transactionClient?: PostgresQueryable): Promise<void> {
    const prepare = async (client: PostgresQueryable) => {
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
    };
    if (transactionClient) await prepare(transactionClient);
    else await this.#kernel.withSession(prepare);
  }

  async #ensureInvitationSchema(client: PostgresQueryable): Promise<void> {
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
    await this.#kernel.advisoryTransactionLock(client, 1_465_271_063);
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

  async #ensurePortableProjectionSchema(client: PostgresQueryable): Promise<void> {
    await this.#kernel.advisoryTransactionLock(client, 1_094_218_495);
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
  }

  async #recordPortableProjection(
    client: PostgresQueryable,
    objectKind: "Workspace" | "Project" | "Workflow" | "WorkspaceWorkflow" | "Collection" | "ViewBlock" | "Board" | "Note" | "NoteLocation" | "NoteLink" | "Task" | "GuestProjectAccess" | "RepositoryConnection" | "Attachment" | "Discussion" | "DiscussionWorkLink" | "Activity",
    objectId: string,
    projectionSchema: "stash.workspace.v1" | "stash.project.v1" | "stash.workflow.v1" | "stash.workspace-workflow.v1" | "stash.collection.v1" | "stash.view-block.v1" | "stash.board.v1" | "stash.note.v1" | "stash.note.v2" | "stash.note-location.v1" | "stash.note-link.v1" | "stash.note-link.v2" | "stash.task.v1" | "stash.guest-project-access.v1" | "stash.repository-connection.v1" | "stash.attachment.v1" | "stash.discussion.v1" | "stash.discussion-work-link.v1" | "stash.activity.v1",
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

  async #recordInitialNoteLocation(client: PostgresQueryable, noteId: string, workspaceId: string): Promise<void> {
    const projection: PortableNoteLocationProjection = { schema: "stash.note-location.v1", noteId, workspaceId,
      path: `notes/${noteId}.md`, aliases: [], revision: 1 };
    await this.#recordPortableProjection(client, "NoteLocation", noteId, projection.schema, projection);
  }

  async #recordRepositoryConnectionProjection(client: PostgresQueryable, record: RepositoryConnectionRecord, revision: number): Promise<void> {
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
    return this.#kernel.withSession(async (client) => {
      await this.#ensureWorkspaceImportSchema(client);
      const found = await client.query<{ archive_sha256: string; report: PortableWorkspaceImportReport }>(
        "SELECT archive_sha256,report FROM stash_workspace_imports WHERE import_id=$1", [importId]);
      return found.rows[0] ? { archiveSha256: found.rows[0].archive_sha256, report: found.rows[0].report } : undefined;
    });
  }

  async importWorkspace(importId: string, bundle: PortableWorkspaceImportBundle) {
    return this.#withTransaction(async (client) => {
      await this.#ensureWorkspaceImportSchema(client);
      await this.#instanceSetupRepository.prepare(client);
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
      for (const item of durable.filter(({ kind }) => kind === "Project")) if (item.payload.parentProjectId)
        await client.query("UPDATE stash_projects SET parent_project_id=$2 WHERE id=$1", [item.id,item.payload.parentProjectId]);
      for (const item of durable.filter(({ kind }) => kind === "Workflow")) {
        const workflow = item.payload as ProjectWorkflow;
        await client.query("UPDATE stash_projects SET workflow_revision=$2 WHERE id=$1", [workflow.projectId, workflow.revision]);
        for (const status of workflow.statuses) await client.query(`INSERT INTO stash_workflow_statuses
          (id,project_id,name,category,position,archived) VALUES($1,$2,$3,$4,$5,$6)`,
        [status.id, workflow.projectId, status.name, status.category, status.position, status.archived]);
        await this.#recordPortableProjection(client, "Workflow", item.id, item.schema as any, workflow);
      }
      for (const item of durable.filter(({ kind }) => kind === "WorkspaceWorkflow")) {
        const workflow = item.payload;
        for (const status of workflow.statuses) await client.query(`INSERT INTO stash_workspace_workflow_statuses
          (id,workspace_id,name,category,position) VALUES($1,$2,$3,$4,$5)`,
        [status.id, state.workspace.id, status.name, status.category, status.position]);
        await this.#recordPortableProjection(client, "WorkspaceWorkflow", item.id, item.schema as any, workflow);
      }
      for (const note of state.notes) {
        const history = state.noteHistory.filter((revision) => revision.noteId === note.id).sort((a,b) => a.revision-b.revision);
        const latest = history.at(-1); const location = state.noteLocations.find(({ noteId }) => noteId === note.id)!;
        const document = structuredClone(latest?.document ?? markdownToRichText(note.content));
        const view = durable.find(({ kind, payload }) => kind === "ViewBlock" && payload.ownerNoteId === note.id)?.payload;
        if (view && !document.blocks.some(({ id }: any) => id === view.blockId)) document.blocks.push({ type: "paragraph",
          blockKey: randomUUID(), id: view.blockId, content: [{ text: `View: ${view.title}` }] });
        await client.query(`INSERT INTO stash_notes(id,workspace_id,project_id,content,document,revision,tags,reminder_at,
          created_by_account_id,created_at,portable_path,location_revision) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8,$9,$10,$11,$12)`,
        [note.id,state.workspace.id,note.projectId ?? null,note.content,JSON.stringify(document),
          latest?.revision ?? 1,JSON.stringify(note.tags),note.reminder?.at ?? null,accountFor(note.createdBy),note.createdAt,location.path,location.revision]);
        for (const alias of location.aliases) await client.query("INSERT INTO stash_note_path_aliases(workspace_id,note_id,path) VALUES($1,$2,$3)",
          [state.workspace.id,note.id,alias]);
        await this.#recordPortableProjection(client,"Note",note.id,note.schema,note);
        await this.#recordPortableProjection(client,"NoteLocation",note.id,location.schema,location);
      }
      await this.#noteTreeRepository.applyImportedLocations(client, state.noteLocations);
      for (const item of durable.filter(({ kind }) => kind === "Collection")) {
        const collection=item.payload; await client.query("INSERT INTO stash_collections(id,workspace_id,owner_note_id,title) VALUES($1,$2,$3,$4)",
          [collection.id,state.workspace.id,collection.ownerNoteId,collection.title]);
        for(const property of collection.properties) { const configuration=property.type==="single_select"||property.type==="multi_select"?{options:property.options}
          :property.type==="relation"?{target:property.target}:{};
          await client.query("INSERT INTO stash_collection_properties(id,collection_id,name,property_type,configuration,position) VALUES($1,$2,$3,$4,$5::jsonb,$6)",
            [property.id,collection.id,property.name,property.type,JSON.stringify(configuration),property.position]); }
        for(const record of collection.records){await client.query("INSERT INTO stash_collection_records(id,collection_id,position) VALUES($1,$2,$3)",[record.id,collection.id,record.position]);
          for(const [propertyId,value] of Object.entries(record.values))await client.query("INSERT INTO stash_collection_record_values(record_id,property_id,value) VALUES($1,$2,$3::jsonb)",[record.id,propertyId,JSON.stringify(value)]);}
        await this.#recordPortableProjection(client,"Collection",item.id,item.schema as any,collection);
      }
      for (const item of durable.filter(({ kind }) => kind === "ViewBlock")) {
        const view=item.payload; await client.query(`INSERT INTO stash_view_blocks(id,workspace_id,owner_note_id,block_id,title,source_kind,source_workspace_id,
          source_collection_id,source_project_scope,query,layout,definition) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL,$10,$11::jsonb)`,
        [view.id,state.workspace.id,view.ownerNoteId,view.blockId,view.title,view.definition.source.kind,
          view.definition.source.kind==="tasks"?view.definition.source.workspaceId:null,
          view.definition.source.kind==="collection"?view.definition.source.collectionId:null,
          view.definition.source.kind==="tasks"?"none":null,view.definition.presentation,JSON.stringify(view.definition)]);
        await this.#recordPortableProjection(client,"ViewBlock",item.id,item.schema as any,view);
      }
      for (const contributor of this.#portableProjectionContributors)
        await contributor.importPortableObjects(client, durable, state.workspace.id);
      for (const task of state.tasks) {
        await client.query(`INSERT INTO stash_tasks(id,workspace_id,project_id,task_key,workflow_status_id,workspace_workflow_status_id,title,description,parent_task_id,created_by_account_id,created_at,
          assignee_ids,former_assignee_ids,priority,label_names,due_date,estimate,linked_note_ids,development_links)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,NULL,$9,$10,$11::jsonb,$12::jsonb,$13,$14::jsonb,$15,$16,$17::jsonb,$18::jsonb)`,
        [task.id,state.workspace.id,task.projectId??null,task.key??null,task.projectId?task.status.id:null,task.projectId?null:task.status.id,task.title,(task as any).description??"",accountFor(task.createdBy),task.createdAt,
          JSON.stringify(task.assigneeIds ?? []),JSON.stringify(task.formerAssigneeIds ?? []),task.priority ?? "none",
          JSON.stringify(task.labelNames ?? []),task.dueDate ?? null,task.estimate ?? null,
          JSON.stringify(task.linkedNoteIds ?? []),JSON.stringify(task.developmentLinks ?? [])]);
        for (const noteId of task.sourceNoteIds) await client.query("INSERT INTO stash_task_note_sources(task_id,note_id) VALUES($1,$2)",[task.id,noteId]);
        for (const source of task.sourceBlocks ?? []) await client.query("INSERT INTO stash_task_block_sources(task_id,note_id,block_id) VALUES($1,$2,$3)",[task.id,source.noteId,source.blockId]);
        for (const alias of task.keyAliases ?? []) await client.query("INSERT INTO stash_task_key_aliases(project_id,task_key,task_id) VALUES($1,$2,$3)",[alias.projectId,alias.key,task.id]);
        for (const association of (task as any).projectKeys ?? []) await client.query(
          "INSERT INTO stash_task_projects(task_id,project_id,task_key) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
          [task.id,association.projectId,association.key]);
        await this.#recordPortableProjection(client,"Task",task.id,task.schema,task);
      }
      for (const task of state.tasks) if ((task as any).parentTaskId) await client.query(
        "UPDATE stash_tasks SET parent_task_id=$2 WHERE id=$1", [task.id,(task as any).parentTaskId]);
      for (const task of state.tasks) for (const edge of task.dependencies ?? []) if (edge.type === "depends_on")
        await client.query("INSERT INTO stash_task_dependencies(dependent_task_id,prerequisite_task_id) VALUES($1,$2) ON CONFLICT DO NOTHING",[task.id,edge.taskId]);
      for (const project of durable.filter(({ kind }) => kind === "Project").map(({ id }) => id)) {
        const numbers = state.tasks.flatMap((task) => [
          ...(task.projectId === project && task.key ? [task.key] : []),
          ...(((task as any).projectKeys ?? []).filter((entry: any) => entry.projectId === project).map((entry: any) => entry.key)),
          ...((task.keyAliases ?? []).filter((entry) => entry.projectId === project).map((entry) => entry.key)),
        ]).map((key) => Number(key.slice(key.lastIndexOf("-") + 1)))
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
        "targetPath" in link ? link.targetPath : null,"candidateNoteIds" in link ? link.candidateNoteIds : [],"label" in link ? link.label : "Note",
        "revision" in link ? link.revision : 1]);
        await this.#recordPortableProjection(client,"NoteLink",link.id,link.schema,link); }
      await this.#noteTreeRepository.applyImportedRelationships(client, state.noteLinks);
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
      for (const item of durable.filter(({ kind }) => !["Project","Workflow","WorkspaceWorkflow","Collection","ViewBlock","RepositoryConnection"].includes(kind)))
        await this.#recordPortableProjection(client,item.kind as any,item.id,item.schema as any,item.payload);
      const ownership: ImportTransformation = {kind:"transformed",object:`Workspace:${state.workspace.id}`,
        reason:`ownership_mapped:${bundle.destinationOwnerAccountId}`};
      const transformations: ImportTransformation[] = [ownership,...(bundle.transformations ?? []),...bundle.identityStubs.map((identity) => ({ kind:"transformed" as const,
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

  async listPendingImportedIdentities(memberId: string) {
    return this.#kernel.withSession(async (client) => {
      await this.#ensureWorkspaceImportSchema(client); await this.#ensureWorkspaceProjectSchema(client);
      const result=await client.query<{import_id:string;workspace_id:string;workspace_name:string;organization_id:string|null;report:PortableWorkspaceImportReport}>(`
        SELECT imported.import_id,imported.workspace_id,workspace.name workspace_name,workspace.organization_owner_id organization_id,imported.report
        FROM stash_workspace_imports imported JOIN stash_workspaces workspace ON workspace.id=imported.workspace_id
        WHERE workspace.personal_owner_id=$1 OR workspace.organization_owner_id IN (
          SELECT organization_id FROM stash_organization_memberships WHERE account_id=$1 AND role IN ('Owner','Admin'))
        ORDER BY workspace.name,imported.import_id`,[memberId]);
      const mapped=await client.query<{source_account_id:string}>("SELECT source_account_id FROM stash_identity_stubs WHERE mapped_to_account_id IS NOT NULL");
      const resolved=new Set(mapped.rows.map(({source_account_id})=>source_account_id));
      return result.rows.flatMap((row)=>row.report.identityStubs.filter(({sourceAccountId})=>!resolved.has(sourceAccountId)).map((identity)=>({
        importId:row.import_id,workspaceId:row.workspace_id,workspaceName:row.workspace_name,...(row.organization_id?{organizationId:row.organization_id}:{}),...identity,
      })));
    });
  }

  async mapImportedIdentityAsMember(memberId:string,input:{importId:string;sourceAccountId:string;localAccountId:string;idempotencyKey:string}) {
    const allowed = await this.#kernel.withSession(async (client) => {
      await this.#ensureWorkspaceImportSchema(client); await this.#ensureWorkspaceProjectSchema(client);
      const result=await client.query(`SELECT 1 FROM stash_workspace_imports imported JOIN stash_workspaces workspace ON workspace.id=imported.workspace_id
        WHERE imported.import_id=$1 AND ((workspace.personal_owner_id=$2 AND $3=$2) OR
          (workspace.organization_owner_id IS NOT NULL AND EXISTS (SELECT 1 FROM stash_organization_memberships actor
            JOIN stash_organization_memberships target ON target.organization_id=actor.organization_id
            WHERE actor.organization_id=workspace.organization_owner_id AND actor.account_id=$2
              AND actor.role IN ('Owner','Admin') AND target.account_id=$3)))`,
      [input.importId,memberId,input.localAccountId]);
      return Boolean(result.rowCount);
    });
    if (!allowed) return {status:"forbidden" as const};
    return this.mapImportedIdentity(input);
  }

  async readExportSnapshot(memberId: string, workspaceId: string): Promise<
    { status: "found"; snapshot: PortableWorkspaceExportSnapshot }
    | { status: "workspace_forbidden" | "workspace_not_found" }
  > {
    // Schema preparation is deliberately outside the read-only snapshot transaction.
    await this.#kernel.withSession(async (setup) => {
      await this.#ensureNoteSchema(setup);
      await this.#ensureNoteHistorySchema(setup);
      await this.#backfillLegacyNoteHistory(setup);
      await this.#ensureAttachmentSchema(setup);
      await this.#ensureInvitationSchema(setup);
      await this.#ensureBoardSchema(setup);
      for (const contributor of this.#portableProjectionContributors) await contributor.preparePortableObjects(setup);
    });

    return this.#kernel.readOnlySnapshot(async (client) => {
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
      if (!permission) return { status: "workspace_not_found" };
      const guestProjectIds = permission.guest_project_ids ?? [];
      if (!permission.member && guestProjectIds.length === 0) return { status: "workspace_forbidden" };
      if (!permission.workspace_projection) throw new Error("workspace_projection_unavailable");

      const notes = await client.query<{ id: string; payload: PortableNoteProjection | PortableNoteStateProjection | null }>(
        `SELECT note.id, projection.payload FROM stash_notes note
         JOIN stash_workspaces workspace ON workspace.id=note.workspace_id
         LEFT JOIN LATERAL (SELECT payload FROM stash_portable_projection_outbox
           WHERE object_kind = 'Note' AND object_id = note.id ORDER BY revision DESC LIMIT 1) projection ON TRUE
         WHERE note.workspace_id = $1 AND ($2::boolean OR ${effectiveNoteReadSql("note", "workspace", "$3")})
         ORDER BY note.id`, [workspaceId, permission.member, memberId]);
      if (notes.rows.some(({ payload }) => !payload)) throw new Error("portable_projection_unavailable");
      const noteProjections = notes.rows.map(({ payload }) => portableExportNoteProjection(payload!));
      const visibleNoteIds = new Set(noteProjections.map(({ id }) => id));
      const noteLocations = await client.query<{ note_id: string; payload: PortableNoteLocationProjection | null }>(
        `SELECT note.id AS note_id, projection.payload FROM stash_notes note
         LEFT JOIN LATERAL (SELECT payload FROM stash_portable_projection_outbox
           WHERE object_kind='NoteLocation' AND object_id=note.id ORDER BY revision DESC LIMIT 1) projection ON TRUE
         WHERE note.workspace_id=$1 AND note.id=ANY($2::uuid[]) ORDER BY note.id`,
      [workspaceId, [...visibleNoteIds]]);
      const noteLinks = await client.query<{ id: string; payload: PortableNoteLinkStateProjection | PortableNoteLinkProjection | null }>(
        `SELECT link.id, projection.payload FROM stash_note_links link
         JOIN stash_notes source ON source.id=link.source_note_id
         LEFT JOIN stash_notes target ON target.id=link.target_note_id
         LEFT JOIN LATERAL (SELECT payload FROM stash_portable_projection_outbox
           WHERE object_kind='NoteLink' AND object_id=link.id ORDER BY revision DESC LIMIT 1) projection ON TRUE
         WHERE link.workspace_id=$1 AND ($2::boolean OR
           (link.source_note_id=ANY($3::uuid[]) AND link.target_note_id IS NOT NULL AND link.target_note_id=ANY($3::uuid[]))) ORDER BY link.id`,
      [workspaceId, permission.member, [...visibleNoteIds]]);
      const tasks = await client.query<{ id: string; payload: PortableExportTaskProjection | null }>(
        `SELECT task.id, projection.payload FROM stash_tasks task
         LEFT JOIN LATERAL (SELECT payload FROM stash_portable_projection_outbox
           WHERE object_kind = 'Task' AND object_id = task.id ORDER BY revision DESC LIMIT 1) projection ON TRUE
         WHERE task.workspace_id = $1 AND ($2::boolean OR task.project_id = ANY($3::uuid[]) OR EXISTS(
           SELECT 1 FROM stash_task_projects association WHERE association.task_id=task.id AND association.project_id=ANY($3::uuid[])))
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
             AND note.id = ANY($3::uuid[])
             AND (strpos(note.content, attachment.relative_path) > 0
               OR strpos(note.content, replace(attachment.relative_path, '%', '%25')) > 0)))
         ORDER BY attachment.id`, [workspaceId, permission.member, [...visibleNoteIds]]);
      const activities = permission.member ? await client.query<{ payload: ActivityRecord }>(`SELECT projection.payload
        FROM stash_workspace_activity activity JOIN LATERAL (SELECT payload FROM stash_portable_projection_outbox
          WHERE object_kind='Activity' AND object_id=activity.id ORDER BY revision DESC LIMIT 1) projection ON TRUE
        WHERE activity.workspace_id=$1 ORDER BY activity.occurred_at,activity.id`, [workspaceId]) : { rows: [] };
      const histories = await client.query<any>(`SELECT history.*, actor.name AS actor_name,
        COALESCE(stub.source_account_id,history.actor_account_id::text) AS portable_actor_id FROM stash_note_history history
        JOIN stash_accounts actor ON actor.id=history.actor_account_id LEFT JOIN stash_identity_stubs stub ON stub.account_id=actor.id
        JOIN stash_notes note ON note.id=history.note_id
        WHERE history.workspace_id=$1 AND note.id=ANY($2::uuid[])
        ORDER BY history.note_id,history.revision`, [workspaceId, [...visibleNoteIds]]);
      const durableObjects = await client.query<{ object_kind: string; object_id: string; projection_schema: string; payload: unknown }>(
        `SELECT DISTINCT ON (projection.object_kind, projection.object_id)
           projection.object_kind,projection.object_id,projection.projection_schema,projection.payload
         FROM stash_portable_projection_outbox projection
         WHERE projection.object_kind IN ('Project','Workflow','WorkspaceWorkflow','Collection','ViewBlock','GuestProjectAccess','RepositoryConnection','Discussion','DiscussionWorkLink')
           AND (
             (projection.object_kind='Project' AND projection.payload->>'workspaceId'=$1::text
               AND ($2::boolean OR projection.object_id=ANY($3::uuid[])))
             OR (projection.object_kind='Workflow'
               AND (projection.payload->>'projectId')::uuid IN (SELECT id FROM stash_projects WHERE workspace_id=$1::uuid)
               AND ($2::boolean OR (projection.payload->>'projectId')::uuid=ANY($3::uuid[])))
             OR (projection.object_kind IN ('WorkspaceWorkflow','Collection','ViewBlock')
               AND projection.payload->>'workspaceId'=$1::text AND $2::boolean)
             OR (projection.object_kind='GuestProjectAccess' AND $2::boolean AND EXISTS (
               SELECT 1 FROM jsonb_array_elements(projection.payload->'projects') selected
               WHERE selected->>'workspaceId'=$1::text))
             OR (projection.object_kind IN ('Discussion','DiscussionWorkLink') AND projection.payload->>'workspaceId'=$1::text
               AND $2::boolean)
             OR (projection.object_kind='RepositoryConnection' AND $2::boolean AND EXISTS (
               SELECT 1 FROM jsonb_array_elements_text(projection.payload->'projectIds') project_id
               WHERE project_id::uuid IN (SELECT id FROM stash_projects WHERE workspace_id=$1::uuid)))
           )
         ORDER BY projection.object_kind,projection.object_id,projection.revision DESC`,
        [workspaceId, permission.member, guestProjectIds]);
      if (notes.rows.some(({ payload }) => !payload) || tasks.rows.some(({ payload }) => !payload)
        || boards.rows.some(({ payload }) => !payload)
        || noteLocations.rows.some(({ payload }) => !payload) || noteLinks.rows.some(({ payload }) => !payload)
        || attachments.rows.some(({ payload }) => !payload)) throw new Error("portable_projection_unavailable");
      const taskProjections = tasks.rows.map(({ payload }) => payload!);
      const visibleTaskIds = new Set(taskProjections.map(({ id }) => id));
      const visibleProjectIds = new Set(guestProjectIds);
      const contributedDurable = (await Promise.all(this.#portableProjectionContributors.map((contributor) =>
        contributor.readPortableObjects(client, { workspaceId, memberId, member: permission.member, visibleNoteIds })))).flat();
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
        noteLinks: noteLinks.rows.map(({ payload }) => payload!).map((payload) => "candidateNoteIds" in payload
          ? { ...payload, candidateNoteIds: payload.candidateNoteIds.filter((id) => visibleNoteIds.has(id)) } : payload),
        activities: activities.rows.map(({ payload }) => payload),
        noteHistory: histories.rows.map((row): NoteHistoryRevision => ({ noteId: row.note_id, workspaceId: row.workspace_id,
          revision: Number(row.revision), content: row.content, document: row.document, recordedAt: new Date(row.recorded_at).toISOString(),
          actor: { localAccountId: row.portable_actor_id, displayName: row.actor_name }, cause: this.#parseActivityCause(row.cause) })),
        durableObjects: [...durableObjects.rows.map((row) => ({ kind: row.object_kind, id: row.object_id,
          schema: row.projection_schema, payload: row.payload })), ...contributedDurable],
      } };
    });
  }

  async #withTransaction<Result>(operation: (client: PostgresQueryable) => Promise<Result>): Promise<Result> {
    return this.#kernel.transaction(operation);
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

  async #ensureNoteHistorySchema(client: PostgresQueryable): Promise<void> {
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

  async #ensureMemberDepartureSchema(client: PostgresQueryable): Promise<void> {
    await this.#ensureWorkspaceProjectSchema(client);
    await client.query(`CREATE TABLE IF NOT EXISTS stash_agent_grants (
      id UUID PRIMARY KEY,
      organization_id UUID NOT NULL REFERENCES stash_organizations(id),
      project_id UUID REFERENCES stash_projects(id),
      sponsoring_member_id UUID NOT NULL REFERENCES stash_accounts(id),
      capabilities JSONB NOT NULL CHECK (jsonb_typeof(capabilities) = 'array'),
      expires_at TIMESTAMPTZ NOT NULL,
      confirmation_policy JSONB NOT NULL CHECK (jsonb_typeof(confirmation_policy) = 'object'),
      revoked_at TIMESTAMPTZ,
      name TEXT NOT NULL DEFAULT 'Agent',
      token_lookup TEXT UNIQUE,
      token_hash TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    ALTER TABLE stash_agent_grants ADD COLUMN IF NOT EXISTS name TEXT NOT NULL DEFAULT 'Agent';
    ALTER TABLE stash_agent_grants ADD COLUMN IF NOT EXISTS token_lookup TEXT UNIQUE;
    ALTER TABLE stash_agent_grants ADD COLUMN IF NOT EXISTS token_hash TEXT;
    ALTER TABLE stash_agent_grants ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;
    CREATE TABLE IF NOT EXISTS stash_agent_proposals (
      id UUID PRIMARY KEY, grant_id UUID NOT NULL REFERENCES stash_agent_grants(id), sponsoring_member_id UUID NOT NULL REFERENCES stash_accounts(id),
      capability TEXT NOT NULL, input JSONB NOT NULL, status TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    );
    ALTER TABLE stash_agent_proposals DROP CONSTRAINT IF EXISTS stash_agent_proposals_status_check;
    ALTER TABLE stash_agent_proposals ADD COLUMN IF NOT EXISTS base_revision INTEGER;
    ALTER TABLE stash_agent_proposals ADD COLUMN IF NOT EXISTS operation_id UUID;
    ALTER TABLE stash_agent_proposals ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
    ALTER TABLE stash_agent_proposals ADD COLUMN IF NOT EXISTS reviewed_by_account_id UUID REFERENCES stash_accounts(id);
    ALTER TABLE stash_agent_proposals ADD COLUMN IF NOT EXISTS result JSONB;
    ALTER TABLE stash_agent_proposals ADD COLUMN IF NOT EXISTS conflict JSONB;
    UPDATE stash_agent_proposals SET status='applied' WHERE status='accepted';
    ALTER TABLE stash_agent_proposals ADD CONSTRAINT stash_agent_proposals_status_check
      CHECK (status IN ('pending','applying','applied','rejected','conflict'));
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

  async createAgentGrant(actorId: string, grant: StoredAgentGrant): Promise<"created" | "forbidden"> {
    return this.#kernel.withSession(async (client) => {
      await this.#ensureMemberDepartureSchema(client);
      const allowed = await client.query(`SELECT 1 FROM stash_organization_memberships membership
        WHERE membership.organization_id=$1 AND membership.account_id=$2
          AND ($3::uuid IS NULL OR EXISTS (SELECT 1 FROM stash_projects project WHERE project.id=$3 AND EXISTS (
            SELECT 1 FROM stash_workspaces workspace WHERE workspace.id=project.workspace_id AND workspace.organization_owner_id=$1)))`,
      [grant.organizationId, actorId, grant.projectId ?? null]);
      if (!allowed.rowCount) return "forbidden";
      await client.query(`INSERT INTO stash_agent_grants
        (id,organization_id,project_id,sponsoring_member_id,capabilities,expires_at,confirmation_policy,revoked_at,name,token_lookup,token_hash,created_at)
        VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,NULL,$8,$9,$10,$11)`, [grant.id, grant.organizationId, grant.projectId ?? null,
        actorId, JSON.stringify(grant.scopes), grant.expiresAt, JSON.stringify({ modes: grant.scopes }), grant.name, grant.tokenLookup, grant.tokenHash, grant.createdAt]);
      return "created";
    });
  }

  async listAgentGrants(actorId: string, organizationId: string): Promise<AgentGrant[] | undefined> {
    return this.#kernel.withSession(async (client) => {
      await this.#ensureMemberDepartureSchema(client);
      const membership = await client.query("SELECT 1 FROM stash_organization_memberships WHERE organization_id=$1 AND account_id=$2", [organizationId, actorId]);
      if (!membership.rowCount) return undefined;
      const result = await client.query<any>(`SELECT id,organization_id,project_id,sponsoring_member_id,name,capabilities,expires_at,created_at,revoked_at
        FROM stash_agent_grants WHERE organization_id=$1 AND sponsoring_member_id=$2 ORDER BY created_at DESC,id`, [organizationId, actorId]);
      return result.rows.map(agentGrantFromRow);
    });
  }

  async revokeAgentGrant(actorId: string, organizationId: string, grantId: string): Promise<"revoked" | "not_found" | "forbidden"> {
    return this.#kernel.withSession(async (client) => {
      await this.#ensureMemberDepartureSchema(client);
      const result = await client.query(`UPDATE stash_agent_grants SET revoked_at=CURRENT_TIMESTAMP
        WHERE id=$1 AND organization_id=$2 AND sponsoring_member_id=$3 AND revoked_at IS NULL RETURNING id`, [grantId, organizationId, actorId]);
      if (result.rowCount) return "revoked";
      const existing = await client.query<{ sponsoring_member_id: string }>("SELECT sponsoring_member_id FROM stash_agent_grants WHERE id=$1 AND organization_id=$2", [grantId, organizationId]);
      return !existing.rowCount ? "not_found" : existing.rows[0]!.sponsoring_member_id === actorId ? "revoked" : "forbidden";
    });
  }

  async findActiveAgentGrant(tokenLookup: string): Promise<StoredAgentGrant | undefined> {
    return this.#kernel.withSession(async (client) => {
      await this.#ensureMemberDepartureSchema(client);
      const result = await client.query<any>(`SELECT id,organization_id,project_id,sponsoring_member_id,name,capabilities,expires_at,created_at,revoked_at,token_lookup,token_hash
        FROM stash_agent_grants WHERE token_lookup=$1 AND revoked_at IS NULL AND expires_at>CURRENT_TIMESTAMP`, [tokenLookup]);
      const row = result.rows[0]; if (!row?.token_hash) return undefined;
      return { ...agentGrantFromRow(row), tokenLookup: row.token_lookup, tokenHash: row.token_hash };
    });
  }

  async agentGrantOptions(actorId: string): Promise<AgentGrantOption[]> {
    return this.#kernel.withSession(async (client) => {
      await this.#ensureMemberDepartureSchema(client);
      const result = await client.query<{ organization_id: string; organization_name: string; project_id: string | null; project_name: string | null }>(`
        SELECT organization.id organization_id,organization.name organization_name,project.id project_id,project.name project_name
        FROM stash_organization_memberships membership JOIN stash_organizations organization ON organization.id=membership.organization_id
        LEFT JOIN stash_workspaces workspace ON workspace.organization_owner_id=organization.id
        LEFT JOIN stash_projects project ON project.workspace_id=workspace.id WHERE membership.account_id=$1
        ORDER BY organization.name,organization.id,project.name,project.id`, [actorId]);
      return [...new Set(result.rows.map((row) => row.organization_id))].map((organizationId) => {
        const rows = result.rows.filter((row) => row.organization_id === organizationId); return { organizationId,
          organizationName: rows[0]!.organization_name, projects: rows.flatMap((row) => row.project_id ? [{ id: row.project_id, name: row.project_name! }] : []) };
      });
    });
  }

  async createAgentProposal(proposal: AgentProposal): Promise<void> {
    await this.#withTransaction(async (client) => {
      await this.#ensureMemberDepartureSchema(client); await this.#ensureNotificationSchema(client);
      const input = proposal.input as { workspaceId?: unknown };
      const scope = await client.query<{ workspace_id: string; actor_name: string }>(`SELECT workspace.id workspace_id,account.name actor_name
        FROM stash_agent_grants grant JOIN stash_accounts account ON account.id=grant.sponsoring_member_id
        JOIN stash_workspaces workspace ON workspace.organization_owner_id=grant.organization_id
        LEFT JOIN stash_projects project ON project.workspace_id=workspace.id AND project.id=$4
        WHERE grant.id=$1 AND grant.sponsoring_member_id=$2 AND grant.organization_id=$3
          AND EXISTS (SELECT 1 FROM stash_organization_memberships membership WHERE membership.organization_id=grant.organization_id AND membership.account_id=$2)
          AND (($4::uuid IS NOT NULL AND project.id=$4) OR ($4::uuid IS NULL AND workspace.id=$5)) LIMIT 1`,
      [proposal.grantId, proposal.sponsoringMemberId, proposal.organizationId, proposal.projectId ?? null,
        typeof input?.workspaceId === "string" ? input.workspaceId : null]);
      const authorized = scope.rows[0]; if (!authorized) throw new Error("proposal_notification_scope_forbidden");
      const activity: ActivityRecord = { schema: "stash.activity.v1", id: proposal.id, workspaceId: authorized.workspace_id,
        object: { kind: "Proposal", id: proposal.id }, action: "proposal_review_requested",
        actor: { localAccountId: proposal.sponsoringMemberId, displayName: authorized.actor_name },
        cause: { kind: "agent", agentGrantId: proposal.grantId, sponsoringMemberId: proposal.sponsoringMemberId, agentName: proposal.agentName },
        occurredAt: proposal.createdAt, before: {}, after: { proposalId: proposal.id, capability: proposal.capability, status: proposal.status } };
      await client.query(`INSERT INTO stash_agent_proposals (id,grant_id,sponsoring_member_id,capability,input,status,created_at,base_revision)
        VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8)`, [proposal.id, proposal.grantId, proposal.sponsoringMemberId, proposal.capability,
        JSON.stringify(proposal.input), proposal.status, proposal.createdAt, proposal.baseRevision ?? null]);
      await client.query(`INSERT INTO stash_workspace_activity
        (id,workspace_id,object_kind,object_id,action,actor_account_id,cause,occurred_at,before_state,after_state)
        VALUES ($1,$2,'Proposal',$1,$3,$4,$5::jsonb,$6,$7::jsonb,$8::jsonb)`, [activity.id, activity.workspaceId, activity.action,
        activity.actor.localAccountId, JSON.stringify(activity.cause), activity.occurredAt, JSON.stringify(activity.before), JSON.stringify(activity.after)]);
      await this.#recordPortableProjection(client, "Activity", activity.id, activity.schema, activity);
      const requested = requestedReviewNotificationInput(activity, proposal.sponsoringMemberId, proposal.projectId, proposal.agentName, proposal.capability);
      let preferences: NotificationPreferences = { activity: "followed", digest: "off" };
      if (proposal.projectId) { const settings = await client.query<any>(`SELECT preference.* FROM stash_projects project
        LEFT JOIN stash_notification_preferences preference ON preference.project_id=project.id AND preference.member_id=$1 WHERE project.id=$2`,
      [proposal.sponsoringMemberId, proposal.projectId]); const row = settings.rows[0]; if (row?.member_id) preferences = { activity: row.activity, digest: row.digest,
        ...(row.quiet_start ? { quietHours: { start: row.quiet_start, end: row.quiet_end, timeZone: row.quiet_time_zone } } : {}) }; }
      await client.query(`INSERT INTO stash_notifications
        (id,member_id,workspace_id,project_id,trigger,summary,activity,created_at,delivery)
        VALUES ($1,$2,$3,$4,'requested_review',$5,$6::jsonb,$7,$8)
        ON CONFLICT (member_id,activity_id,trigger) DO NOTHING`, [randomUUID(), requested.memberId, activity.workspaceId,
        proposal.projectId ?? null, requested.summary, JSON.stringify(activity), activity.occurredAt,
        notificationDeliveryMode(new Date(activity.occurredAt), preferences)]);
    });
  }

  async listAgentProposals(actorId: string, organizationId: string): Promise<AgentProposal[] | undefined> {
    return this.#kernel.withSession(async (client) => {
      await this.#ensureMemberDepartureSchema(client);
      const membership = await client.query("SELECT 1 FROM stash_organization_memberships WHERE organization_id=$1 AND account_id=$2", [organizationId, actorId]);
      if (!membership.rowCount) return undefined;
      const result = await client.query<any>(`SELECT proposal.*,grant.organization_id,grant.project_id,grant.name agent_name
        FROM stash_agent_proposals proposal JOIN stash_agent_grants grant ON grant.id=proposal.grant_id
        WHERE grant.organization_id=$1 AND proposal.sponsoring_member_id=$2 ORDER BY proposal.created_at DESC,proposal.id`, [organizationId, actorId]);
      return result.rows.map(agentProposalFromRow);
    });
  }

  async findAgentProposal(actorId: string, organizationId: string, proposalId: string): Promise<AgentProposal | "forbidden" | undefined> {
    return this.#kernel.withSession(async (client) => {
      await this.#ensureMemberDepartureSchema(client);
      const membership = await client.query("SELECT 1 FROM stash_organization_memberships WHERE organization_id=$1 AND account_id=$2", [organizationId, actorId]);
      if (!membership.rowCount) return "forbidden";
      const result = await client.query<any>(`SELECT proposal.*,grant.organization_id,grant.project_id,grant.name agent_name FROM stash_agent_proposals proposal
        JOIN stash_agent_grants grant ON grant.id=proposal.grant_id WHERE proposal.id=$1 AND grant.organization_id=$2`, [proposalId, organizationId]);
      if (!result.rowCount) return undefined; if (result.rows[0].sponsoring_member_id !== actorId) return "forbidden"; return agentProposalFromRow(result.rows[0]);
    });
  }

  async claimAgentProposal(actorId: string, organizationId: string, proposalId: string, operationId: string) {
    return this.#withTransaction(async (client) => { await this.#ensureMemberDepartureSchema(client);
      const membership = await client.query("SELECT 1 FROM stash_organization_memberships WHERE organization_id=$1 AND account_id=$2", [organizationId, actorId]);
      if (!membership.rowCount) return { status: "forbidden" as const };
      const result = await client.query<any>(`SELECT proposal.*,grant.organization_id,grant.project_id,grant.name agent_name FROM stash_agent_proposals proposal
        JOIN stash_agent_grants grant ON grant.id=proposal.grant_id WHERE proposal.id=$1 AND grant.organization_id=$2 FOR UPDATE OF proposal`, [proposalId, organizationId]);
      if (!result.rowCount) return { status: "not_found" as const }; const row = result.rows[0];
      if (row.sponsoring_member_id !== actorId) return { status: "forbidden" as const };
      if (row.status === "applying") return { status: row.operation_id === operationId ? "in_progress" as const : "in_progress" as const, proposal: agentProposalFromRow(row) };
      if (!["pending", "conflict"].includes(row.status)) return { status: row.operation_id === operationId ? "duplicate" as const : "already_reviewed" as const, proposal: agentProposalFromRow(row) };
      const claimed = await client.query<any>(`UPDATE stash_agent_proposals SET status='applying',operation_id=$2 WHERE id=$1 RETURNING *`, [proposalId, operationId]);
      return { status: "claimed" as const, proposal: agentProposalFromRow({ ...claimed.rows[0], organization_id: row.organization_id, project_id: row.project_id, agent_name: row.agent_name }) };
    });
  }

  async finishAgentProposal(actorId: string, proposalId: string, operationId: string, update: any): Promise<AgentProposal> {
    return this.#withTransaction(async (client) => {
      const result = await client.query<any>(`UPDATE stash_agent_proposals proposal SET status=$4,reviewed_at=$5,reviewed_by_account_id=$1,
        result=$6::jsonb,conflict=$7::jsonb WHERE proposal.id=$2 AND proposal.sponsoring_member_id=$1 AND proposal.operation_id=$3
        RETURNING proposal.*,(SELECT organization_id FROM stash_agent_grants WHERE id=proposal.grant_id),(SELECT project_id FROM stash_agent_grants WHERE id=proposal.grant_id),
        (SELECT name FROM stash_agent_grants WHERE id=proposal.grant_id) agent_name`, [actorId, proposalId, operationId, update.status, update.reviewedAt,
        JSON.stringify(update.result ?? null), JSON.stringify(update.conflict ?? null)]);
      if (!result.rows[0]) throw new Error("proposal_claim_lost");
      await client.query(`UPDATE stash_notifications SET read_at=CASE WHEN $3='conflict' THEN NULL ELSE COALESCE(read_at,$4::timestamptz) END
        WHERE member_id=$1 AND activity_id=$2 AND trigger='requested_review'`, [actorId, proposalId, update.status, update.reviewedAt]);
      return agentProposalFromRow(result.rows[0]);
    });
  }

  async releaseAgentProposal(actorId: string, proposalId: string, operationId: string): Promise<void> {
    await this.#kernel.query("UPDATE stash_agent_proposals SET status=CASE WHEN conflict IS NULL THEN 'pending' ELSE 'conflict' END,operation_id=NULL WHERE id=$1 AND sponsoring_member_id=$2 AND operation_id=$3 AND status='applying'", [proposalId, actorId, operationId]);
  }

  async agentGrantTargetAllowed(grant: AgentGrant, target: { workspaceId?: string; projectId?: string }): Promise<boolean> {
    if (!target.workspaceId && !target.projectId) return false;
    const result = await this.#kernel.query(`SELECT 1 FROM stash_workspaces workspace LEFT JOIN stash_projects project ON project.workspace_id=workspace.id
      WHERE workspace.organization_owner_id=$1 AND ($2::uuid IS NULL OR workspace.id=$2) AND ($3::uuid IS NULL OR project.id=$3)
        AND ($4::uuid IS NULL OR project.id=$4) LIMIT 1`, [grant.organizationId, target.workspaceId ?? null, target.projectId ?? null, grant.projectId ?? null]);
    return Boolean(result.rowCount);
  }

  async #markFormerAssignments(client: PostgresQueryable, organizationId: string, accountId: string, actorId: string): Promise<string[]> {
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

  async #revokeDepartedMemberAuthority(client: PostgresQueryable, organizationId: string, accountId: string) {
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

  async #degradePersonalConnections(client: PostgresQueryable, organizationId: string, accountId: string): Promise<string[]> {
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

  async #ensureRepositoryConnectionStateColumns(client: PostgresQueryable): Promise<void> {
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

  async #recordMemberDepartureAudit(client: PostgresQueryable, input: { organizationId: string; actorId: string; accountId: string;
    role: BuiltInOrganizationRole; affectedTaskIds: string[]; degradedRepositoryConnectionIds: string[];
    revokedSessions: number; revokedCredentials: number; revokedAgentGrants: number }): Promise<void> {
    const { organizationId, actorId, accountId, role, ...after } = input;
    await client.query(`INSERT INTO stash_operator_audit
      (id, action, actor_account_id, organization_id, target_account_id, occurred_at, before_state, after_state)
      VALUES ($1,'organization_member_departed',$2,$3,$4,CURRENT_TIMESTAMP,$5::jsonb,$6::jsonb)`,
    [randomUUID(), actorId, organizationId, accountId, JSON.stringify({ role, active: true }), JSON.stringify({ active: false, ...after })]);
  }

  async #recordAgentExecutionAudit(client: PostgresQueryable, memberId: string, workspaceId: string, action: string,
    objectId: string, cause: Extract<ActivityCause, { kind: "agent" }>): Promise<void> {
    await this.#ensureMemberDepartureSchema(client);
    const organization = await client.query<{ organization_id: string }>(
      "SELECT organization_owner_id organization_id FROM stash_workspaces WHERE id=$1 AND owner_type='organization'", [workspaceId]);
    if (!organization.rows[0]) return;
    await client.query(`INSERT INTO stash_operator_audit
      (id,action,actor_account_id,organization_id,target_account_id,occurred_at,before_state,after_state)
      VALUES ($1,$2,$3,$4,$3,CURRENT_TIMESTAMP,$5::jsonb,$6::jsonb)`, [randomUUID(), action, memberId,
      organization.rows[0].organization_id, JSON.stringify({ authority: "agent_grant", agentGrantId: cause.agentGrantId,
        sponsoringMemberId: cause.sponsoringMemberId, agentName: cause.agentName ?? null }),
      JSON.stringify({ objectId, cause: "mcp_direct", attributed: true })]);
  }

  async #ensureWorkspaceImportSchema(client: PostgresQueryable): Promise<void> {
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

  async #backfillLegacyNoteHistory(client: PostgresQueryable): Promise<void> {
    await client.query(`INSERT INTO stash_note_history
      (note_id,workspace_id,revision,content,document,actor_account_id,cause,recorded_at)
      SELECT note.id,note.workspace_id,note.revision,note.content,note.document,note.created_by_account_id,
        '{"kind":"migration","source":"existing_note"}',note.created_at FROM stash_notes note
      WHERE NOT EXISTS (SELECT 1 FROM stash_note_history history WHERE history.note_id=note.id)
      ON CONFLICT (note_id,revision) DO NOTHING`);
  }

  async #recordNoteRevisionAndActivity(client: PostgresQueryable, memberId: string, before: NoteRecord | undefined,
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

  async #recordTaskActivity(client: PostgresQueryable, memberId: string, workspaceId: string, taskId: string,
    action: string, before: TaskPlanningReadModel, after: TaskPlanningReadModel, cause: ActivityCause = { kind: "member" }): Promise<ActivityRecord> {
    const actor = await client.query<{ name: string }>("SELECT name FROM stash_accounts WHERE id=$1", [memberId]);
    if (!actor.rows[0]) throw new Error("member_identity_unavailable");
    const activity: ActivityRecord = { schema: "stash.activity.v1", id: randomUUID(), workspaceId,
      object: { kind: "Task", id: taskId }, action, actor: { localAccountId: memberId, displayName: actor.rows[0].name },
      cause, occurredAt: new Date().toISOString(), before: { ...before }, after: { ...after } };
    await this.#persistTaskActivity(client, activity);
    return activity;
  }

  async #persistTaskActivity(client: PostgresQueryable, activity: ActivityRecord): Promise<void> {
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

  async #recordProjectActivityNotifications(client: PostgresQueryable, activity: ActivityRecord): Promise<void> {
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

  async #recordAssignmentNotifications(client: PostgresQueryable, projectId: string, activity: ActivityRecord,
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

  async #recordDiscussionMentionNotifications(client: PostgresQueryable, memberId: string, discussion: DiscussionRecord,
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

  async #recordDomainActivity(client: PostgresQueryable, memberId: string, workspaceId: string,
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

  async #authorizeNote(client: PostgresQueryable, memberId: string, noteId: string): Promise<"edit" | "read" | "none"> {
    const result = await client.query<{ can_edit: boolean; can_read: boolean }>(`SELECT
      ${workspaceMemberSql("workspace", "$2")} AS can_edit,
      ${effectiveNoteReadSql("note", "workspace", "$2")} AS can_read
      FROM stash_notes note JOIN stash_workspaces workspace ON workspace.id=note.workspace_id WHERE note.id=$1`, [noteId, memberId]);
    return result.rows[0]?.can_edit ? "edit" : result.rows[0]?.can_read ? "read" : "none";
  }

  async #seedNoteCollaboration(client: PostgresQueryable, noteId: string): Promise<any> {
    const note = (await client.query<any>("SELECT document,created_by_account_id,created_at FROM stash_notes WHERE id=$1", [noteId])).rows[0];
    if (!note) throw new Error("note_not_found");
    const document = collaborativeDocumentFromRichText(note.document);
    const update = Y.encodeStateAsUpdate(document); document.destroy();
    return (await client.query<any>(`INSERT INTO stash_note_collaboration(note_id,sequence,update,updated_by_account_id,updated_at)
      VALUES($1,0,$2,$3,$4) ON CONFLICT(note_id) DO UPDATE SET note_id=EXCLUDED.note_id
      RETURNING note_id,sequence,update,updated_at,updated_by_account_id`,
    [noteId, Buffer.from(update), note.created_by_account_id, note.created_at])).rows[0];
  }

  async #ensureCollaborationSchema(client: PostgresQueryable): Promise<void> {
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

function portableExportNoteProjection(payload: PortableNoteProjection | PortableNoteStateProjection): PortableNoteProjection {
  if (payload.schema === "stash.note.v1") return payload;
  const { id, workspaceId, content, tags, createdAt, projectId, reminder } = payload.note;
  return { schema: "stash.note.v1", id, workspaceId, content, tags, createdAt, createdBy: payload.createdBy,
    ...(projectId ? { projectId } : {}), ...(reminder ? { reminder } : {}) };
}

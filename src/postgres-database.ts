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
import { initialWorkflowStatus, type ProjectWorkflowRepository, type WorkflowStatus } from "./project-workflows.js";
import type { PortableWorkspaceExportRepository, PortableWorkspaceExportSnapshot } from "./portable-workspace-export.js";
import type { ImportTransformation, PortableWorkspaceImportBundle, PortableWorkspaceImportReport, PortableWorkspaceImportRepository } from "./portable-workspace-import.js";
import type { Board, BoardRepository } from "./boards.js";
import type { NoteLinkRecord, NoteLinkRepository, NoteLocationRecord, PortableNoteLinkStateProjection, PortableNoteLocationProjection } from "./note-links.js";
import type { ActivityCause, ActivityRecord, ActivityRepository, NoteHistoryRevision } from "./activity.js";
import type { DevelopmentArtifact, GitHubArtifactRepository } from "./github-artifacts.js";
import type { GitHubSignal } from "./github-signals.js";
import { assignmentNotificationInputs, directMentionMemberIds, directMentionNotificationInputs, notificationDeliveryMode, requestedReviewNotificationInput, type NotificationDelivery, type NotificationPreferences, type NotificationRepository } from "./notifications.js";
import type { AutomationRepository } from "./automations.js";
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
export { workflowTemporaryRenameSql } from "./work-planning/postgres-work-planning-repositories.js";
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
const portableProjectionObjectKinds = ["Workspace", "Project", "Workflow", "WorkspaceWorkflow", "Collection", "ViewBlock", "Board", "Note", "NoteLocation", "NoteLink", "Task", "GuestProjectAccess", "RepositoryConnection", "Attachment", "Discussion", "DiscussionWorkLink", "Activity",
  ...PostgresVisualizationBlockRepository.portableObjectKinds] as const;
const portableProjectionObjectKindSql = portableProjectionObjectKinds.map((kind) => `'${kind}'`).join(", ");
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
export { collaborativeDocumentFromRichText, richTextFromCollaborativeDocument, validatedRichTextFromCollaborativeDocument } from "./knowledge-authoring/collaborative-document.js";

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
      recordProjection: (client, kind, id, schema, payload) => this.#recordPortableProjection(client, kind, id, schema, payload),
      authorizeProject: (client, memberId, workspaceId) => this.#projectPermissionRepository.authorize(client, memberId, workspaceId),
      ensureDefaultWorkflow: (client, projectId) => this.#workPlanningAdapter.ensureDefaultWorkflow(client, projectId),
      findPortableMemberIdentity: (memberId) => this.#knowledgeAuthoringAdapter.findPortableMemberIdentity(memberId),
      roles: {
        assignBuiltInRole: (...args) => this.#organizationRoleRepository.assignBuiltInRole(...args),
        listCustomRoles: (...args) => this.#organizationRoleRepository.listCustomRoles(...args),
        createCustomRole: (...args) => this.#organizationRoleRepository.createCustomRole(...args),
        updateCustomRole: (...args) => this.#organizationRoleRepository.updateCustomRole(...args),
        assignCustomRole: (...args) => this.#organizationRoleRepository.assignCustomRole(...args),
        revokeCustomRole: (...args) => this.#organizationRoleRepository.revokeCustomRole(...args),
      },
      prepareNotifications: (client) => this.#ensureNotificationSchema(client),
      recordActivityProjection: (client, activity) => this.#recordPortableProjection(client, "Activity", activity.id, activity.schema, activity),
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
      prepareInvitations: (client) => this.#identityAccessAdapter.prepareInvitations(client),
      prepareAttachments: (client) => this.#ensureAttachmentSchema(client),
      backfillLegacyNoteHistory: (client) => this.#backfillLegacyNoteHistory(client),
      parseActivityCause: (value) => this.#parseActivityCause(value),
      prepareBootstrap: (client) => this.#ensureBootstrapSchema(client),
      prepareImports: (client) => this.#ensureWorkspaceImportSchema(client),
      prepareInstanceSetup: (client) => this.#instanceSetupRepository.prepare(client),
      prepareBoards: (client) => this.#workPlanningAdapter.prepareBoards(client),
      encryptSecret: (value) => this.#authenticationSecrets.encrypt(value),
      applyImportedLocations: (client, locations) => this.#noteTreeRepository.applyImportedLocations(client, locations),
      applyImportedRelationships: (client, links) => this.#noteTreeRepository.applyImportedRelationships(client, links),
      importContributedPortableObjects: async (client, objects, workspaceId) => {
        for (const contributor of this.#portableProjectionContributors) await contributor.importPortableObjects(client, objects, workspaceId);
      },
      prepareContributedPortableObjects: async (client) => {
        for (const contributor of this.#portableProjectionContributors) await contributor.preparePortableObjects(client);
      },
      readContributedPortableObjects: async (client, context) =>
        (await Promise.all(this.#portableProjectionContributors.map((contributor) => contributor.readPortableObjects(client, context)))).flat(),
      prepareHistory: (client) => this.#ensureNoteHistorySchema(client),
      prepareWorkspaceProjects: (client) => this.#ensureWorkspaceProjectSchema(client),
      recordProjection: (client, kind, id, schema, projection) => this.#recordPortableProjection(client, kind, id, schema, projection),
      authorizeNote: (client, memberId, noteId) => this.#authorizeNote(client, memberId, noteId),
      recordNoteRevisionAndActivity: (client, memberId, before, after, action, cause) =>
        this.#recordNoteRevisionAndActivity(client, memberId, before, after, action, cause),
      recordInitialNoteLocation: (client, noteId, workspaceId) => this.#recordInitialNoteLocation(client, noteId, workspaceId),
      recordDiscussionMentionNotifications: (client, memberId, discussion, message) =>
        this.#recordDiscussionMentionNotifications(client, memberId, discussion, message),
      recordProjectActivityNotifications: (client, activity) => this.#recordProjectActivityNotifications(client, activity),
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
      prepare: async (client) => {
        await this.#ensureNoteSchema(client);
        await this.#canonicalTaskRepository.prepare(client);
        await this.#identityAccessAdapter.prepareInvitations(client);
      },
      recordProjection: (client, task) => this.#recordPortableProjection(client, "Task", task.id, task.schema, task),
      recordWorkflowProjection: (client, workflow) => this.#recordPortableProjection(client, "Workflow", workflow.projectId, workflow.schema, workflow),
      recordBoardProjection: (client, board) => this.#recordPortableProjection(client, "Board", board.id, board.schema, board),
      recordBoardTaskActivity: (client, memberId, workspaceId, taskId, before, after) =>
        this.#recordTaskActivity(client, memberId, workspaceId, taskId, "task_status_changed", before, after),
      recordActivity: (client, memberId, workspaceId, taskId, before, after, cause) =>
        this.#recordTaskActivity(client, memberId, workspaceId, taskId, "task_planning_updated", before, after, cause),
      recordAgentAudit: (client, memberId, workspaceId, taskId, cause) =>
        this.#recordAgentExecutionAudit(client, memberId, workspaceId, "agent_task_updated", taskId, cause),
      recordAssignmentNotifications: (client, projectId, activity, before, after) =>
        this.#recordAssignmentNotifications(client, projectId, activity, before, after),
      prepareAutomationDependencies: (client) => this.#ensureGitHubSignalSchema(client),
      recordAutomationActivity: (client, memberId, workspaceId, taskId, action, before, after, cause) =>
        this.#recordTaskActivity(client, memberId, workspaceId, taskId, action, before, after, cause),
      persistAutomationFailureActivity: (client, activity) => this.#persistTaskActivity(client, activity),
      recordIdentifiedNoteBlock: async (client, memberId, beforeRow, afterRow, projection) => {
        await this.#recordPortableProjection(client, "Note", projection.id, projection.schema, projection);
        await this.#recordNoteRevisionAndActivity(client, memberId, this.#noteFromRow(beforeRow), this.#noteFromRow(afterRow),
          "note_block_identified", { kind: "member" });
      },
      recordTaskSourceActivity: (client, memberId, workspaceId, task) =>
        this.#recordDomainActivity(client, memberId, workspaceId, "Task", task.id, "task_created_from_block", {}, task),
      ensureCanonicalWorkflow: (client, workspaceId) => this.#canonicalTaskRepository.ensureWorkflow(client, workspaceId),
      recordTaskActivity: (client, memberId, workspaceId, taskId, action, before, after, cause) =>
        this.#recordTaskActivity(client, memberId, workspaceId, taskId, action, before, after, cause),
      recordStructuredAgentAudit: (client, memberId, workspaceId, taskId, cause) =>
        this.#recordAgentExecutionAudit(client, memberId, workspaceId, "agent_proposal_task_applied", taskId, cause),
      recordActivityProjection: (client, activity) =>
        this.#recordPortableProjection(client, "Activity", activity.id, activity.schema, activity),
      recordProjectActivityNotifications: (client, activity) => this.#recordProjectActivityNotifications(client, activity),
    });
    this.#developmentIntegrationAdapter = new PostgresDevelopmentIntegrationRepositories(this.#kernel, {
      organizationRole: (organizationId, accountId) => this.#identityAccessAdapter.organizationRole(organizationId, accountId),
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
      removeOrganizationMember: this.removeOrganizationMember.bind(this),

      listPendingImportedIdentities: this.listPendingImportedIdentities.bind(this),
      mapImportedIdentityAsMember: this.mapImportedIdentityAsMember.bind(this),
    });
  }
  knowledgeAuthoringRepositories(): KnowledgeAuthoringPostgresRepositories {
    return this.#knowledgeAuthoringAdapter;
  }

  workPlanningRepositories(): WorkPlanningPostgresRepositories {
    return this.#workPlanningAdapter;
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
      await this.#ensureAuthSchema(client); await this.#identityAccessAdapter.prepareOidc(client); await this.#identityAccessAdapter.prepareRecovery(client);
      await this.#ensureRepositoryConnectionSchema(client); await this.#ensureGitHubSignalSchema(client); await this.#ensureNotificationSchema(client);
      await this.#ensureMemberLocalizationSchema(client);
      await this.#ensureNoteSchema(client); await this.#noteTreeRepository.prepare(client);
      await this.#workPlanningAdapter.prepareBoards(client); await this.#ensureAttachmentSchema(client);
      await this.#knowledgeAuthoringAdapter.prepareDiscussions(client); await this.#identityAccessAdapter.prepareInvitations(client); await this.#ensurePortableProjectionSchema(client);
      await this.#ensureNoteHistorySchema(client); await this.#identityAccessAdapter.prepareAgentAuthority(client); await this.#ensureWorkspaceImportSchema(client);
      await this.#knowledgeAuthoringAdapter.prepareCollaboration(client);
      await this.#instanceSetupRepository.prepare(client);
      await this.#canonicalTaskRepository.prepare(client);
      await this.#workPlanningAdapter.prepareAutomations(client);
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

  /** Compatibility surface for capability callers not yet migrated off the universal store. */
  async findPortableMemberIdentity(memberId: string): Promise<PortableIdentity | undefined> {
    return this.#knowledgeAuthoringAdapter.findPortableMemberIdentity(memberId);
  }

  async close(): Promise<void> {
    await this.#kernel.close();
  }

  async resolveClientSessionPrincipal(accountId: string) {
    return this.#kernel.withSession(async (client) => {
      await this.#identityAccessAdapter.prepareInvitations(client);
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

  async #linkDevelopmentArtifact(memberId: string, projectId: string, taskKey: string, artifact: DevelopmentArtifact) {
    return this.#withTransaction(async (client) => {
      await this.#ensureNoteSchema(client); await this.#identityAccessAdapter.prepareInvitations(client);
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
      await this.#identityAccessAdapter.prepareAgentAuthority(client);
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
    return this.#knowledgeAuthoringAdapter.mapImportedIdentity(input);
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
    await this.#identityAccessAdapter.prepareAgentAuthority(client);
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
    await this.#workPlanningAdapter.prepareBoards(client);
    await this.#knowledgeAuthoringAdapter.prepareDiscussions(client);
    await this.#identityAccessAdapter.prepareInvitations(client);
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
    await this.#knowledgeAuthoringAdapter.prepareDiscussions(client);
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

  async #authorizeNote(client: PostgresQueryable, memberId: string, noteId: string): Promise<"edit" | "read" | "none"> {
    const result = await client.query<{ can_edit: boolean; can_read: boolean }>(`SELECT
      ${workspaceMemberSql("workspace", "$2")} AS can_edit,
      ${effectiveNoteReadSql("note", "workspace", "$2")} AS can_read
      FROM stash_notes note JOIN stash_workspaces workspace ON workspace.id=note.workspace_id WHERE note.id=$1`, [noteId, memberId]);
    return result.rows[0]?.can_edit ? "edit" : result.rows[0]?.can_read ? "read" : "none";
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

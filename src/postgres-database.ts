import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { ClientSessionPrincipal, DatabaseProbe } from "./instance.js";
import { noteOperationDigest, type NoteRecord, type NoteRepository, type NoteTriageResult, type PortableNoteProjection,
  type PortableNoteStateProjection } from "./notes.js";
import { isRichTextDocument, markdownToRichText, paragraphDocument, richTextToMarkdown } from "./rich-text.js";
import type { BootstrapRecord, OwnerBootstrapRepository } from "./owner-bootstrap.js";
import type { PasswordAuthRepository } from "./password-auth.js";
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
import type { StructuredTaskEditRepository, TaskFromBlockRepository, TaskMoveRepository, TaskPlanningRepository } from "./tasks.js";
import type { AttachmentRecord, AttachmentRepository, PortableAttachmentProjection } from "./attachments.js";
import type { MobileCaptureRepository } from "./mobile-captures.js";
import type { CreateDiscussionWorkDraft, DiscussionDraft, DiscussionMessage, DiscussionRecord, DiscussionRepository, DiscussionTarget, DiscussionWorkActivity, DiscussionWorkOutcome, PortableDiscussionProjection, PortableDiscussionTarget, PortableDiscussionWorkLinkProjection } from "./discussions.js";
import { initialWorkflowStatus, type ProjectWorkflowRepository, type WorkflowStatus } from "./project-workflows.js";
import type { PortableWorkspaceExportRepository, PortableWorkspaceExportSnapshot } from "./portable-workspace-export.js";
import type { ImportTransformation, PortableWorkspaceImportBundle, PortableWorkspaceImportReport, PortableWorkspaceImportRepository } from "./portable-workspace-import.js";
import type { Board, BoardRepository } from "./boards.js";
import type { NoteLinkRecord, NoteLinkRepository, NoteLocationRecord, PortableNoteLinkStateProjection, PortableNoteLocationProjection } from "./note-links.js";
import type { ActivityCause, ActivityRepository } from "./activity.js";
import type { NotificationRepository } from "./notifications.js";
import type { AutomationRepository } from "./automations.js";
import * as Y from "yjs";
import { prosemirrorJSONToYDoc, yDocToProsemirrorJSON } from "y-prosemirror";
import { Schema } from "prosemirror-model";
import { InvalidCollaborationUpdate, type CollaborationSnapshot, type NoteCollaborationRepository } from "./note-collaboration.js";
import type { WorkspaceSearchFacet, WorkspaceSearchKind, WorkspaceSearchQuery, WorkspaceSearchRepository, WorkspaceSearchResult } from "./workspace-search.js";
import { proseMirrorToRichText, richTextToProseMirror } from "@stash/rich-text";
import type { AgentGrantRepository } from "./agent-grants.js";
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
import { PostgresInstanceMigrationStore } from "./instance-operations/storage/postgres-instance-migration-store.js";

export type { IdlePostgresClientFailure } from "./instance-operations/storage/postgres-kernel.js";

export interface PostgresDatabaseOptions extends PostgresKernelOptions {}

export type IdentityAccessPostgresRepositories = PasswordAuthRepository & AccountRegistrationRepository
  & OidcAuthRepository & AccountRecoveryRepository & OrganizationRoleRepository & InvitationRepository
  & MemberLocalizationRepository & WorkspaceProjectRepository & AgentGrantRepository & ImportedIdentityAdministration
  & { resolveClientSessionPrincipal(accountId:string):Promise<ClientSessionPrincipal|undefined> };
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
const repositoryConnectionSelect = `SELECT connection.id, connection.organization_id, connection.provider, connection.installation_id,
  connection.repository_id, connection.repository_url, connection.created_by_account_id, connection.created_by_attribution,
  connection.ownership, connection.state,
  ARRAY(SELECT project_id FROM stash_repository_connection_projects link WHERE link.connection_id = connection.id ORDER BY project_id) AS project_ids
  FROM stash_repository_connections connection`;
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
  readonly #migrationStore: PostgresInstanceMigrationStore;

  constructor(connectionString: string, authenticationSecrets: AuthenticationSecretCodec, options: PostgresDatabaseOptions = {}) {
    this.#kernel = new PostgresKernel(connectionString, options);
    this.#authenticationSecrets = authenticationSecrets;
    this.#noteTreeRepository = new PostgresNoteTreeRepository(this.#kernel, (client) => this.#migrationStore.ensureNoteSchema(client), {
      beforeStateChange: (client, noteIds, state) => this.#tutorialContributionRepository.beforeStateChange(client, noteIds, state),
    });
    this.#tutorialContributionRepository = new PostgresTutorialContributionRepository(this.#kernel,
      (client) => this.#noteTreeRepository.prepare(client));
    this.#instanceSetupRepository = new PostgresInstanceSetupRepository(this.#kernel, authenticationSecrets, async (client) => {
      await this.#identityAccessAdapter.prepareRegistration(client);
      await this.#noteTreeRepository.prepare(client);
    }, this.#tutorialContributionRepository);
    this.#identityAccessAdapter = new PostgresIdentityAccessRepositories(this.#kernel, authenticationSecrets, {
      prepareProjections: (client) => this.#migrationStore.ensurePortableProjectionSchema(client),
      recordWorkspaceProjection: (client, record) => this.#migrationStore.recordPortableProjection(client, "Workspace", record.workspace.id, "stash.workspace.v1", {
        schema: "stash.workspace.v1", id: record.workspace.id, name: record.workspace.name,
        owner: { type: "personal", identity: { localAccountId: record.account.id, displayName: record.account.name } },
        createdBy: { localAccountId: record.account.id, displayName: record.account.name },
      }),
      recordProjection: (client, kind, id, schema, payload) => this.#migrationStore.recordPortableProjection(client, kind, id, schema, payload),
      authorizeProject: (client, memberId, workspaceId) => this.#projectPermissionRepository.authorize(client, memberId, workspaceId),
      ensureDefaultWorkflow: (client, projectId) => this.#workPlanningAdapter.ensureDefaultWorkflow(client, projectId),
      findPortableMemberIdentity: (memberId) => this.#knowledgeAuthoringAdapter.findPortableMemberIdentity(memberId),
      roles: {
        assignBuiltInRole: (...args) => this.#organizationRoleRepository.assignBuiltInRole(...args),
        removeOrganizationMember: (...args) => this.#organizationRoleRepository.removeOrganizationMember(...args),
        listCustomRoles: (...args) => this.#organizationRoleRepository.listCustomRoles(...args),
        createCustomRole: (...args) => this.#organizationRoleRepository.createCustomRole(...args),
        updateCustomRole: (...args) => this.#organizationRoleRepository.updateCustomRole(...args),
        assignCustomRole: (...args) => this.#organizationRoleRepository.assignCustomRole(...args),
        revokeCustomRole: (...args) => this.#organizationRoleRepository.revokeCustomRole(...args),
      },
      prepareNotifications: (client) => this.#workPlanningAdapter.prepareNotifications(client),
      recordActivityProjection: (client, activity) => this.#migrationStore.recordPortableProjection(client, "Activity", activity.id, activity.schema, activity),
      prepareWorkspaceImport: (client) => this.#migrationStore.ensureWorkspaceImportSchema(client),
      mapImportedIdentity: (input) => this.#knowledgeAuthoringAdapter.mapImportedIdentity(input),
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
      (client) => this.#identityAccessAdapter.prepareRegistration(client), {
        prepareAuthority: (client) => this.#identityAccessAdapter.prepareAgentAuthority(client),
        markFormerAssignments: (client, organizationId, accountId, actorId) =>
          this.#workPlanningAdapter.markFormerAssignments(client, organizationId, accountId, actorId),
        degradePersonalConnections: (client, organizationId, accountId) =>
          this.#developmentIntegrationAdapter.degradePersonalConnections(client, organizationId, accountId),
      });
    this.#projectPermissionRepository = new PostgresProjectPermissionRepository(this.#kernel, async (client) => {
      await this.#identityAccessAdapter.prepareRegistration(client);
      await this.#organizationRoleRepository.prepare(client);
    });
    this.#relationshipQueryRepository = new PostgresRelationshipQueryRepository(this.#kernel,
      (client) => this.#noteTreeRepository.prepare(client));
    this.#visualizationBlockRepository = new PostgresVisualizationBlockRepository(this.#kernel,
      (client) => this.#noteTreeRepository.prepare(client));
    this.#portableProjectionContributors = [this.#visualizationBlockRepository];
    this.#workPlanningAdapter = new PostgresWorkPlanningRepositories(this.#kernel, {
      prepare: async (client) => {
        await this.#migrationStore.ensureNoteSchema(client);
        await this.#canonicalTaskRepository.prepare(client);
        await this.#identityAccessAdapter.prepareInvitations(client);
      },
      recordProjection: (client, task) => this.#migrationStore.recordPortableProjection(client, "Task", task.id, task.schema, task),
      recordWorkflowProjection: (client, workflow) => this.#migrationStore.recordPortableProjection(client, "Workflow", workflow.projectId, workflow.schema, workflow),
      recordBoardProjection: (client, board) => this.#migrationStore.recordPortableProjection(client, "Board", board.id, board.schema, board),
      recordAgentAudit: (client, memberId, workspaceId, taskId, cause) =>
        this.#migrationStore.recordAgentExecutionAudit(client, memberId, workspaceId, "agent_task_updated", taskId, cause),
      prepareAutomationDependencies: (client) => this.#migrationStore.ensureGitHubSignalSchema(client),
      recordIdentifiedNoteBlock: async (client, memberId, beforeRow, afterRow, projection) => {
        await this.#migrationStore.recordPortableProjection(client, "Note", projection.id, projection.schema, projection);
        await this.#knowledgeAuthoringAdapter.recordNoteRevisionAndActivity(client, memberId,
          this.#migrationStore.noteFromRow(beforeRow), this.#migrationStore.noteFromRow(afterRow),
          "note_block_identified", { kind: "member" });
      },
      recordTaskSourceActivity: (client, memberId, workspaceId, task) =>
        this.#knowledgeAuthoringAdapter.recordDomainActivity(client, memberId, workspaceId,
          "Task", task.id, "task_created_from_block", {}, task),
      ensureCanonicalWorkflow: (client, workspaceId) => this.#canonicalTaskRepository.ensureWorkflow(client, workspaceId),
      recordStructuredAgentAudit: (client, memberId, workspaceId, taskId, cause) =>
        this.#migrationStore.recordAgentExecutionAudit(client, memberId, workspaceId, "agent_proposal_task_applied", taskId, cause),
      recordActivityProjection: (client, activity) =>
        this.#migrationStore.recordPortableProjection(client, "Activity", activity.id, activity.schema, activity),
      prepareDiscussionScope: (client) => this.#knowledgeAuthoringAdapter.prepareDiscussions(client),
    });
    this.#knowledgeAuthoringAdapter = new PostgresKnowledgeAuthoringRepositories(this.#kernel, {
      prepare: (client) => this.#migrationStore.ensureNoteSchema(client),
      prepareInvitations: (client) => this.#identityAccessAdapter.prepareInvitations(client),
      prepareAttachments: (client) => this.#migrationStore.ensureAttachmentSchema(client),
      backfillLegacyNoteHistory: (client) => this.#migrationStore.backfillLegacyNoteHistory(client),
      parseActivityCause: (value) => this.#migrationStore.parseActivityCause(value),
      prepareBootstrap: (client) => this.#identityAccessAdapter.prepareRegistration(client),
      prepareImports: (client) => this.#migrationStore.ensureWorkspaceImportSchema(client),
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
      prepareHistory: (client) => this.#migrationStore.ensureNoteHistorySchema(client),
      prepareWorkspaceProjects: (client) => this.#identityAccessAdapter.prepareRegistration(client),
      recordProjection: (client, kind, id, schema, projection) => this.#migrationStore.recordPortableProjection(client, kind, id, schema, projection),
      recordInitialNoteLocation: (client, noteId, workspaceId) => this.#migrationStore.recordInitialNoteLocation(client, noteId, workspaceId),
      recordAgentAudit: (client, memberId, note, cause) =>
        this.#migrationStore.recordAgentExecutionAudit(client, memberId, note.workspaceId, "agent_note_created", note.id, cause),
    }, this.#workPlanningAdapter);
    this.#developmentIntegrationAdapter = new PostgresDevelopmentIntegrationRepositories(this.#kernel, {
      organizationRole: (organizationId, accountId) => this.#identityAccessAdapter.organizationRole(organizationId, accountId),
      prepareConnections: (client) => this.#migrationStore.ensureRepositoryConnectionSchema(client),
      lockedMemberships: (client, organizationId) => this.#organizationRoleRepository.lockedMemberships(client, organizationId),
      recordConnectionProjection: (client, record, revision) => this.#migrationStore.recordRepositoryConnectionProjection(client, record, revision),
      prepareSignals: (client) => this.#migrationStore.ensureGitHubSignalSchema(client),
      resolveTask: async (memberId, projectId, taskKey) => {
        const result = await this.#workPlanningAdapter.findTaskByKey(memberId, projectId, taskKey);
        return result.status === "found" ? { status: "found", task: { id: result.task.id, key: result.task.key,
          title: result.task.title, ...(result.task.developmentLinks ? { developmentLinks: result.task.developmentLinks } : {}) } }
          : { status: result.status };
      },
    }, this.#workPlanningAdapter);
    this.#migrationStore = new PostgresInstanceMigrationStore(this.#kernel, authenticationSecrets, {
      prepareRegistration: (client) => this.#identityAccessAdapter.prepareRegistration(client),
      prepareInvitations: (client) => this.#identityAccessAdapter.prepareInvitations(client),
      prepareAgentAuthority: (client) => this.#identityAccessAdapter.prepareAgentAuthority(client),
      prepareConnectionStateColumns: (client) => this.#developmentIntegrationAdapter.prepareConnectionStateColumns(client),
      prepareBoards: (client) => this.#workPlanningAdapter.prepareBoards(client),
      prepareDiscussions: (client) => this.#knowledgeAuthoringAdapter.prepareDiscussions(client),
      portableProjectionContributors: this.#portableProjectionContributors,
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
    return this.#identityAccessAdapter;
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
    await this.#migrationStore.verifyAuthenticationKey();
  }

  /** Prepare every storage capability for contract validation or an empty semantic migration target. */
  async prepareInstanceStore(transactionClient?: PostgresQueryable): Promise<void> {
    const prepare = async (client: PostgresQueryable) => {
      await this.#identityAccessAdapter.prepareRegistration(client);
      await this.#identityAccessAdapter.prepareOidc(client); await this.#identityAccessAdapter.prepareRecovery(client);
      await this.#migrationStore.ensureRepositoryConnectionSchema(client); await this.#migrationStore.ensureGitHubSignalSchema(client);
      await this.#workPlanningAdapter.prepareNotifications(client);
      await this.#identityAccessAdapter.prepareLocalization(client);
      await this.#migrationStore.ensureNoteSchema(client); await this.#noteTreeRepository.prepare(client);
      await this.#workPlanningAdapter.prepareBoards(client); await this.#migrationStore.ensureAttachmentSchema(client);
      await this.#knowledgeAuthoringAdapter.prepareDiscussions(client); await this.#identityAccessAdapter.prepareInvitations(client); await this.#migrationStore.ensurePortableProjectionSchema(client);
      await this.#migrationStore.ensureNoteHistorySchema(client); await this.#identityAccessAdapter.prepareAgentAuthority(client); await this.#migrationStore.ensureWorkspaceImportSchema(client);
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
      await this.#migrationStore.verifyAuthenticationKey(client);
      await this.prepareInstanceStore(client);
    }, beforeCommit);
  }

  async createFirstOrganizationOwner(record: BootstrapRecord): Promise<boolean> {
    return this.#migrationStore.createFirstOrganizationOwner(record);
  }

  async setupComplete(): Promise<boolean> {
    return this.#instanceSetupRepository.setupComplete();
  }

  async createFirstPersonalInstance(setup: FirstPersonalInstanceSetup): Promise<boolean> {
    return this.#instanceSetupRepository.createFirstPersonalInstance(setup);
  }

  async close(): Promise<void> {
    await this.#kernel.close();
  }

}

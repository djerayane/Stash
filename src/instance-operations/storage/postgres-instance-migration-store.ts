import { randomUUID } from "node:crypto";
import type { ActivityCause } from "../../activity.js";
import { createAuthenticationKeyCheck, verifyAuthenticationKeyCheck, type AuthenticationSecretCodec } from "../../authentication-secrets.js";
import type { NoteRecord } from "../../notes.js";
import type { BootstrapRecord } from "../../owner-bootstrap.js";
import type { PortableNoteLocationProjection } from "../../note-links.js";
import type { PortableRepositoryConnectionProjection, RepositoryConnectionRecord } from "../../repository-connections.js";
import type { PostgresPortableProjectionContributor } from "./portable-projection-contributor.js";
import { PostgresKernel, type PostgresQueryable } from "./postgres-kernel.js";

const authenticationKeyCheckLockId = 795_541_992;
const portableProjectionObjectKinds = ["Workspace", "Project", "Workflow", "WorkspaceWorkflow", "Collection", "ViewBlock", "Board", "Note", "NoteLocation", "NoteLink", "Task", "GuestProjectAccess", "RepositoryConnection", "Attachment", "Discussion", "DiscussionWorkLink", "Activity"] as const;
const portableProjectionObjectKindSql = portableProjectionObjectKinds.map((kind) => `'${kind}'`).join(", ");

export interface PostgresInstanceMigrationHooks {
  prepareRegistration(client: PostgresQueryable): Promise<void>;
  prepareInvitations(client: PostgresQueryable): Promise<void>;
  prepareAgentAuthority(client: PostgresQueryable): Promise<void>;
  prepareConnectionStateColumns(client: PostgresQueryable): Promise<void>;
  prepareBoards(client: PostgresQueryable): Promise<void>;
  prepareDiscussions(client: PostgresQueryable): Promise<void>;
  readonly portableProjectionContributors: readonly PostgresPortableProjectionContributor[];
}

/** Private migration contributors for the persisted capability schemas; runtime domain calls never enter here. */
export class PostgresInstanceMigrationStore {
  constructor(
    private readonly kernel: PostgresKernel,
    private readonly authenticationSecrets: AuthenticationSecretCodec,
    private readonly hooks: PostgresInstanceMigrationHooks,
  ) {}
  async createFirstOrganizationOwner(record: BootstrapRecord): Promise<boolean> {
    const workspaceId = record.workspaceId ?? randomUUID();
    const workspaceName = record.workspaceName ?? `${record.organizationName} Workspace`;
    const createdAt = record.createdAt ?? new Date().toISOString();
    return this.kernel.preparedControlledTransaction(
      (client) => this.hooks.prepareRegistration(client),
      async (client) => {
        await this.kernel.advisoryTransactionLock(client, 2_080_289_093);
        const existing = await client.query("SELECT 1 FROM stash_instance_bootstrap WHERE singleton = TRUE");
        if (existing.rowCount) return { commit: false, value: false };

        await client.query("INSERT INTO stash_organizations (id, name) VALUES ($1, $2)", [
          record.organizationId,
          record.organizationName,
        ]);
        await client.query(
          "INSERT INTO stash_accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)",
          [record.ownerId, record.ownerName, record.ownerEmail, this.authenticationSecrets.encrypt(record.passwordHash)],
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
        await this.recordPortableProjection(client, "Workspace", workspaceId, "stash.workspace.v1", {
          schema: "stash.workspace.v1", id: workspaceId, name: workspaceName,
          owner: { type: "organization", identity: { localOrganizationId: record.organizationId, displayName: record.organizationName } },
          createdBy: { localAccountId: record.ownerId, displayName: record.ownerName },
        });
        await client.query("INSERT INTO stash_instance_bootstrap (singleton) VALUES (TRUE)");
        return { commit: true, value: true };
      },
    );
  }

  async verifyAuthenticationKey(transactionClient?: PostgresQueryable): Promise<void> {
    const prepareTable = (client: PostgresQueryable) => client.query(`
        CREATE TABLE IF NOT EXISTS stash_authentication_key_check (
          singleton BOOLEAN PRIMARY KEY CHECK (singleton),
          encrypted_check TEXT NOT NULL
        )
      `);
    const verify = async (client: PostgresQueryable) => {
      await this.kernel.advisoryTransactionLock(client, authenticationKeyCheckLockId);
      const result = await client.query<{ encrypted_check: string }>(
        "SELECT encrypted_check FROM stash_authentication_key_check WHERE singleton = TRUE",
      );
      const existing = result.rows[0];
      if (existing) verifyAuthenticationKeyCheck(this.authenticationSecrets, existing.encrypted_check);
      else await client.query(
        "INSERT INTO stash_authentication_key_check (singleton, encrypted_check) VALUES (TRUE, $1)",
        [createAuthenticationKeyCheck(this.authenticationSecrets)],
      );
    };
    if (transactionClient) {
      await prepareTable(transactionClient);
      await verify(transactionClient);
    } else {
      await prepareTable(this.kernel);
      await this.kernel.transaction(verify);
    }
  }

  async ensureRepositoryConnectionSchema(transactionClient?: PostgresQueryable): Promise<void> {
    const prepare = async (client: PostgresQueryable) => {
      await this.hooks.prepareRegistration(client);
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
      await this.hooks.prepareConnectionStateColumns(client);
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
      await this.kernel.advisoryTransactionLock(transactionClient, 1_094_218_495);
      await upgrade(transactionClient);
    } else {
      await this.kernel.advisorySessionTransaction(1_094_218_495, prepare, upgrade);
    }
  }

  async ensureGitHubSignalSchema(transactionClient?: PostgresQueryable): Promise<void> {
    const prepare = async (client: PostgresQueryable) => {
      await this.ensureRepositoryConnectionSchema(client);
      await this.ensureNoteSchema(client);
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
    else await this.kernel.transaction(prepare);
  }

  async ensureNoteSchema(client: PostgresQueryable): Promise<void> {
    await this.hooks.prepareRegistration(client);
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

  async ensureNoteSchemaForPool(): Promise<void> {
    await this.kernel.withSession((client) => this.ensureNoteSchema(client));
  }

  async ensureAttachmentSchema(client: PostgresQueryable): Promise<void> {
    await this.hooks.prepareRegistration(client);
    await client.query(`CREATE TABLE IF NOT EXISTS stash_attachments (id UUID PRIMARY KEY, workspace_id UUID NOT NULL REFERENCES stash_workspaces(id), filename TEXT NOT NULL, content_type TEXT NOT NULL, byte_size BIGINT NOT NULL CHECK (byte_size > 0), relative_path TEXT NOT NULL, storage_key TEXT NOT NULL UNIQUE, source TEXT NOT NULL CHECK (source IN ('upload','paste')), created_by_account_id UUID NOT NULL REFERENCES stash_accounts(id), created_at TIMESTAMPTZ NOT NULL)`);
    await client.query(`CREATE TABLE IF NOT EXISTS stash_attachment_operation_receipts (
      operation_key UUID NOT NULL, workspace_id UUID NOT NULL REFERENCES stash_workspaces(id),
      created_by_account_id UUID NOT NULL REFERENCES stash_accounts(id), payload_digest TEXT NOT NULL,
      attachment_id UUID NOT NULL UNIQUE REFERENCES stash_attachments(id), projection JSONB NOT NULL,
      PRIMARY KEY (operation_key, workspace_id, created_by_account_id))`);
  }

  async ensurePortableProjectionSchema(client: PostgresQueryable): Promise<void> {
    await this.kernel.advisoryTransactionLock(client, 1_094_218_495);
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

  async recordPortableProjection(
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

  async recordInitialNoteLocation(client: PostgresQueryable, noteId: string, workspaceId: string): Promise<void> {
    const projection: PortableNoteLocationProjection = { schema: "stash.note-location.v1", noteId, workspaceId,
      path: `notes/${noteId}.md`, aliases: [], revision: 1 };
    await this.recordPortableProjection(client, "NoteLocation", noteId, projection.schema, projection);
  }

  async recordRepositoryConnectionProjection(client: PostgresQueryable, record: RepositoryConnectionRecord, revision: number): Promise<void> {
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

  parseActivityCause(value: string): ActivityCause {
    try {
      const parsed = JSON.parse(value) as ActivityCause;
      if (parsed && typeof parsed === "object" && typeof parsed.kind === "string") return parsed;
    } catch { /* Legacy rows stored just the cause kind. */ }
    return value === "member" ? { kind: "member" } : { kind: "member" };
  }

  noteFromRow(row: any): NoteRecord {
    return { id: row.id, workspaceId: row.workspace_id, content: row.content, document: row.document,
      revision: Number(row.revision), tags: row.tags ?? [], createdByMemberId: row.created_by_account_id,
      createdAt: new Date(row.created_at).toISOString(), ...(row.project_id ? { projectId: row.project_id } : {}),
      ...(row.reminder_at ? { reminder: { at: new Date(row.reminder_at).toISOString() } } : {}),
      ...(row.archived_at ? { archivedAt: new Date(row.archived_at).toISOString() } : {}) };
  }

  async ensureNoteHistorySchema(client: PostgresQueryable): Promise<void> {
    await this.ensureNoteSchema(client);
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

  async recordAgentExecutionAudit(client: PostgresQueryable, memberId: string, workspaceId: string, action: string,
    objectId: string, cause: Extract<ActivityCause, { kind: "agent" }>): Promise<void> {
    await this.hooks.prepareAgentAuthority(client);
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

  async ensureWorkspaceImportSchema(client: PostgresQueryable): Promise<void> {
    await this.ensureNoteHistorySchema(client);
    await this.ensureAttachmentSchema(client);
    await this.hooks.prepareBoards(client);
    await this.hooks.prepareDiscussions(client);
    await this.hooks.prepareInvitations(client);
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

  async backfillLegacyNoteHistory(client: PostgresQueryable): Promise<void> {
    await client.query(`INSERT INTO stash_note_history
      (note_id,workspace_id,revision,content,document,actor_account_id,cause,recorded_at)
      SELECT note.id,note.workspace_id,note.revision,note.content,note.document,note.created_by_account_id,
        '{"kind":"migration","source":"existing_note"}',note.created_at FROM stash_notes note
      WHERE NOT EXISTS (SELECT 1 FROM stash_note_history history WHERE history.note_id=note.id)
      ON CONFLICT (note_id,revision) DO NOTHING`);
  }

}

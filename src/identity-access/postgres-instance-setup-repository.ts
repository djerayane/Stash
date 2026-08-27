import { randomUUID } from "node:crypto";

import type { AuthenticationSecretCodec } from "../authentication-secrets.js";
import type { NoteTreeImpactInspector } from "../knowledge-authoring/note-tree.js";
import type { PostgresKernel, PostgresQueryable } from "../instance-operations/storage/postgres-kernel.js";
import { paragraphDocument } from "../rich-text.js";
import type { FirstPersonalInstanceSetup, InstanceSetupRepository, StarterTutorialContribution } from "./instance-setup.js";
import type { StarterTutorial, StarterTutorialRepository } from "./starter-tutorial.js";

type PrepareBase = (client: PostgresQueryable) => Promise<void>;

const workspaceMember = `(workspace.owner_type='personal' AND workspace.personal_owner_id=$2)
  OR (workspace.owner_type='organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
    WHERE membership.organization_id=workspace.organization_owner_id AND membership.account_id=$2))`;

/** Identity-access-owned first-run and tutorial persistence over the shared PostgreSQL kernel. */
export class PostgresInstanceSetupRepository implements InstanceSetupRepository, StarterTutorialRepository, NoteTreeImpactInspector {
  constructor(
    private readonly kernel: PostgresKernel,
    private readonly secrets: AuthenticationSecretCodec,
    private readonly prepareBase: PrepareBase,
  ) {}

  async prepare(client: PostgresQueryable): Promise<void> {
    await this.prepareBase(client);
    await client.query(`
      ALTER TABLE stash_tasks ALTER COLUMN project_id DROP NOT NULL;
      ALTER TABLE stash_tasks ALTER COLUMN task_key DROP NOT NULL;
      ALTER TABLE stash_tasks ALTER COLUMN workflow_status_id DROP NOT NULL;
      CREATE TABLE IF NOT EXISTS stash_workspace_workflow_statuses (
        id UUID PRIMARY KEY,
        workspace_id UUID NOT NULL REFERENCES stash_workspaces(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        category TEXT NOT NULL CHECK (category IN ('unstarted','started','completed','canceled')),
        position INTEGER NOT NULL CHECK (position > 0),
        UNIQUE (workspace_id, name),
        UNIQUE (workspace_id, position)
      );
      ALTER TABLE stash_tasks ADD COLUMN IF NOT EXISTS workspace_workflow_status_id UUID
        REFERENCES stash_workspace_workflow_statuses(id);
      CREATE TABLE IF NOT EXISTS stash_starter_tutorials (
        workspace_id UUID PRIMARY KEY REFERENCES stash_workspaces(id) ON DELETE CASCADE,
        root_note_id UUID NOT NULL REFERENCES stash_notes(id),
        workspace_workflow_status_id UUID NOT NULL REFERENCES stash_workspace_workflow_statuses(id),
        sample_task_ids UUID[] NOT NULL,
        contribution JSONB NOT NULL,
        CHECK (contribution->>'schema' = 'stash.starter-tutorial.v1')
      );
    `);
  }

  async setupComplete(): Promise<boolean> {
    return this.kernel.withSession(async (client) => {
      await this.prepare(client);
      return Boolean((await client.query("SELECT 1 FROM stash_instance_bootstrap WHERE singleton=TRUE")).rowCount);
    });
  }

  async createFirstPersonalInstance(setup: FirstPersonalInstanceSetup): Promise<boolean> {
    return this.kernel.preparedControlledTransaction(
      (client) => this.prepare(client),
      async (client) => {
        await this.kernel.advisoryTransactionLock(client, 2_080_289_093);
        if ((await client.query("SELECT 1 FROM stash_instance_bootstrap WHERE singleton=TRUE")).rowCount) {
          return { commit: false, value: false };
        }
        await client.query("INSERT INTO stash_accounts(id,name,email,password_hash) VALUES($1,$2,$3,$4)", [
          setup.account.id, setup.account.name, setup.account.email, this.secrets.encrypt(setup.account.passwordHash),
        ]);
        await client.query(`INSERT INTO stash_workspaces
          (id,name,owner_type,personal_owner_id,organization_owner_id,created_by_account_id,created_at)
          VALUES($1,$2,'personal',$3,NULL,$3,$4)`,
        [setup.workspace.id, setup.workspace.name, setup.account.id, setup.createdAt]);
        const actor = { localAccountId: setup.account.id, displayName: setup.account.name };
        await this.projection(client, "Workspace", setup.workspace.id, "stash.workspace.v1", {
          schema: "stash.workspace.v1", id: setup.workspace.id, name: setup.workspace.name,
          owner: { type: "personal", identity: actor }, createdBy: actor,
        });
        for (const [index, note] of setup.starter.notes.entries()) {
          const document = paragraphDocument(note.content, randomUUID());
          await client.query(`INSERT INTO stash_notes
            (id,workspace_id,project_id,content,document,revision,tags,created_by_account_id,created_at,title,parent_id,tree_position)
            VALUES($1,$2,NULL,$3,$4::jsonb,1,'[]'::jsonb,$5,$6,$7,$8,$9)`,
          [note.id, setup.workspace.id, note.content, JSON.stringify(document), setup.account.id, setup.createdAt,
            note.title, note.parentId ?? null, index + 1]);
          await this.projection(client, "Note", note.id, "stash.note.v1", {
            schema: "stash.note.v1", id: note.id, workspaceId: setup.workspace.id, content: note.content,
            tags: [], createdAt: setup.createdAt, createdBy: actor,
          });
          await this.projection(client, "NoteLocation", note.id, "stash.note-location.v1", {
            schema: "stash.note-location.v1", noteId: note.id, workspaceId: setup.workspace.id,
            path: `notes/${note.id}.md`, aliases: [], revision: 1, position: String(index + 1),
            ...(note.parentId ? { parentId: note.parentId } : {}),
          });
        }
        for (const link of setup.starter.links) {
          await client.query(`INSERT INTO stash_note_links
            (id,workspace_id,source_note_id,target_note_id,target_path,candidate_note_ids,label,revision)
            VALUES($1,$2,$3,$4,$5,'{}',$6,1)`,
          [link.id, setup.workspace.id, link.sourceNoteId, link.targetNoteId, `notes/${link.targetNoteId}.md`, link.label]);
          await this.projection(client, "NoteLink", link.id, "stash.note-link.v2", {
            schema: "stash.note-link.v2", id: link.id, workspaceId: setup.workspace.id,
            sourceNoteId: link.sourceNoteId, targetNoteId: link.targetNoteId,
            targetPath: `notes/${link.targetNoteId}.md`, candidateNoteIds: [], label: link.label, revision: 1,
          });
        }
        const workflow = setup.starter.workspaceWorkflowStatus;
        await client.query(`INSERT INTO stash_workspace_workflow_statuses(id,workspace_id,name,category,position)
          VALUES($1,$2,$3,$4,$5)`, [workflow.id, setup.workspace.id, workflow.name, workflow.category, workflow.position]);
        for (const task of setup.starter.tasks) await client.query(`INSERT INTO stash_tasks
          (id,workspace_id,project_id,task_key,workflow_status_id,workspace_workflow_status_id,title,created_by_account_id,created_at,linked_note_ids)
          VALUES($1,$2,NULL,NULL,NULL,$3,$4,$5,$6,$7::jsonb)`,
        [task.id, setup.workspace.id, task.workspaceWorkflowStatusId, task.title, setup.account.id, setup.createdAt,
          JSON.stringify([setup.starter.contribution.taskView.noteId])]);
        await client.query(`INSERT INTO stash_starter_tutorials
          (workspace_id,root_note_id,workspace_workflow_status_id,sample_task_ids,contribution)
          VALUES($1,$2,$3,$4::uuid[],$5::jsonb)`,
        [setup.workspace.id, setup.starter.contribution.rootNoteId, workflow.id,
          setup.starter.tasks.map(({ id }) => id), JSON.stringify(setup.starter.contribution)]);
        await client.query(`INSERT INTO stash_sessions
          (id,account_id,token_lookup,token_hash,created_at,last_seen_at,user_agent) VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [setup.session.id, setup.session.accountId, this.secrets.blindIndex(setup.session.tokenHash),
          this.secrets.encrypt(setup.session.tokenHash), setup.session.createdAt, setup.session.lastSeenAt, setup.session.userAgent ?? null]);
        await client.query("INSERT INTO stash_instance_bootstrap(singleton) VALUES(TRUE)");
        return { commit: true, value: true };
      },
    );
  }

  async readStarterTutorial(memberId: string, rootNoteId: string): Promise<StarterTutorial | undefined> {
    return this.kernel.withSession(async (client) => {
      await this.prepare(client);
      return this.read(client, memberId, rootNoteId);
    });
  }

  async renameStarterCollection(memberId: string, rootNoteId: string, name: string): Promise<StarterTutorial | undefined> {
    return this.kernel.transaction(async (client) => {
      await this.prepare(client);
      const current = await this.read(client, memberId, rootNoteId, true);
      if (!current) return undefined;
      const contribution: StarterTutorialContribution = { ...current,
        collection: { ...current.collection, name } };
      await client.query("UPDATE stash_starter_tutorials SET contribution=$2::jsonb WHERE root_note_id=$1", [
        rootNoteId, JSON.stringify({ schema: contribution.schema, rootNoteId: contribution.rootNoteId,
          collection: contribution.collection, taskView: contribution.taskView }),
      ]);
      return { ...current, collection: contribution.collection };
    });
  }

  async inspect(memberId: string, noteIds: readonly string[]): Promise<{ collectionCount: number }> {
    if (!noteIds.length) return { collectionCount: 0 };
    return this.kernel.withSession(async (client) => {
      await this.prepare(client);
      const result = await client.query(`SELECT 1 FROM stash_starter_tutorials tutorial
        JOIN stash_workspaces workspace ON workspace.id=tutorial.workspace_id
        WHERE tutorial.root_note_id=ANY($1::uuid[]) AND (${workspaceMember}) LIMIT 1`, [noteIds, memberId]);
      return { collectionCount: result.rowCount ? 1 : 0 };
    });
  }

  /** Called by Note Tree inside the same transaction that trashes a tutorial root. */
  async retireForTrashedBranch(client: PostgresQueryable, rootNoteId: string): Promise<void> {
    await this.prepare(client);
    const tutorial = await client.query<{ workspace_workflow_status_id: string; sample_task_ids: string[] }>(
      "SELECT workspace_workflow_status_id,sample_task_ids FROM stash_starter_tutorials WHERE root_note_id=$1 FOR UPDATE", [rootNoteId]);
    const row = tutorial.rows[0];
    if (!row) return;
    await client.query("DELETE FROM stash_note_links WHERE source_note_id=ANY($1::uuid[]) OR target_note_id=ANY($1::uuid[])", [
      await this.branchIds(client, rootNoteId),
    ]);
    await client.query("DELETE FROM stash_tasks WHERE id=ANY($1::uuid[])", [row.sample_task_ids]);
    await client.query("DELETE FROM stash_starter_tutorials WHERE root_note_id=$1", [rootNoteId]);
    await client.query(`DELETE FROM stash_workspace_workflow_statuses status WHERE id=$1
      AND NOT EXISTS (SELECT 1 FROM stash_tasks task WHERE task.workspace_workflow_status_id=status.id)`, [row.workspace_workflow_status_id]);
  }

  private async read(client: PostgresQueryable, memberId: string, rootNoteId: string, lock = false): Promise<StarterTutorial | undefined> {
    const result = await client.query<{ workspace_id: string; contribution: StarterTutorialContribution }>(`SELECT
      tutorial.workspace_id,tutorial.contribution FROM stash_starter_tutorials tutorial
      JOIN stash_workspaces workspace ON workspace.id=tutorial.workspace_id
      JOIN stash_notes root ON root.id=tutorial.root_note_id
      WHERE tutorial.root_note_id=$1 AND root.trashed_at IS NULL AND root.archived_at IS NULL AND (${workspaceMember})${lock ? " FOR UPDATE OF tutorial" : ""}`,
    [rootNoteId, memberId]);
    const row = result.rows[0];
    if (!row) return undefined;
    const notes = await client.query<any>(`WITH RECURSIVE branch AS (
      SELECT id,title,content,parent_id,tree_position,ARRAY[tree_position] ordering FROM stash_notes WHERE id=$1
      UNION ALL SELECT child.id,child.title,child.content,child.parent_id,child.tree_position,branch.ordering||child.tree_position
      FROM stash_notes child JOIN branch ON child.parent_id=branch.id
      WHERE child.archived_at IS NULL AND child.trashed_at IS NULL
    ) SELECT id,title,content,parent_id FROM branch ORDER BY ordering,id`, [rootNoteId]);
    const noteIds = notes.rows.map(({ id }: any) => id);
    const links = await client.query<any>(`SELECT id,source_note_id,target_note_id,label FROM stash_note_links
      WHERE source_note_id=ANY($1::uuid[]) AND target_note_id=ANY($1::uuid[]) ORDER BY id`, [noteIds]);
    return { ...row.contribution, workspaceId: row.workspace_id,
      notes: notes.rows.map(({ id, title, content, parent_id }: any) => ({ id, title, content, ...(parent_id ? { parentId: parent_id } : {}) })),
      links: links.rows.map(({ id, source_note_id, target_note_id, label }: any) => ({ id, sourceNoteId: source_note_id, targetNoteId: target_note_id, label })) };
  }

  private async branchIds(client: PostgresQueryable, rootNoteId: string): Promise<string[]> {
    const result = await client.query<{ id: string }>(`WITH RECURSIVE branch AS (
      SELECT id FROM stash_notes WHERE id=$1 UNION ALL SELECT child.id FROM stash_notes child JOIN branch ON child.parent_id=branch.id
    ) SELECT id FROM branch`, [rootNoteId]);
    return result.rows.map(({ id }) => id);
  }

  private async projection(client: PostgresQueryable, kind: string, id: string, schema: string, payload: object): Promise<void> {
    await client.query(`INSERT INTO stash_portable_projection_outbox(object_kind,object_id,revision,projection_schema,payload)
      SELECT $1,$2,COALESCE(MAX(revision),0)+1,$3,$4::jsonb FROM stash_portable_projection_outbox
      WHERE object_kind=$1 AND object_id=$2`, [kind, id, schema, JSON.stringify(payload)]);
  }
}

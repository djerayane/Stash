import { randomUUID } from "node:crypto";

import type { AuthenticationSecretCodec } from "../authentication-secrets.js";
import type { TutorialContributionRepository } from "../knowledge-authoring/collections.js";
import type { PostgresKernel, PostgresQueryable } from "../instance-operations/storage/postgres-kernel.js";
import { paragraphDocument } from "../rich-text.js";
import type { FirstPersonalInstanceSetup, InstanceSetupRepository } from "./instance-setup.js";

type PrepareBase = (client: PostgresQueryable) => Promise<void>;

/** Identity-access-owned atomic first-run aggregate over focused capability adapters. */
export class PostgresInstanceSetupRepository implements InstanceSetupRepository {
  constructor(private readonly kernel: PostgresKernel, private readonly secrets: AuthenticationSecretCodec,
    private readonly prepareBase: PrepareBase, private readonly tutorial: TutorialContributionRepository) {}

  async prepare(client: PostgresQueryable): Promise<void> {
    await this.prepareBase(client);
    await client.query(`
      ALTER TABLE stash_tasks ALTER COLUMN project_id DROP NOT NULL;
      ALTER TABLE stash_tasks ALTER COLUMN task_key DROP NOT NULL;
      ALTER TABLE stash_tasks ALTER COLUMN workflow_status_id DROP NOT NULL;
      CREATE TABLE IF NOT EXISTS stash_workspace_workflow_statuses (
        id UUID PRIMARY KEY, workspace_id UUID NOT NULL REFERENCES stash_workspaces(id) ON DELETE CASCADE,
        name TEXT NOT NULL, category TEXT NOT NULL CHECK(category IN ('unstarted','started','completed','canceled')),
        position INTEGER NOT NULL CHECK(position>0), UNIQUE(workspace_id,name), UNIQUE(workspace_id,position)
      );
      ALTER TABLE stash_tasks ADD COLUMN IF NOT EXISTS workspace_workflow_status_id UUID REFERENCES stash_workspace_workflow_statuses(id);
    `);
    await this.tutorial.prepare(client);
  }

  async setupComplete(): Promise<boolean> { return this.kernel.withSession(async (client) => {
    await this.prepare(client); return Boolean((await client.query("SELECT 1 FROM stash_instance_bootstrap WHERE singleton=TRUE")).rowCount);
  }); }

  async createFirstPersonalInstance(setup: FirstPersonalInstanceSetup): Promise<boolean> {
    return this.kernel.preparedControlledTransaction((client) => this.prepare(client), async (client) => {
      await this.kernel.advisoryTransactionLock(client, 2_080_289_093);
      if ((await client.query("SELECT 1 FROM stash_instance_bootstrap WHERE singleton=TRUE")).rowCount) return { commit:false,value:false };
      await client.query("INSERT INTO stash_accounts(id,name,email,password_hash) VALUES($1,$2,$3,$4)",
        [setup.account.id,setup.account.name,setup.account.email,this.secrets.encrypt(setup.account.passwordHash)]);
      await client.query(`INSERT INTO stash_workspaces(id,name,owner_type,personal_owner_id,organization_owner_id,created_by_account_id,created_at)
        VALUES($1,$2,'personal',$3,NULL,$3,$4)`,[setup.workspace.id,setup.workspace.name,setup.account.id,setup.createdAt]);
      const actor={localAccountId:setup.account.id,displayName:setup.account.name};
      await this.projection(client,"Workspace",setup.workspace.id,"stash.workspace.v1",{schema:"stash.workspace.v1",id:setup.workspace.id,
        name:setup.workspace.name,owner:{type:"personal",identity:actor},createdBy:actor});
      for(const [index,note] of setup.starter.notes.entries()){
        const document=paragraphDocument(note.content,randomUUID());
        if(note.id===setup.starter.knowledge.viewBlock.ownerNoteId) document.blocks.push({type:"paragraph",blockKey:randomUUID(),
          id:setup.starter.knowledge.viewBlock.blockId,content:[{text:`Task View: ${setup.starter.knowledge.viewBlock.title}`}]});
        await client.query(`INSERT INTO stash_notes(id,workspace_id,project_id,content,document,revision,tags,created_by_account_id,created_at,title,parent_id,tree_position)
          VALUES($1,$2,NULL,$3,$4::jsonb,1,'[]'::jsonb,$5,$6,$7,$8,$9)`,[note.id,setup.workspace.id,note.content,
          JSON.stringify(document),setup.account.id,setup.createdAt,note.title,note.parentId??null,index+1]);
        await this.projection(client,"Note",note.id,"stash.note.v1",{schema:"stash.note.v1",id:note.id,workspaceId:setup.workspace.id,
          content:note.content,tags:[],createdAt:setup.createdAt,createdBy:actor});
        await this.projection(client,"NoteLocation",note.id,"stash.note-location.v1",{schema:"stash.note-location.v1",noteId:note.id,
          workspaceId:setup.workspace.id,path:`notes/${note.id}.md`,aliases:[],revision:1,position:String(index+1),...(note.parentId?{parentId:note.parentId}:{})});
      }
      for(const link of setup.starter.links){await client.query(`INSERT INTO stash_note_links(id,workspace_id,source_note_id,target_note_id,target_path,candidate_note_ids,label,revision)
        VALUES($1,$2,$3,$4,$5,'{}',$6,1)`,[link.id,setup.workspace.id,link.sourceNoteId,link.targetNoteId,`notes/${link.targetNoteId}.md`,link.label]);
        await this.projection(client,"NoteLink",link.id,"stash.note-link.v2",{schema:"stash.note-link.v2",id:link.id,workspaceId:setup.workspace.id,
          sourceNoteId:link.sourceNoteId,targetNoteId:link.targetNoteId,targetPath:`notes/${link.targetNoteId}.md`,candidateNoteIds:[],label:link.label,revision:1});}
      const workflow=setup.starter.workspaceWorkflowStatus;
      await client.query("INSERT INTO stash_workspace_workflow_statuses(id,workspace_id,name,category,position) VALUES($1,$2,$3,$4,$5)",
        [workflow.id,setup.workspace.id,workflow.name,workflow.category,workflow.position]);
      await this.projection(client,"WorkspaceWorkflow",workflow.id,"stash.workspace-workflow.v1",{schema:"stash.workspace-workflow.v1",
        id:workflow.id,workspaceId:setup.workspace.id,statuses:[workflow]});
      for(const task of setup.starter.tasks){await client.query(`INSERT INTO stash_tasks(id,workspace_id,project_id,task_key,workflow_status_id,workspace_workflow_status_id,title,created_by_account_id,created_at,linked_note_ids)
        VALUES($1,$2,NULL,NULL,NULL,$3,$4,$5,$6,$7::jsonb)`,[task.id,setup.workspace.id,task.workspaceWorkflowStatusId,task.title,
          setup.account.id,setup.createdAt,JSON.stringify([setup.starter.knowledge.viewBlock.ownerNoteId])]);
        await client.query("INSERT INTO stash_task_note_sources(task_id,note_id) VALUES($1,$2)",[task.id,setup.starter.knowledge.viewBlock.ownerNoteId]);
        await this.projection(client,"Task",task.id,"stash.task.v1",{schema:"stash.task.v1",id:task.id,workspaceId:setup.workspace.id,
          title:task.title,status:{id:workflow.id,name:workflow.name,category:workflow.category},sourceNoteIds:[setup.starter.knowledge.viewBlock.ownerNoteId],
          createdAt:setup.createdAt,createdBy:actor,linkedNoteIds:[setup.starter.knowledge.viewBlock.ownerNoteId]});}
      await this.tutorial.seed(client,setup.starter.knowledge,{workflowStatusId:workflow.id,sampleTaskIds:setup.starter.tasks.map(({id})=>id)});
      await client.query(`INSERT INTO stash_sessions(id,account_id,token_lookup,token_hash,created_at,last_seen_at,user_agent)
        VALUES($1,$2,$3,$4,$5,$6,$7)`,[setup.session.id,setup.session.accountId,this.secrets.blindIndex(setup.session.tokenHash),
        this.secrets.encrypt(setup.session.tokenHash),setup.session.createdAt,setup.session.lastSeenAt,setup.session.userAgent??null]);
      await client.query("INSERT INTO stash_instance_bootstrap(singleton) VALUES(TRUE)"); return {commit:true,value:true};
    });
  }

  private async projection(client:PostgresQueryable,kind:string,id:string,schema:string,payload:object){await client.query(`INSERT INTO stash_portable_projection_outbox(object_kind,object_id,revision,projection_schema,payload)
    SELECT $1,$2,COALESCE(MAX(revision),0)+1,$3,$4::jsonb FROM stash_portable_projection_outbox WHERE object_kind=$1 AND object_id=$2`,[kind,id,schema,JSON.stringify(payload)]);}
}

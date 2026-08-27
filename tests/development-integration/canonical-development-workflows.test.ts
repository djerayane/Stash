import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createAuthenticationSecretCodec } from "../../src/authentication-secrets.js";
import { AutomationService } from "../../src/automations.js";
import { EmbeddedInstanceStore } from "../../src/embedded-instance-store.js";
import { RepositoryConnectionService, type GitHubApp } from "../../src/repository-connections.js";
import { CanonicalTaskService } from "../../src/work-planning/canonical-tasks.js";
import { WorkspaceProjectService } from "../../src/workspaces-projects.js";

test("development adapters resolve canonical active keys and aliases and automate one Workspace status", async () => {
  const store=await EmbeddedInstanceStore.open(await mkdtemp(join(tmpdir(),"stash-canonical-development-")),
    createAuthenticationSecretCodec(randomBytes(32).toString("base64")));
  try {
    const ownerId="11111111-1111-4111-8111-111111111111", organizationId="22222222-2222-4222-8222-222222222222";
    await store.database.createFirstOrganizationOwner({organizationId,organizationName:"Studio",ownerId,ownerName:"Ada",
      ownerEmail:"ada@example.test",passwordHash:"test",role:"Owner"});
    const workspaces=new WorkspaceProjectService(store.database);
    const workspace=await workspaces.createWorkspace(ownerId,{name:"Work",owner:{type:"organization",organizationId}});
    assert.equal(workspace.status,"created"); if(workspace.status!=="created")return;
    const alpha=await workspaces.createProject(ownerId,workspace.workspace.id,{name:"Alpha",key:"ALP"});
    const beta=await workspaces.createProject(ownerId,workspace.workspace.id,{name:"Beta",key:"BET"});
    assert.equal(alpha.status,"created"); assert.equal(beta.status,"created"); if(alpha.status!=="created"||beta.status!=="created")return;
    const tasks=new CanonicalTaskService(store.database.canonicalTaskRepository());
    const created=await tasks.create(ownerId,workspace.workspace.id,{title:"Ship one Task",projectIds:[alpha.project.id,beta.project.id]});
    assert.equal(created.status,"created"); if(created.status!=="created")return;
    const alphaKey=created.task.projectKeys.find(({projectId})=>projectId===alpha.project.id)!.key;
    const betaKey=created.task.projectKeys.find(({projectId})=>projectId===beta.project.id)!.key;
    const removed=await tasks.associate(ownerId,created.task.id,{projectIds:[beta.project.id]});
    assert.equal(removed.status,"updated");

    const github:GitHubApp={async inspectRepository(input){return{installationId:input.installationId,repositoryId:"987",repositoryUrl:"https://github.com/acme/stash"};},async verifyRepository(){}};
    const connections=new RepositoryConnectionService(store.database.developmentIntegrationRepositories(),github);
    const connection=await connections.connect(ownerId,organizationId,{installationId:42,owner:"acme",name:"stash"});
    assert.equal(await connections.attachToProject(ownerId,organizationId,connection.connection.id,alpha.project.id),"attached");
    assert.equal(await connections.attachToProject(ownerId,organizationId,connection.connection.id,beta.project.id),"attached");
    for(const [key,projectId] of [[alphaKey,alpha.project.id],[betaKey,beta.project.id]] as const){
      const matches=await store.database.developmentIntegrationRepositories().matchingTasks(42,"987",[key]);
      assert.deepEqual(matches.map(({taskId})=>taskId),[created.task.id]);
      assert.equal(matches[0]?.projectId,projectId);
      assert.equal((await store.database.workPlanningRepositories().findTaskByKey(ownerId,projectId,key)).status,"found");
      const search=await store.database.searchWorkspace(ownerId,workspace.workspace.id,{q:key,object:"task"});
      assert.equal(search.status,"found");
      assert.deepEqual(search.status==="found"?search.results.map((result:{id:string})=>result.id):[],[created.task.id]);
    }

    const workflow=await tasks.workflow(ownerId,workspace.workspace.id); assert.equal(workflow.status,"found"); if(workflow.status!=="found")return;
    const started=workflow.workflow.statuses.find(({category})=>category==="started")!;
    const automations=new AutomationService(store.database);
    await automations.enable(ownerId,beta.project.id,{trigger:"branch_created",targetStatusId:started.id});
    const signal={id:"33333333-3333-4333-8333-333333333333",deliveryId:"canonical",installationId:42,repositoryId:"987",
      kind:"branch" as const,providerId:"branch",url:"https://github.com/acme/stash/tree/BET-1",label:betaKey,occurredAt:new Date().toISOString(),trigger:"branch_created" as const};
    const candidate={id:"44444444-4444-4444-8444-444444444444",signalId:signal.id,taskId:created.task.id,projectId:beta.project.id,
      organizationId,taskKey:betaKey,taskTitle:created.task.title,matchedKey:betaKey,status:"confirmed" as const};
    await store.database.developmentIntegrationRepositories().receive(signal,[candidate]); await automations.applySignal(signal,[candidate]);
    const updated=await tasks.resolveKey(ownerId,beta.project.id,betaKey);
    assert.equal(updated.status,"found"); assert.equal(updated.status==="found"?updated.task.status.id:"",started.id);
  } finally { await store.close(); }
});

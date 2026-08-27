import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { deflateRawSync } from "node:zlib";
import { Pool } from "pg";

import { startInstance } from "../src/instance.js";
import { PortableWorkspaceExportService, type PortableWorkspaceExportSnapshot } from "../src/portable-workspace-export.js";
import { InvalidPortableWorkspaceImport, PortableWorkspaceImportService, PortableWorkspaceImportTooLarge, publishedPortableWorkspaceExportSchemas, type PortableWorkspaceImportBundle, type PortableWorkspaceImportReport, type PortableWorkspaceImportRepository } from "../src/portable-workspace-import.js";
import { LocalAttachmentStorage } from "../src/attachments.js";
import { PostgresDatabase } from "../src/postgres-database.js";
import { createAuthenticationSecretCodec } from "../src/authentication-secrets.js";
import { markdownToRichText } from "../src/rich-text.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const noteId = "22222222-2222-4222-8222-222222222222";
const actor = { localAccountId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", displayName: "Ada Lovelace" };
const credentialKeys = ["clientSecret","client_secret","CLIENT-SECRET","apiKey","api_token","Authorization",
  "x_api_key","oidc-client-secret","auth-header","cookie_header","session_cookie","sessionId","private.key",
  "privateCredential","oauthToken","githubAccessToken","refresh-token","dbPassword","database_password",
  "smtpPassword","clientPassword","webhookSecret","githubToken","encryptionKey","signingKey","credentialValue"];
const benignActivityState={sessionDuration:30,authenticationMethod:"member",cookiePolicy:"strict",privateProject:true,tokenEstimate:8,apiVersion:"v1"};
const snapshot: PortableWorkspaceExportSnapshot = {
  workspace: { schema: "stash.workspace.v1", id: workspaceId, name: "Portable", owner: { type: "personal", identity: actor }, createdBy: actor },
  notes: [{ schema: "stash.note.v1", id: noteId, workspaceId, content: "# Durable", tags: ["knowledge"], createdAt: "2026-01-01T00:00:00.000Z", createdBy: actor }],
  tasks: [], boards: [],
  attachments: [{ projection: { schema: "stash.attachment.v1", id: "33333333-3333-4333-8333-333333333333", workspaceId,
    filename: "proof.bin", contentType: "application/octet-stream", size: 3,
    relativePath: "./attachments/33333333-3333-4333-8333-333333333333/proof.bin", source: "upload",
    createdAt: "2026-01-01T00:00:00.000Z", createdBy: actor }, content: Buffer.from([1, 2, 3]) }],
  noteLocations: [{ schema: "stash.note-location.v1", noteId, workspaceId, path: `notes/${noteId}.md`, aliases: [], revision: 1 }],
  noteLinks: [], activities: [], noteHistory: [],
};

class ImportMemory implements PortableWorkspaceImportRepository {
  readonly imports = new Map<string, { digest: string; report: PortableWorkspaceImportReport }>();
  committed?: PortableWorkspaceImportBundle;
  fail = false;
  async findWorkspaceImport(importId: string) { const value = this.imports.get(importId); return value ? { archiveSha256: value.digest, report: value.report } : undefined; }
  readonly mappings=new Map<string,string>();
  async mapImportedIdentity(input:{importId:string;sourceAccountId:string;localAccountId:string;idempotencyKey:string}) { const existing=this.mappings.get(input.idempotencyKey);
    if(existing) return existing===JSON.stringify(input)?{status:"duplicate" as const,sourceAccountId:input.sourceAccountId,localAccountId:input.localAccountId}:{status:"conflict" as const};
    if(!this.imports.has(input.importId)) return {status:"not_found" as const}; this.mappings.set(input.idempotencyKey,JSON.stringify(input));
    return {status:"mapped" as const,sourceAccountId:input.sourceAccountId,localAccountId:input.localAccountId}; }
  async importWorkspace(importId: string, bundle: PortableWorkspaceImportBundle) {
    if (this.fail) throw new Error("storage_down");
    const previous = this.imports.get(importId);
    if (previous) {
      if (previous.digest !== bundle.archiveSha256) return { status: "workspace_conflict" as const };
      return { status: "duplicate" as const, report: previous.report };
    }
    const report: PortableWorkspaceImportReport = { schema: "stash.portable-workspace-import-report.v1", importId,
      workspaceId: bundle.state.workspace.id, archiveSha256: bundle.archiveSha256,
      transformations: bundle.identityStubs.map(({ sourceAccountId }) => ({ kind: "transformed", object: sourceAccountId, reason: "identity_stub_created" })),
      transformed: bundle.identityStubs.map(({ sourceAccountId }) => ({ kind: "transformed", object: sourceAccountId, reason: "identity_stub_created" })), skipped: [], ambiguous: [],
      identityStubs: bundle.identityStubs };
    // A real adapter performs this operation in one transaction. The fake exposes
    // the same atomic seam used by the running-Instance acceptance test.
    this.committed = bundle; this.imports.set(importId, { digest: bundle.archiveSha256, report });
    return { status: "imported" as const, report };
  }
}
async function archive(): Promise<Buffer> {
  const result = await new PortableWorkspaceExportService({ async readExportSnapshot() { return { status: "found", snapshot }; } }).export("ada", workspaceId);
  assert.equal(result.status, "exported"); if (result.status !== "exported") throw new Error(); return result.archive;
}
async function archiveFor(value: PortableWorkspaceExportSnapshot): Promise<Buffer> {
  const result = await new PortableWorkspaceExportService({ async readExportSnapshot() { return { status: "found", snapshot: value }; } }).export("ada", workspaceId);
  assert.equal(result.status,"exported"); if(result.status!=="exported") throw new Error(); return result.archive;
}
function storedFiles(archive: Buffer): Map<string, Buffer> {
  const end = archive.length - 22; const count = archive.readUInt16LE(end + 10); let cursor = archive.readUInt32LE(end + 16);
  const files = new Map<string, Buffer>();
  for (let index = 0; index < count; index += 1) { const size = archive.readUInt32LE(cursor + 24); const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30); const commentLength = archive.readUInt16LE(cursor + 32); const local = archive.readUInt32LE(cursor + 42);
    const path = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString(); const localName = archive.readUInt16LE(local + 26);
    const localExtra = archive.readUInt16LE(local + 28); const offset = local + 30 + localName + localExtra; files.set(path, archive.subarray(offset, offset + size));
    cursor += 46 + nameLength + extraLength + commentLength; }
  return files;
}
function markdownZip(files:Record<string,string|Buffer>,compress=false):Buffer{
  const locals:Buffer[]=[];const centrals:Buffer[]=[];let offset=0;
  for(const [path,value] of Object.entries(files)){const name=Buffer.from(path);const content=Buffer.isBuffer(value)?value:Buffer.from(value);const stored=compress?deflateRawSync(content):content;const method=compress?8:0;const local=Buffer.alloc(30+name.length);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(0x800,6);local.writeUInt16LE(method,8);local.writeUInt32LE(stored.length,18);local.writeUInt32LE(content.length,22);local.writeUInt16LE(name.length,26);name.copy(local,30);locals.push(local,stored);const central=Buffer.alloc(46+name.length);central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(0x800,8);central.writeUInt16LE(method,10);central.writeUInt32LE(stored.length,20);central.writeUInt32LE(content.length,24);central.writeUInt16LE(name.length,28);central.writeUInt32LE(offset,42);name.copy(central,46);centrals.push(central);offset+=local.length+stored.length;}
  const directory=Buffer.concat(centrals);const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(centrals.length,8);end.writeUInt16LE(centrals.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...locals,directory,end]);
}

describe("Portable Workspace import", () => {
  it("preflights an Obsidian vault and reports tags, links, attachments, ambiguity, and skipped metadata",async()=>{
    const repository=new ImportMemory();const storage={async put(){},async get(){return Buffer.alloc(0)},async delete(){}};
    const service=new PortableWorkspaceImportService(repository,storage);const result=await service.importMarkdown(randomUUID(),actor.localAccountId,markdownZip({
      "Vault/":"", "Vault/Folder/":"", "Vault/Home.md":"---\ntags: [start, knowledge]\n---\n# Home\n[[Folder/Target]] [[Same]] ![[image.png]] [Target](Folder/Target.md) ![Image](image.png) [Missing](Missing.md)",
      "Vault/Folder/Target.md":"# Target","Vault/A/Same.md":"# A","Vault/B/Same.md":"# B","Vault/image.png":Buffer.from([1,2,3]),"Vault/.obsidian/config":"{}",
    }));
    assert.equal(result.status,"imported");assert.equal(repository.committed?.state.notes.length,4);assert.deepEqual(repository.committed?.state.notes[0]?.tags,["start","knowledge"]);
    assert.equal(repository.committed?.state.attachments.length,1);assert.equal(repository.committed?.state.noteLinks.length,4);
    assert.match(repository.committed?.state.notes[0]?.content??"",/\.\/attachments\//);
    assert.ok(repository.committed?.transformations?.some(({kind,reason})=>kind==="transformed"&&reason==="relative_note_link"));
    assert.ok(repository.committed?.transformations?.some(({kind,reason})=>kind==="transformed"&&reason==="relative_attachment_link"));
    assert.ok(repository.committed?.transformations?.some(({kind,reason})=>kind==="skipped"&&reason==="relative_note_target_not_found"));
    assert.ok(repository.committed?.state.noteLinks.some((link)=>link.schema==="stash.note-link.v2"&&link.targetPath==="Missing.md"&&!link.targetNoteId));
    assert.ok(repository.committed?.transformations?.some(({kind,reason})=>kind==="ambiguous"&&reason==="multiple_note_targets"));
    assert.ok(repository.committed?.transformations?.some(({kind,reason})=>kind==="skipped"&&reason==="hidden_vault_metadata"));
  });
  it("preserves frontmatter properties while reporting only tags that were actually extracted",async()=>{
    const repository=new ImportMemory();const service=new PortableWorkspaceImportService(repository,{async put(){},async get(){return Buffer.alloc(0)},async delete(){}});
    await service.importMarkdown(randomUUID(),actor.localAccountId,markdownZip({"Properties.md":"---\ntitle: Durable title\naliases: [One, Two]\ncssclasses: wide\nexample: \"```\"\n---\n# Body","No tags.md":"---\ntitle: Still here\n---\nText"}));
    const [properties,noTags]=repository.committed!.state.notes;
    assert.match(properties!.content,/````yaml\ntitle: Durable title\naliases: \[One, Two\]\ncssclasses: wide\nexample: "```"\n````/);
    assert.match(noTags!.content,/```yaml\ntitle: Still here\n```/);
    assert.equal(repository.committed!.transformations!.filter(({reason})=>reason==="frontmatter_tags_extracted").length,0);
    assert.equal(repository.committed!.transformations!.filter(({reason})=>reason==="frontmatter_preserved").length,2);
  });
  it("preserves and reports ambiguous YAML tag syntax instead of corrupting it",async()=>{
    const repository=new ImportMemory();const service=new PortableWorkspaceImportService(repository,{async put(){},async get(){return Buffer.alloc(0)},async delete(){}});
    await service.importMarkdown(randomUUID(),actor.localAccountId,markdownZip({"Quoted tags.md":"---\ntags: [\"research, design\", roadmap]\n---\n# Plan"}));
    assert.deepEqual(repository.committed!.state.notes[0]!.tags,[]);assert.match(repository.committed!.state.notes[0]!.content,/tags: \["research, design", roadmap\]/);
    assert.ok(repository.committed!.transformations!.some(({kind,reason})=>kind==="skipped"&&reason==="frontmatter_tags_unsupported"));
    assert.ok(!repository.committed!.transformations!.some(({reason})=>reason==="frontmatter_tags_extracted"));
  });
  it("extracts native Obsidian inline tags without treating code or link fragments as tags",async()=>{
    const repository=new ImportMemory();const service=new PortableWorkspaceImportService(repository,{async put(){},async get(){return Buffer.alloc(0)},async delete(){}});
    await service.importMarkdown(randomUUID(),actor.localAccountId,markdownZip({"Tags.md":"# Plan\nShip #project/roadmap and #ready-now. Keep `#inline-code`, [jump](#section), [[#Heading]], and:\n```txt\n#backtick-code\n````\n\n~~~txt\n#tilde-code\n~~~~"}));
    assert.deepEqual(repository.committed!.state.notes[0]!.tags,["project/roadmap","ready-now"]);
    assert.equal(repository.committed!.transformations!.filter(({reason})=>reason==="inline_tags_extracted").length,1);
  });
  it("imports an empty Markdown file as an untitled Note",async()=>{
    const repository=new ImportMemory();const service=new PortableWorkspaceImportService(repository,{async put(){},async get(){return Buffer.alloc(0)},async delete(){}});
    await service.importMarkdown(randomUUID(),actor.localAccountId,markdownZip({"Empty.md":""}));
    assert.equal(repository.committed!.state.notes[0]!.content,"# Untitled");
  });
  it("imports a zero-byte non-Markdown file as a reported Attachment",async()=>{
    const repository=new ImportMemory();const stored:Buffer[]=[];const service=new PortableWorkspaceImportService(repository,{async put(_key,content){stored.push(content)},async get(){return Buffer.alloc(0)},async delete(){}});
    await service.importMarkdown(randomUUID(),actor.localAccountId,markdownZip({"Home.md":"# Home","empty.txt":""}));
    assert.equal(repository.committed!.state.attachments.length,1);assert.equal(repository.committed!.state.attachments[0]!.filename,"empty.txt");assert.equal(repository.committed!.state.attachments[0]!.size,0);
    assert.deepEqual(stored,[Buffer.alloc(0)]);assert.ok(repository.committed!.transformations!.some(({object,reason})=>object==="Attachment:empty.txt"&&reason==="attachment_staged"));
  });
  it("rejects unsafe Markdown ZIP paths without repository or Attachment side effects",async()=>{
    const repository=new ImportMemory();let writes=0;const service=new PortableWorkspaceImportService(repository,{async put(){writes++},async get(){return Buffer.alloc(0)},async delete(){}});
    await assert.rejects(service.importMarkdown(randomUUID(),actor.localAccountId,markdownZip({"../escape.md":"# no"})),InvalidPortableWorkspaceImport);
    assert.equal(repository.committed,undefined);assert.equal(writes,0);
  });
  it("rejects Markdown archives whose combined expanded content exceeds the safe limit",async()=>{
    const repository=new ImportMemory();let writes=0;const service=new PortableWorkspaceImportService(repository,{async put(){writes++},async get(){return Buffer.alloc(0)},async delete(){}},{maxArchiveBytes:400,maxEntries:10,maxFileBytes:300});
    await assert.rejects(service.importMarkdown(randomUUID(),actor.localAccountId,markdownZip({"One.md":"# One\n"+"a".repeat(195),"Two.md":"# Two\n"+"b".repeat(195)},true)),PortableWorkspaceImportTooLarge);
    assert.equal(repository.committed,undefined);assert.equal(writes,0);
  });
  it("imports Markdown through a running Instance as the authenticated Member",async()=>{
    const repository=new ImportMemory();const service=new PortableWorkspaceImportService(repository,{async put(){},async get(){return Buffer.alloc(0)},async delete(){}});
    const instance=await startInstance({database:{async verifyConnection(){},async close(){}},host:"127.0.0.1",port:0,instanceAdminToken:"admin",portableWorkspaceImports:service,
      memberAccess:{async authenticateBearer(value){return value==="Bearer member"?{accountId:actor.localAccountId,sessionId:"session"}:undefined;}}});
    try{const archive=markdownZip({"Home.md":"# Home"});
      assert.equal((await fetch(`${instance.url}/api/workspace-imports/markdown`,{method:"POST",headers:{authorization:"Bearer admin","idempotency-key":randomUUID()},body:new Uint8Array(archive)})).status,401);
      const response=await fetch(`${instance.url}/api/workspace-imports/markdown`,{method:"POST",headers:{authorization:"Bearer member","idempotency-key":randomUUID()},body:new Uint8Array(archive)});
      assert.equal(response.status,201);assert.equal(repository.committed?.destinationOwnerAccountId,actor.localAccountId);
    }finally{await instance.close();}
  });
  it("keeps every published Portable Workspace Export schema in the compatibility registry", () => {
    assert.deepEqual(publishedPortableWorkspaceExportSchemas, ["stash.portable-workspace-export.v1"]);
  });
  it("preserves Note Tree location and semantic-link fields in canonical imports", async () => {
    const childId = "99999999-9999-4999-8999-999999999999";
    const linkId = "88888888-8888-4888-8888-888888888888";
    const source: PortableWorkspaceExportSnapshot = { ...snapshot,
      notes: [...snapshot.notes, { ...snapshot.notes[0]!, id: childId, content: "# Child" }],
      noteLocations: [snapshot.noteLocations[0]!, { schema: "stash.note-location.v1", noteId: childId, workspaceId,
        path: `notes/${childId}.md`, aliases: [], revision: 3, parentId: noteId, position: "2", archivedAt: "2026-02-01T00:00:00.000Z" }],
      noteLinks: [{ schema: "stash.note-link.v2", id: linkId, workspaceId, sourceNoteId: noteId, targetNoteId: childId,
        label: "Evidence", relationshipType: "supports", revision: 1 }],
    };
    const repository = new ImportMemory();
    const result = await new PortableWorkspaceImportService(repository, { async put() {}, async get() { return Buffer.alloc(0); }, async delete() {} })
      .import(randomUUID(), actor.localAccountId, await archiveFor(source));
    assert.equal(result.status, "imported");
    assert.deepEqual(repository.committed?.state.noteLocations[1], source.noteLocations[1]);
    assert.deepEqual(repository.committed?.state.noteLinks[0], source.noteLinks[0]);
  });
  it("round-trips stable relationship, word-cloud, and canvas Visualization Block definitions", async () => {
    const childId = "99999999-9999-4999-8999-999999999999";
    const blockId = "77777777-7777-4777-8777-777777777777";
    const visualization = { schema: "stash.visualization.v1", id: blockId, workspaceId, ownerNoteId: noteId, revision: 2,
      kind: "local-graph", query: { kind: "relationship", input: { rootId: noteId, depth: 2, limit: 30, direction: "both", relationTypes: ["supports"], includeHierarchy: true } },
      filters: { relationTypes: ["supports"], direction: "outgoing" }, layout: { kind: "focused", positions: { [noteId]: { x: 12, y: 18 } } },
      viewEdges: [{ id: "view-only", sourceNoteId: noteId, targetNoteId: childId, relationshipType: "questions" }] };
    const wordCloud = { schema: "stash.visualization.v1", id: "76767676-7676-4676-8676-767676767676", workspaceId,
      ownerNoteId: noteId, revision: 1, kind: "word-cloud",
      query: { kind: "aggregate", input: { field: "relationshipType", operation: "count", terms: ["supports"], limit: 30 } },
      filters: { terms: ["supports"] }, layout: { kind: "word-cloud", minFontSize: 12, maxFontSize: 48 }, viewEdges: [] };
    const canvas = { schema: "stash.visualization.v1", id: "75757575-7575-4575-8575-757575757575", workspaceId,
      ownerNoteId: noteId, revision: 3, kind: "canvas",
      query: { kind: "search", input: { text: "decision", terms: ["supports"], limit: 20 } }, filters: { terms: ["supports"] },
      layout: { kind: "spatial", positions: { [noteId]: { x: 4, y: 8 } } },
      viewEdges: [{ id: "canvas-view-only", sourceNoteId: noteId, targetNoteId: childId }] };
    const source: PortableWorkspaceExportSnapshot = { ...snapshot,
      notes: [...snapshot.notes, { ...snapshot.notes[0]!, id: childId, content: "# Child" }],
      noteLocations: [...snapshot.noteLocations, { schema: "stash.note-location.v1", noteId: childId, workspaceId,
        path: `notes/${childId}.md`, aliases: [], revision: 1 }],
      durableObjects: [{ kind: "VisualizationBlock", id: blockId, schema: "stash.visualization.v1", payload: visualization },
        { kind: "VisualizationBlock", id: wordCloud.id, schema: "stash.visualization.v1", payload: wordCloud },
        { kind: "VisualizationBlock", id: canvas.id, schema: "stash.visualization.v1", payload: canvas }],
    };
    const first = new ImportMemory();
    await new PortableWorkspaceImportService(first, { async put() {}, async get() { return Buffer.alloc(0); }, async delete() {} })
      .import(randomUUID(), actor.localAccountId, await archiveFor(source));
    assert.deepEqual(first.committed?.state.durableObjects, source.durableObjects);
    const second = new ImportMemory();
    await new PortableWorkspaceImportService(second, { async put() {}, async get() { return Buffer.alloc(0); }, async delete() {} })
      .import(randomUUID(), actor.localAccountId, await archiveFor({ ...first.committed!.state, attachments: [] }));
    assert.deepEqual(second.committed?.state.durableObjects, source.durableObjects);
  });
  it("round-trips canonical Collections and reusable Views with stable relation fallbacks", async () => {
    const collectionId = "31313131-3131-4131-8131-313131313131";
    const titleId = "32323232-3232-4232-8232-323232323232";
    const relationId = "33333333-3333-4333-8333-333333333334";
    const recordId = "34343434-3434-4434-8434-343434343434";
    const viewId = "35353535-3535-4535-8535-353535353535";
    const collection = { schema: "stash.collection.v1" as const, id: collectionId, workspaceId, ownerNoteId: noteId,
      title: "Research", properties: [{ id: titleId, name: "Idea", type: "text" as const, position: 1 },
        { id: relationId, name: "Source", type: "relation" as const, position: 2, target: { kind: "notes" as const } }],
      records: [{ id: recordId, position: 1, values: { [titleId]: "Map constraints",
        [relationId]: [{ id: noteId, fallback: "Durable source name" }] } }] };
    const view = { schema: "stash.view-block.v1" as const, id: viewId, workspaceId, ownerNoteId: noteId,
      blockId: "36363636-3636-4636-8636-363636363636", title: "Research board", definition: {
        source: { kind: "collection" as const, collectionId }, presentation: "board" as const, filters: [], sorts: [],
        groupBy: relationId, layout: { density: "compact" }, focused: { recordId },
      } };
    const durableObjects = [{ kind: "Collection", id: collectionId, schema: collection.schema, payload: collection },
      { kind: "ViewBlock", id: viewId, schema: view.schema, payload: view }];
    const source: PortableWorkspaceExportSnapshot = { ...snapshot, attachments: [], durableObjects };
    const first = new ImportMemory();
    await new PortableWorkspaceImportService(first, { async put() {}, async get() { return Buffer.alloc(0); }, async delete() {} })
      .import(randomUUID(), actor.localAccountId, await archiveFor(source));
    assert.deepEqual(first.committed?.state.durableObjects, durableObjects);
    const second = new ImportMemory();
    await new PortableWorkspaceImportService(second, { async put() {}, async get() { return Buffer.alloc(0); }, async delete() {} })
      .import(randomUUID(), actor.localAccountId, await archiveFor({ ...first.committed!.state, attachments: [] }));
    assert.deepEqual(second.committed?.state.durableObjects, durableObjects);
  });
  it("round-trips a canceled Workspace Task through its canonical Workspace Workflow", async () => {
    const workflowId = "41414141-4141-4141-8141-414141414141";
    const statusId = "42424242-4242-4242-8242-424242424242";
    const taskId = "43434343-4343-4343-8343-434343434343";
    const source: PortableWorkspaceExportSnapshot = { ...snapshot, attachments: [],
      tasks: [{ schema: "stash.task.v1", id: taskId, workspaceId, title: "Canceled starter task",
        status: { id: statusId, name: "Canceled", category: "canceled" }, sourceNoteIds: [noteId],
        createdAt: "2026-01-03T00:00:00.000Z", createdBy: actor }],
      durableObjects: [{ kind: "WorkspaceWorkflow", id: workflowId, schema: "stash.workspace-workflow.v1",
        payload: { schema: "stash.workspace-workflow.v1", id: workflowId, workspaceId,
          statuses: [{ id: statusId, name: "Canceled", category: "canceled", position: 1 }] } }],
    };
    const first = new ImportMemory();
    await new PortableWorkspaceImportService(first, { async put() {}, async get() { return Buffer.alloc(0); }, async delete() {} })
      .import(randomUUID(), actor.localAccountId, await archiveFor(source));
    assert.equal(first.committed?.state.tasks[0]?.status.category, "canceled");
    const second = new ImportMemory();
    await new PortableWorkspaceImportService(second, { async put() {}, async get() { return Buffer.alloc(0); }, async delete() {} })
      .import(randomUUID(), actor.localAccountId, await archiveFor({ ...first.committed!.state, attachments: [] }));
    assert.equal(second.committed?.state.tasks[0]?.status.category, "canceled");
    assert.equal((second.committed?.state.durableObjects[0]?.payload as any).statuses[0].category, "canceled");
  });
  it("round-trips canonical semantics and Attachment bytes through a running Instance, preserving missing people as Identity Stubs", async () => {
    const repository = new ImportMemory(); const database = { async verifyConnection() {}, async close() {} };
    const instance = await startInstance({ database, host: "127.0.0.1", port: 0, instanceAdminToken: "admin",
      portableWorkspaceImports: new PortableWorkspaceImportService(repository, { async put() {}, async get() { return Buffer.alloc(0); }, async delete() {} }) });
    try {
      const importId = randomUUID(); const exported = await archive();
      const response = await fetch(`${instance.url}/api/workspace-imports`, { method: "POST",
        headers: { authorization: "Bearer admin", "idempotency-key": importId, "x-stash-import-owner-account-id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "content-type": "application/zip" }, body: new Uint8Array(exported) });
      assert.equal(response.status, 201); const result = await response.json() as any;
      assert.equal(result.status, "imported"); assert.deepEqual(result.report.identityStubs, [{ sourceAccountId: actor.localAccountId, displayName: "Ada Lovelace" }]);
      assert.deepEqual(repository.committed?.state, { workspace: snapshot.workspace, notes: snapshot.notes, tasks: [], boards: [],
        attachments: snapshot.attachments.map(({ projection }) => projection), noteLocations: snapshot.noteLocations, noteLinks: [], activities: [], noteHistory: [], durableObjects: [] });
      assert.deepEqual(repository.committed?.attachmentContent.get(snapshot.attachments[0]!.projection.id), Buffer.from([1, 2, 3]));
      const duplicate = await fetch(`${instance.url}/api/workspace-imports`, { method: "POST",
        headers: { authorization: "Bearer admin", "idempotency-key": importId, "x-stash-import-owner-account-id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }, body: new Uint8Array(exported) });
      assert.equal(duplicate.status, 200); assert.equal((await duplicate.json() as any).status, "duplicate");
      const mappingId=randomUUID(); const mappingBody={importId,sourceAccountId:actor.localAccountId,localAccountId:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"};
      const mapped=await fetch(`${instance.url}/api/workspace-import-identity-mappings`,{method:"POST",headers:{authorization:"Bearer admin","idempotency-key":mappingId,"content-type":"application/json"},body:JSON.stringify(mappingBody)});
      assert.equal(mapped.status,201); assert.equal((await mapped.json() as any).status,"mapped");
      const replay=await fetch(`${instance.url}/api/workspace-import-identity-mappings`,{method:"POST",headers:{authorization:"Bearer admin","idempotency-key":mappingId,"content-type":"application/json"},body:JSON.stringify(mappingBody)});
      assert.equal(replay.status,200);
    } finally { await instance.close(); }
  });

  it("export-import-exports legacy and departed-member v1 fields without changing their semantics", async () => {
    const projectId="44444444-4444-4444-8444-444444444444"; const statusId="55555555-5555-4555-8555-555555555555";
    const taskId="66666666-6666-4666-8666-666666666666"; const connectionId="77777777-7777-4777-8777-777777777777";
    const organization={localOrganizationId:"88888888-8888-4888-8888-888888888888",displayName:"Source"};
    const baseTask={schema:"stash.task.v1" as const,id:taskId,workspaceId,projectId,key:"PRJ-1",title:"Portable assignment",
      status:{id:statusId,name:"Ready",category:"unstarted" as const},sourceNoteIds:[noteId],createdAt:"2026-01-02T00:00:00.000Z",createdBy:actor};
    const baseConnection={schema:"stash.repository-connection.v1",id:connectionId,provider:"github",repositoryUrl:"https://github.example/org/repo",
      organization,createdBy:{...actor,attribution:"recorded"},projectIds:[projectId]};
    for (const variant of [
      {name:"legacy",task:baseTask,connection:baseConnection},
      {name:"departed",task:{...baseTask,assigneeIds:[actor.localAccountId],formerAssigneeIds:[actor.localAccountId]},
        connection:{...baseConnection,ownership:"personal",state:"degraded"}},
    ]) {
      const source:PortableWorkspaceExportSnapshot={...snapshot,workspace:{...snapshot.workspace,owner:{type:"organization",identity:organization}},
        notes:[{...snapshot.notes[0]!,projectId}],tasks:[variant.task],durableObjects:[
          {kind:"Project",id:projectId,schema:"stash.project.v1",payload:{schema:"stash.project.v1",id:projectId,workspaceId,name:"Project",key:"PRJ",createdBy:actor}},
          {kind:"Workflow",id:projectId,schema:"stash.workflow.v1",payload:{schema:"stash.workflow.v1",projectId,revision:1,statuses:[{id:statusId,name:"Ready",category:"unstarted",position:0,archived:false}]}},
          {kind:"RepositoryConnection",id:connectionId,schema:"stash.repository-connection.v1",payload:variant.connection},
        ]};
      const repository=new ImportMemory(); const storage={async put(){},async get(){return Buffer.from([1,2,3]);},async delete(){}};
      const imported=await new PortableWorkspaceImportService(repository,storage).import(randomUUID(),actor.localAccountId,await archiveFor(source));
      assert.equal(imported.status,"imported",variant.name); const state=repository.committed!.state;
      const reexported=await new PortableWorkspaceExportService({async readExportSnapshot(){return {status:"found" as const,
        snapshot:{...state,attachments:state.attachments.map((projection)=>({projection,content:Buffer.from([1,2,3])}))}};}},storage)
        .export("member",workspaceId);
      assert.equal(reexported.status,"exported",variant.name); if(reexported.status!=="exported") continue;
      const canonical=JSON.parse(storedFiles(reexported.archive).get("objects/workspace.json")!.toString());
      assert.deepEqual(canonical.tasks[0],variant.task,variant.name);
      assert.deepEqual(canonical.durableObjects.find(({kind}:any)=>kind==="RepositoryConnection").payload,variant.connection,variant.name);
    }
  });

  it("makes authorization, corruption, unsupported legacy archives, and recoverable failure atomic and visible", async () => {
    const repository = new ImportMemory(); const database = { async verifyConnection() {}, async close() {} }; const staged = new Set<string>();
    const instance = await startInstance({ database, host: "127.0.0.1", port: 0, instanceAdminToken: "admin",
      portableWorkspaceImports: new PortableWorkspaceImportService(repository, { async put(key) { staged.add(key); }, async get() { return Buffer.alloc(0); }, async delete(key) { staged.delete(key); } }) });
    try {
      const exported = await archive(); const headers = { authorization: "Bearer admin", "idempotency-key": randomUUID(), "x-stash-import-owner-account-id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
      assert.equal((await fetch(`${instance.url}/api/workspace-imports`, { method: "POST", body: new Uint8Array(exported) })).status, 401);
      assert.equal((await fetch(`${instance.url}/api/v1/workspace-imports`, { method: "POST", headers, body: new Uint8Array(exported) })).status, 404);
      assert.equal((await fetch(`${instance.url}/api/v1/workspace-import-identity-mappings`, { method:"POST",headers:{authorization:"Bearer admin","idempotency-key":randomUUID(),"content-type":"application/json"},body:"{}"})).status,404);
      const unsafeActivity={...snapshot,activities:[{schema:"stash.activity.v1" as const,id:"99999999-9999-4999-8999-999999999999",workspaceId,
        object:{kind:"Note" as const,id:noteId},action:"note_created",actor,cause:{kind:"member" as const},occurredAt:"2026-01-01T00:00:00.000Z",
        before:{metadata:{client_secret:"must-not-cross"}},after:{}}]};
      const unsafeResponse=await fetch(`${instance.url}/api/workspace-imports`,{method:"POST",headers:{...headers,"idempotency-key":randomUUID()},body:new Uint8Array(await archiveFor(unsafeActivity))});
      assert.equal(unsafeResponse.status,422); assert.equal(repository.committed,undefined);
      const corrupt = Buffer.from(exported); const marker = corrupt.indexOf(Buffer.from("objects/workspace.json")); assert.ok(marker > 0);
      corrupt.writeUInt8(corrupt.readUInt8(marker + 2) ^ 1, marker + 2);
      assert.equal((await fetch(`${instance.url}/api/workspace-imports`, { method: "POST", headers, body: new Uint8Array(corrupt) })).status, 422);
      assert.equal(repository.committed, undefined);
      repository.fail = true; const failed = await fetch(`${instance.url}/api/workspace-imports`, { method: "POST",
        headers: { ...headers, "idempotency-key": randomUUID() }, body: new Uint8Array(exported) });
      assert.equal(failed.status, 503); assert.deepEqual(await failed.json(), { error: "import_unavailable", message: "The Workspace import could not be completed. Nothing was imported." });
      assert.deepEqual([...staged], []);
    } finally { await instance.close(); }
  });

  it("returns 422 for adversarial credential keys before persistence and re-imports benign free-form state", async () => {
    const repository=new ImportMemory(); const database={async verifyConnection(){},async close(){}};
    const instance=await startInstance({database,host:"127.0.0.1",port:0,instanceAdminToken:"admin",
      portableWorkspaceImports:new PortableWorkspaceImportService(repository,{async put(){},async get(){return Buffer.alloc(0);},async delete(){}})});
    const activity={schema:"stash.activity.v1" as const,id:"99999999-9999-4999-8999-999999999999",workspaceId,
      object:{kind:"Note" as const,id:noteId},action:"note_created",actor,cause:{kind:"member" as const},occurredAt:"2026-01-01T00:00:00.000Z",before:{},after:{}};
    try {
      for(const key of credentialKeys) { const unsafe={...snapshot,activities:[{...activity,before:{nested:{[key]:"must-not-cross"}}}]};
        const response=await fetch(`${instance.url}/api/workspace-imports`,{method:"POST",headers:{authorization:"Bearer admin","idempotency-key":randomUUID(),
          "x-stash-import-owner-account-id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"},body:new Uint8Array(await archiveFor(unsafe))});
        assert.equal(response.status,422,key); assert.equal(repository.committed,undefined,`${key} must not persist`); }
      const safe={...snapshot,activities:[{...activity,before:benignActivityState}]};
      const response=await fetch(`${instance.url}/api/workspace-imports`,{method:"POST",headers:{authorization:"Bearer admin","idempotency-key":randomUUID(),
        "x-stash-import-owner-account-id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"},body:new Uint8Array(await archiveFor(safe))});
      assert.equal(response.status,201); assert.deepEqual(repository.committed?.state.activities[0]?.before,benignActivityState);
    } finally { await instance.close(); }
  });

  it("rejects validly checksummed canonical state with dangling relationships or Attachment aliasing before persistence", async () => {
    const repository = new ImportMemory(); const storage = { async put() { throw new Error("must_not_write"); }, async get() { return Buffer.alloc(0); }, async delete() {} };
    const service = new PortableWorkspaceImportService(repository, storage);
    const dangling = { ...snapshot, notes: [{ ...snapshot.notes[0]!, projectId: "99999999-9999-4999-8999-999999999999" }] };
    const danglingArchive = await archiveFor(dangling);
    await assert.rejects(() => service.import(randomUUID(), "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", danglingArchive), /invalid_note/);
    const aliased = { ...snapshot, attachments: [{ ...snapshot.attachments[0]!, projection: {
      ...snapshot.attachments[0]!.projection, relativePath: `./attachments/${snapshot.attachments[0]!.projection.id}/different.bin` } }] };
    const aliasedArchive = await archiveFor(aliased);
    await assert.rejects(() => service.import(randomUUID(), "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", aliasedArchive), /invalid_attachment_path/);
    const projectId="44444444-4444-4444-8444-444444444444";
    const secretBearing={...snapshot,durableObjects:[
      {kind:"Project",id:projectId,schema:"stash.project.v1",payload:{schema:"stash.project.v1",id:projectId,workspaceId,name:"Project",key:"PRJ",createdBy:actor}},
      {kind:"RepositoryConnection",id:"55555555-5555-4555-8555-555555555555",schema:"stash.repository-connection.v1",payload:{schema:"stash.repository-connection.v1",id:"55555555-5555-4555-8555-555555555555",provider:"github",repositoryUrl:"https://github.example/org/repo",organization:{localOrganizationId:"66666666-6666-4666-8666-666666666666",displayName:"Org"},createdBy:{...actor,attribution:"recorded"},projectIds:[projectId],installationId:12345}},
    ]};
    const secretArchive=await archiveFor(secretBearing);
    await assert.rejects(()=>service.import(randomUUID(),"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",secretArchive),/invalid_repository_connection/);
    assert.equal(repository.committed,undefined);
  });

  it("rejects normalized credential-bearing keys in free-form Activity state while preserving ordinary domain keys", async () => {
    const activity = { schema:"stash.activity.v1" as const,id:"99999999-9999-4999-8999-999999999999",workspaceId,
      object:{kind:"Note" as const,id:noteId},action:"note_created",actor,cause:{kind:"member" as const},
      occurredAt:"2026-01-01T00:00:00.000Z",before:{},after:{} };
    for (const key of credentialKeys) {
      const repository=new ImportMemory(); const service=new PortableWorkspaceImportService(repository,{async put(){},async get(){return Buffer.alloc(0);},async delete(){}});
      const unsafe={...snapshot,activities:[{...activity,before:{metadata:{[key]:"must-not-cross"}}}]};
      const unsafeArchive=await archiveFor(unsafe);
      await assert.rejects(()=>service.import(randomUUID(),"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",unsafeArchive),/non_portable_secret/);
      assert.equal(repository.committed,undefined,`${key} must be rejected before persistence`);
    }
    const repository=new ImportMemory(); const service=new PortableWorkspaceImportService(repository,{async put(){},async get(){return Buffer.alloc(0);},async delete(){}});
    const safe={...snapshot,activities:[{...activity,before:benignActivityState}]};
    assert.equal((await service.import(randomUUID(),"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",await archiveFor(safe))).status,"imported");
    assert.deepEqual(repository.committed?.state.activities[0]?.before,safe.activities[0]!.before);
  });
});

const postgresUrl = process.env.STASH_TEST_DATABASE_URL;
describe("PostgreSQL Portable Workspace import", { skip: postgresUrl ? false : "STASH_TEST_DATABASE_URL is not configured" }, () => {
  it("imports atomically into a clean running Instance and re-exports the same canonical state and Attachment", async () => {
    const connectionString = postgresUrl!; const admin = new Pool({ connectionString }); const schema = `workspace_import_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE SCHEMA ${schema}`); const separator = connectionString.includes("?") ? "&" : "?";
    const database = new PostgresDatabase(`${connectionString}${separator}options=-csearch_path%3D${schema}`,
      createAuthenticationSecretCodec(randomBytes(32).toString("base64")));
    const ownerId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"; const localGuestId = "abababab-abab-4bab-8bab-abababababab";
    const storage = new LocalAttachmentStorage(await mkdtemp(join(tmpdir(), "stash-import-pg-")));
    let instance: Awaited<ReturnType<typeof startInstance>> | undefined;
    try {
      await database.createFirstOrganizationOwner({ organizationId: randomUUID(), organizationName: "Destination", ownerId, ownerName: "Grace",
        ownerEmail: "grace@example.test", passwordHash: "test", role: "Owner" });
      instance = await startInstance({ database, host: "127.0.0.1", port: 0, instanceAdminToken: "admin",
        memberAccess: { async authenticateBearer(value) { return value === "Bearer owner" ? { accountId: ownerId, sessionId: "owner" }
          : value === "Bearer local-guest" ? { accountId: localGuestId, sessionId: "local-guest" } : undefined; } },
        portableWorkspaceImports: new PortableWorkspaceImportService(database, storage), portableWorkspaceExports: new PortableWorkspaceExportService(database, storage) });
      const projectId = "44444444-4444-4444-8444-444444444444"; const statusId = "55555555-5555-4555-8555-555555555555";
      const taskId = "66666666-6666-4666-8666-666666666666"; const boardId = "77777777-7777-4777-8777-777777777777";
      const departedTaskId = "12121212-1212-4212-8212-121212121212";
      const linkId = "88888888-8888-4888-8888-888888888888"; const activityId = "99999999-9999-4999-8999-999999999999";
      const guest = { localAccountId:"cccccccc-cccc-4ccc-8ccc-cccccccccccc",displayName:"Guest" };
      const rich: PortableWorkspaceExportSnapshot = { ...snapshot,
        workspace:{...snapshot.workspace,owner:{type:"organization",identity:{localOrganizationId:"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",displayName:"Source"}}},
        notes:[{...snapshot.notes[0]!,projectId}],
        tasks:[{schema:"stash.task.v1",id:taskId,workspaceId,projectId,key:"PRJ-1",title:"Round trip",status:{id:statusId,name:"Ready",category:"unstarted"},
          sourceNoteIds:[noteId],linkedNoteIds:[noteId],dependencies:[],createdAt:"2026-01-02T00:00:00.000Z",createdBy:actor},
        {schema:"stash.task.v1",id:departedTaskId,workspaceId,projectId,key:"PRJ-2",title:"Reassign departed work",
          status:{id:statusId,name:"Ready",category:"unstarted"},sourceNoteIds:[noteId],assigneeIds:[actor.localAccountId],
          formerAssigneeIds:[actor.localAccountId],linkedNoteIds:[],dependencies:[],createdAt:"2026-01-03T00:00:00.000Z",createdBy:actor}],
        boards:[{schema:"stash.board.v1",id:boardId,projectId,name:"Plan",groupBy:"status",createdAt:"2026-01-02T00:00:00.000Z"}],
        noteLinks:[{schema:"stash.note-link.v2",id:linkId,workspaceId,sourceNoteId:noteId,targetNoteId:noteId,targetPath:`notes/${noteId}.md`,candidateNoteIds:[],label:"Self",revision:1}],
        activities:[{schema:"stash.activity.v1",id:activityId,workspaceId,object:{kind:"Note",id:noteId},action:"note_created",actor,
          cause:{kind:"member"},occurredAt:"2026-01-01T00:00:00.000Z",before:{},after:{revision:1}}],
        noteHistory:[{noteId,workspaceId,revision:1,content:"# Durable",document:markdownToRichText("# Durable"),recordedAt:"2026-01-01T00:00:00.000Z",actor,cause:{kind:"member"}}],
        durableObjects:[
          {kind:"Project",id:projectId,schema:"stash.project.v1",payload:{schema:"stash.project.v1",id:projectId,workspaceId,name:"Project",key:"PRJ",createdBy:actor}},
          {kind:"Workflow",id:projectId,schema:"stash.workflow.v1",payload:{schema:"stash.workflow.v1",projectId,revision:1,statuses:[{id:statusId,name:"Ready",category:"unstarted",position:0,archived:false}]}},
          {kind:"GuestProjectAccess",id:"dddddddd-dddd-4ddd-8ddd-dddddddddddd",schema:"stash.guest-project-access.v1",payload:{schema:"stash.guest-project-access.v1",id:"dddddddd-dddd-4ddd-8ddd-dddddddddddd",organizationId:"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",guest,projects:[{projectId,workspaceId}],acceptedAt:"2026-01-01T00:00:00.000Z",invitedBy:actor}},
          {kind:"RepositoryConnection",id:"ffffffff-ffff-4fff-8fff-ffffffffffff",schema:"stash.repository-connection.v1",payload:{schema:"stash.repository-connection.v1",id:"ffffffff-ffff-4fff-8fff-ffffffffffff",provider:"github",repositoryUrl:"https://github.example/org/repo",organization:{localOrganizationId:"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",displayName:"Source"},createdBy:{...actor,attribution:"recorded"},projectIds:[projectId]}},
          {kind:"RepositoryConnection",id:"13131313-1313-4313-8313-131313131313",schema:"stash.repository-connection.v1",payload:{schema:"stash.repository-connection.v1",id:"13131313-1313-4313-8313-131313131313",provider:"github",repositoryUrl:"https://github.example/org/personal-repo",organization:{localOrganizationId:"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",displayName:"Source"},createdBy:{...actor,attribution:"recorded"},projectIds:[projectId],ownership:"personal",state:"degraded"}},
        ] };
      const exported = await archiveFor(rich); const importId = randomUUID();
      const imported = await fetch(`${instance.url}/api/workspace-imports`, { method: "POST", headers: { authorization: "Bearer admin",
        "idempotency-key": importId, "x-stash-import-owner-account-id": ownerId }, body: new Uint8Array(exported) });
      assert.equal(imported.status, 201); const importBody=await imported.json() as any; assert.equal(importBody.report.identityStubs.length, 2);
      assert.ok(importBody.report.transformed.some(({object,reason}:any)=>object===`Workspace:${workspaceId}`&&reason===`ownership_mapped:${ownerId}`));
      assert.ok(importBody.report.transformed.some(({object,reason}:any)=>object==="RepositoryConnection:ffffffff-ffff-4fff-8fff-ffffffffffff"&&reason==="credentials_not_portable"));
      const reexport = await fetch(`${instance.url}/api/workspaces/${workspaceId}/export`, { headers: { authorization: "Bearer owner" } });
      assert.equal(reexport.status, 200); const files = storedFiles(Buffer.from(await reexport.arrayBuffer()));
      const reexportedState=JSON.parse(files.get("objects/workspace.json")!.toString());
      assert.deepEqual(reexportedState, { workspace: {...rich.workspace,owner:{type:"personal",identity:{localAccountId:ownerId,displayName:"Grace"}}}, notes: rich.notes,
        tasks: rich.tasks, boards: rich.boards, attachments: rich.attachments.map(({ projection }) => projection), noteLocations: rich.noteLocations,
        noteLinks: rich.noteLinks, activities: rich.activities, noteHistory: rich.noteHistory,
        durableObjects: rich.durableObjects!.map((item)=>item.kind==="RepositoryConnection"?{...item,schema:"stash.disconnected-repository-connection.v1",payload:{...(item.payload as object),schema:"stash.disconnected-repository-connection.v1",state:"disconnected",reason:"credentials_not_portable"}}:item)
          .sort((left,right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`)) });
      const reexportedDepartedTask=reexportedState.tasks.find(({id}:any)=>id===departedTaskId) as any;
      const reexportedPersonalConnection=reexportedState.durableObjects.find(
        ({id}:any)=>id==="13131313-1313-4313-8313-131313131313") as any;
      assert.deepEqual(reexportedDepartedTask.formerAssigneeIds,[actor.localAccountId]);
      assert.equal(reexportedPersonalConnection.payload.ownership,"personal");
      assert.deepEqual(files.get(snapshot.attachments[0]!.projection.relativePath.slice(2)), Buffer.from([1,2,3]));
      await admin.query(`INSERT INTO ${schema}.stash_accounts(id,name,email,password_hash) VALUES($1,$2,$3,$4)`,
        [localGuestId,"Local Guest","local-guest@example.test","not-used"]);
      const mapActorKey=randomUUID(); const mapActorBody={importId,sourceAccountId:actor.localAccountId,localAccountId:ownerId};
      const mappedActor=await fetch(`${instance.url}/api/workspace-import-identity-mappings`,{method:"POST",headers:{authorization:"Bearer admin","idempotency-key":mapActorKey,"content-type":"application/json"},body:JSON.stringify(mapActorBody)});
      assert.equal(mappedActor.status,201);
      const replayActor=await fetch(`${instance.url}/api/workspace-import-identity-mappings`,{method:"POST",headers:{authorization:"Bearer admin","idempotency-key":mapActorKey,"content-type":"application/json"},body:JSON.stringify(mapActorBody)});
      assert.equal(replayActor.status,200); assert.equal((await replayActor.json() as any).status,"duplicate");
      const mappedGuest=await fetch(`${instance.url}/api/workspace-import-identity-mappings`,{method:"POST",headers:{authorization:"Bearer admin","idempotency-key":randomUUID(),"content-type":"application/json"},body:JSON.stringify({importId,sourceAccountId:guest.localAccountId,localAccountId:localGuestId})});
      assert.equal(mappedGuest.status,201);
      const attributed=await fetch(`${instance.url}/api/workspaces/${workspaceId}/export`,{headers:{authorization:"Bearer owner"}});
      const attributedState=JSON.parse(storedFiles(Buffer.from(await attributed.arrayBuffer())).get("objects/workspace.json")!.toString());
      const localOwner={localAccountId:ownerId,displayName:"Grace"};
      assert.deepEqual(attributedState.notes[0].createdBy,localOwner); assert.deepEqual(attributedState.tasks[0].createdBy,localOwner);
      assert.deepEqual(attributedState.activities[0].actor,localOwner); assert.deepEqual(attributedState.noteHistory[0].actor,localOwner);
      assert.equal((await fetch(`${instance.url}/api/workspaces/${workspaceId}/export`,{headers:{authorization:"Bearer local-guest"}})).status,200);
      const duplicate = await fetch(`${instance.url}/api/workspace-imports`, { method:"POST", headers:{ authorization:"Bearer admin",
        "idempotency-key":importId,"x-stash-import-owner-account-id":ownerId },body:new Uint8Array(exported) });
      assert.equal(duplicate.status,200);
    } finally { await instance?.close().catch(() => undefined); if (!instance) await database.close().catch(() => undefined);
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined); await admin.end(); }
  });
});

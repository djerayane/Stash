import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { inflateRawSync } from "node:zlib";

import { encodePortableFilename, type AttachmentStorage } from "./attachments.js";
import type { PortableWorkspaceCanonicalState } from "./portable-workspace-export.js";
import { isRichTextDocument, markdownToRichText } from "./rich-text.js";
import { normalizeVisualizationDefinition } from "@stash/domain-types";

export interface ImportTransformation { kind: "transformed" | "skipped" | "ambiguous"; object: string; reason: string }
export interface IdentityStub { sourceAccountId: string; displayName: string }
export interface PortableWorkspaceImportReport {
  schema: "stash.portable-workspace-import-report.v1";
  importId: string;
  workspaceId: string;
  archiveSha256: string;
  transformations: ImportTransformation[];
  transformed: ImportTransformation[];
  skipped: ImportTransformation[];
  ambiguous: ImportTransformation[];
  identityStubs: IdentityStub[];
}
export interface PortableWorkspaceImportBundle {
  state: PortableWorkspaceCanonicalState;
  attachmentContent: Map<string, Buffer>;
  identityStubs: IdentityStub[];
  archiveSha256: string;
  destinationOwnerAccountId: string;
  attachmentStorageKeys: Map<string, string>;
  transformations?: ImportTransformation[];
}
export interface PortableWorkspaceImportRepository {
  findWorkspaceImport(importId: string): Promise<{ archiveSha256: string; report: PortableWorkspaceImportReport } | undefined>;
  importWorkspace(importId: string, bundle: PortableWorkspaceImportBundle): Promise<
    | { status: "imported"; report: PortableWorkspaceImportReport }
    | { status: "duplicate"; report: PortableWorkspaceImportReport }
    | { status: "forbidden" }
    | { status: "workspace_conflict" }
  >;
  mapImportedIdentity(input: { importId: string; sourceAccountId: string; localAccountId: string; idempotencyKey: string }): Promise<
    | { status: "mapped" | "duplicate"; sourceAccountId: string; localAccountId: string }
    | { status: "not_found" | "conflict" | "local_account_not_found" }>;
}

export class InvalidPortableWorkspaceImport extends Error {}
export class PortableWorkspaceImportTooLarge extends Error {}
export class UnsupportedPortableWorkspaceImport extends Error {}

/** Every published schema remains listed here and covered by import acceptance tests. */
export const publishedPortableWorkspaceExportSchemas = ["stash.portable-workspace-export.v1"] as const;

interface Entry { path: string; content: Buffer }
interface Manifest { schema: string; workspace: unknown; files: Array<{ path: string; bytes: number; sha256: string }> }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digest = /^[0-9a-f]{64}$/;
function safePath(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") && !path.includes("\\") && !path.includes("\0")
    && !path.split("/").some((part) => part === "" || part === "." || part === "..");
}
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function portableIdentity(value: unknown): value is { localAccountId: string; displayName: string } { return object(value) && typeof value.localAccountId === "string" && typeof value.displayName === "string"; }
const timestamp = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));
const unique = (values: string[]) => new Set(values).size === values.length;
function ids(items: unknown[], key = "id"): string[] {
  return items.map((item) => object(item) && typeof item[key] === "string" ? item[key] : "");
}
const onlyKeys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every((key) => allowed.includes(key));
function exact(value: unknown, allowed: string[], kind: string): asserts value is Record<string, unknown> {
  if (!object(value) || !onlyKeys(value, allowed)) throw new InvalidPortableWorkspaceImport(`invalid_${kind}`);
}
function exactIdentity(value: unknown, kind: string): asserts value is { localAccountId: string; displayName: string } {
  exact(value,["localAccountId","displayName"],kind); if (!portableIdentity(value) || !uuid.test(value.localAccountId))
    throw new InvalidPortableWorkspaceImport(`invalid_${kind}`);
}
const exactSecretKeys=new Set(["auth","authorization","bearer","cookie","credentials","credential","password","passphrase",
  "secret","session","sessionid","token","privatekey","installationid"]);
const credentialKeyFamily=/^(?:.*clientsecret|x?api(?:secret|key|token|credentials?)(?:id)?|.*oauth(?:secret|key|token|credentials?)|(?:auth|authentication)(?:secret|key|token|credentials?|authorization|cookie|session|header)(?:id)?|.*(?:access|refresh)token|(?:identity|id|bearer|session)(?:token|key|secret|cookie|id)|cookie(?:header|jar|value)|private(?:key|secret|credentials?|token)|secretkey|proxyauthorization|setcookie)$/;
const benignPortableKeys=new Set(["tokenestimate","authenticationmethod","sessionduration","cookiepolicy","privateproject","apiversion"]);
function rejectSensitiveKeys(value: unknown): void {
  if (Array.isArray(value)) { for (const child of value) rejectSensitiveKeys(child); return; }
  if (!object(value)) return;
  for (const [key, child] of Object.entries(value)) {
    // Normalize casing and separators so spelling variants cannot bypass the
    // portable-content boundary. Keep the patterns structural: ordinary keys
    // such as `sessionDuration`, `cookiePolicy`, and `tokenEstimate` are valid.
    const normalized=key.normalize("NFKC").replace(/[^a-z0-9]/gi,"").toLowerCase();
    const broadCredentialFamily=normalized.includes("password") || normalized.includes("passphrase") || normalized.includes("credential")
      || /(?:secret|token)$/.test(normalized) || /(?:encryption|signing|private)key/.test(normalized);
    if (!benignPortableKeys.has(normalized) && (broadCredentialFamily || exactSecretKeys.has(normalized) || credentialKeyFamily.test(normalized)))
      throw new InvalidPortableWorkspaceImport("non_portable_secret");
    rejectSensitiveKeys(child);
  }
}
function exactCause(value: unknown, kind: string): void {
  if (!object(value) || !["member","automation","signal","agent","migration"].includes(String(value.kind)))
    throw new InvalidPortableWorkspaceImport(`invalid_${kind}`);
  const keys: Record<string,string[]> = { member:["kind","restorationOfRevision","automationId","signalId"], automation:["kind","automationId","signalId"],
    signal:["kind","signalId"], agent:["kind","agentGrantId","sponsoringMemberId"], migration:["kind","source"] };
  exact(value,keys[String(value.kind)]!,kind);
  if (value.kind === "member" && value.restorationOfRevision !== undefined && (!Number.isInteger(value.restorationOfRevision) || Number(value.restorationOfRevision) < 1)
    || value.kind === "automation" && (!uuid.test(String(value.automationId)) || value.signalId !== undefined && !uuid.test(String(value.signalId)))
    || value.kind === "member" && (value.automationId !== undefined && !uuid.test(String(value.automationId)) || value.signalId !== undefined && !uuid.test(String(value.signalId)))
    || value.kind === "signal" && !uuid.test(String(value.signalId))
    || value.kind === "agent" && (!uuid.test(String(value.agentGrantId)) || !uuid.test(String(value.sponsoringMemberId)))
    || value.kind === "migration" && value.source !== "existing_note") throw new InvalidPortableWorkspaceImport(`invalid_${kind}`);
}

function unzipStored(archive: Buffer, limits: { maxEntries: number; maxFileBytes: number; maxArchiveBytes?:number }): Entry[] {
  if (archive.length < 22) throw new InvalidPortableWorkspaceImport("missing_zip_directory");
  let end = -1;
  for (let offset = archive.length - 22; offset >= Math.max(0, archive.length - 65_557); offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50) { end = offset; break; }
  }
  if (end < 0) throw new InvalidPortableWorkspaceImport("missing_zip_directory");
  let entries = archive.readUInt16LE(end + 10); let directorySize = archive.readUInt32LE(end + 12);
  let directoryOffset = archive.readUInt32LE(end + 16); let directoryEnd = end;
  if (entries === 0xffff) {
    const locator = end - 20;
    if (locator < 0 || archive.readUInt32LE(locator) !== 0x07064b50) throw new InvalidPortableWorkspaceImport("invalid_zip64_locator");
    const zip64End = Number(archive.readBigUInt64LE(locator + 8));
    if (!Number.isSafeInteger(zip64End) || zip64End + 56 !== locator || archive.readUInt32LE(zip64End) !== 0x06064b50)
      throw new InvalidPortableWorkspaceImport("invalid_zip64_directory");
    entries = Number(archive.readBigUInt64LE(zip64End + 32));
    directorySize = Number(archive.readBigUInt64LE(zip64End + 40)); directoryOffset = Number(archive.readBigUInt64LE(zip64End + 48));
    if (![entries, directorySize, directoryOffset].every(Number.isSafeInteger)) throw new PortableWorkspaceImportTooLarge("zip64_limit");
    directoryEnd = zip64End;
  }
  if (entries > limits.maxEntries) throw new PortableWorkspaceImportTooLarge("too_many_entries");
  if (directoryOffset + directorySize !== directoryEnd) throw new InvalidPortableWorkspaceImport("invalid_zip_directory");
  const found: Entry[] = []; const paths = new Set<string>(); let cursor = directoryOffset; let expandedBytes=0;
  for (let index = 0; index < entries; index += 1) {
    if (cursor + 46 > directoryEnd || archive.readUInt32LE(cursor) !== 0x02014b50) throw new InvalidPortableWorkspaceImport("invalid_zip_entry");
    const flags = archive.readUInt16LE(cursor + 8); const method = archive.readUInt16LE(cursor + 10);
    const compressed = archive.readUInt32LE(cursor + 20); const size = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28); const extraLength = archive.readUInt16LE(cursor + 30); const commentLength = archive.readUInt16LE(cursor + 32);
    const localOffset = archive.readUInt32LE(cursor + 42); const path = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    if ((flags & 1) || ![0,8].includes(method) || method === 0 && compressed !== size) throw new UnsupportedPortableWorkspaceImport("unsupported_zip_entry_encoding");
    const directory=path.endsWith("/"); const checkedPath=directory?path.slice(0,-1):path;
    if (!safePath(checkedPath) || paths.has(path) || size > limits.maxFileBytes || directory&&size!==0) throw new InvalidPortableWorkspaceImport("unsafe_zip_entry");
    expandedBytes+=size; if(expandedBytes>(limits.maxArchiveBytes??limits.maxFileBytes)) throw new PortableWorkspaceImportTooLarge("expanded_archive_too_large");
    if (localOffset + 30 > directoryOffset || archive.readUInt32LE(localOffset) !== 0x04034b50) throw new InvalidPortableWorkspaceImport("invalid_local_entry");
    const localNameLength = archive.readUInt16LE(localOffset + 26); const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const localPath = archive.subarray(localOffset + 30, localOffset + 30 + localNameLength).toString("utf8");
    const contentOffset = localOffset + 30 + localNameLength + localExtraLength;
    if (localPath !== path || contentOffset + compressed > directoryOffset) throw new InvalidPortableWorkspaceImport("invalid_local_entry");
    let content: Buffer;
    try { content = method === 0 ? archive.subarray(contentOffset, contentOffset + size)
      : inflateRawSync(archive.subarray(contentOffset, contentOffset + compressed), { maxOutputLength: limits.maxFileBytes }); }
    catch { throw new InvalidPortableWorkspaceImport("invalid_compressed_entry"); }
    if (content.length !== size) throw new InvalidPortableWorkspaceImport("invalid_entry_size");
    paths.add(path); found.push({ path, content });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (cursor !== directoryEnd) throw new InvalidPortableWorkspaceImport("invalid_zip_directory");
  return found;
}

function contentType(path: string): string {
  const extension=posix.extname(path).toLowerCase();
  return new Map([[".png","image/png"],[".jpg","image/jpeg"],[".jpeg","image/jpeg"],[".gif","image/gif"],[".webp","image/webp"],[".svg","image/svg+xml"],[".pdf","application/pdf"],[".txt","text/plain"]]).get(extension) ?? "application/octet-stream";
}
function withoutFencedCode(markdown:string):string{
  let marker="";return markdown.split("\n").map((line)=>{if(marker){const closing=line.match(/^(`+|~+)\s*$/)?.[1]??"";if(closing[0]===marker[0]&&closing.length>=marker.length)marker="";return "";}
    const opening=line.match(/^(`{3,}|~{3,})/)?.[1]??"";if(opening){marker=opening;return "";}return line;}).join("\n");
}
function inlineTags(markdown:string):string[]{
  const visible=withoutFencedCode(markdown).replace(/`+[^`\n]*`+/g,"").replace(/!?\[\[[^\]]*\]\]/g,"")
    .replace(/(!?\[[^\]]*\])\((?:<[^>]*>|[^)]*)\)/g,"$1");
  return [...visible.matchAll(/(?:^|[\s([{'"])(#([\p{L}\p{N}_-]+(?:\/[\p{L}\p{N}_-]+)*))/gu)].map((match)=>match[2]!);
}
function preserveFrontmatter(value:string):string{const longest=Math.max(2,...[...value.matchAll(/`+/g)].map((match)=>match[0].length));const fence="`".repeat(longest+1);return `${fence}yaml\n${value}\n${fence}`;}
function markdownBundle(archive: Buffer, destinationOwnerAccountId: string, limits: {maxEntries:number;maxFileBytes:number;maxArchiveBytes?:number}): PortableWorkspaceImportBundle {
  const entries=unzipStored(archive,limits).filter(({path})=>!path.endsWith("/"));
  const rootParts=entries.length ? entries[0]!.path.split("/") : [];
  const commonRoot=rootParts.length>1 && entries.every(({path})=>path.startsWith(`${rootParts[0]!}/`)) ? `${rootParts[0]!}/` : "";
  const normalized=entries.map(({path,content})=>({path:path.slice(commonRoot.length).normalize("NFC"),content}));
  const transformations:ImportTransformation[]=[];
  const markdown=normalized.filter(({path})=>path.toLowerCase().endsWith(".md")&&!path.split("/").some((part)=>part.startsWith(".")));
  if(!markdown.length) throw new InvalidPortableWorkspaceImport("markdown_notes_missing");
  const workspaceId=randomUUID(); const sourceId=randomUUID(); const createdAt=new Date().toISOString();
  const identity={localAccountId:sourceId,displayName:"Markdown import"};
  const noteByPath=new Map(markdown.map(({path})=>[path,{id:randomUUID(),path}]));
  const basename=new Map<string,Array<{id:string;path:string}>>();
  for(const note of noteByPath.values()){ const key=posix.basename(note.path,".md").toLowerCase(); basename.set(key,[...(basename.get(key)??[]),note]); }
  const attachmentContent=new Map<string,Buffer>(); const attachments:PortableWorkspaceCanonicalState["attachments"]=[];
  const attachmentByPath=new Map<string,string>();
  for(const entry of normalized.filter(({path})=>!path.toLowerCase().endsWith(".md")&&!path.split("/").some((part)=>part.startsWith(".")))){
    const id=randomUUID(); attachmentByPath.set(entry.path,id); attachmentContent.set(id,entry.content);
    attachments.push({schema:"stash.attachment.v1",id,workspaceId,filename:posix.basename(entry.path),contentType:contentType(entry.path),size:entry.content.length,
      relativePath:`./attachments/${id}/${encodePortableFilename(posix.basename(entry.path))}`,source:"upload",createdAt,createdBy:identity});
    transformations.push({kind:"transformed",object:`Attachment:${entry.path}`,reason:"attachment_staged"});
  }
  for(const entry of normalized.filter(({path})=>path.split("/").some((part)=>part.startsWith(".")))) transformations.push({kind:"skipped",object:entry.path,reason:"hidden_vault_metadata"});
  const noteLinks:PortableWorkspaceCanonicalState["noteLinks"]=[];
  const notes=markdown.map((entry)=>{
    const current=noteByPath.get(entry.path)!; let text=entry.content.toString("utf8");
    if(Buffer.from(text,"utf8").length!==entry.content.length) throw new InvalidPortableWorkspaceImport("invalid_markdown_utf8");
    const tags:string[]=[]; const front=text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
    if(front){ const inline=front[1]!.match(/^tags:\s*\[([^\]]*)\]\s*$/m); const scalar=front[1]!.match(/^tags:\s*([^\n]+)$/m);
      let unsupportedTags=false;
      if(inline) {unsupportedTags=/['"]/.test(inline[1]!);if(!unsupportedTags)tags.push(...inline[1]!.split(",").map((tag)=>tag.trim()));}
      else if(scalar) {unsupportedTags=/['"]/.test(scalar[1]!);if(!unsupportedTags)tags.push(...scalar[1]!.split(/[ ,]+/).map((tag)=>tag.trim().replace(/^#/,"")));}
      const block=front[1]!.match(/^tags:\s*\r?\n((?:\s+-\s*[^\n]+\r?\n?)*)/m); if(block) tags.push(...block[1]!.split(/\r?\n/).map((line)=>line.replace(/^\s+-\s*/,"").trim()).filter(Boolean));
      text=`${preserveFrontmatter(front[1]!)}\n\n${text.slice(front[0].length)}`;
      transformations.push({kind:"transformed",object:`Note:${entry.path}`,reason:"frontmatter_preserved"});
      if(unsupportedTags)transformations.push({kind:"skipped",object:`Note:${entry.path}`,reason:"frontmatter_tags_unsupported"});
      if(tags.length)transformations.push({kind:"transformed",object:`Note:${entry.path}`,reason:"frontmatter_tags_extracted"}); }
    const nativeTags=inlineTags(text);tags.push(...nativeTags);
    if(nativeTags.length)transformations.push({kind:"transformed",object:`Note:${entry.path}`,reason:"inline_tags_extracted"});
    text=text.replace(/(!?)\[([^\]]*)\]\((?:<([^>]+)>|([^\s)]+))(?:\s+"[^"]*")?\)/g,(whole,embed:string,label:string,angled?:string,plain?:string)=>{
      const raw=angled??plain??""; if(/^(?:[a-z]+:|#|\/)/i.test(raw)) return whole; let decoded:string; try{decoded=decodeURIComponent(raw);}catch{return whole;}
      const target=posix.normalize(posix.join(posix.dirname(entry.path),decoded)); const attachmentId=attachmentByPath.get(target);
      if(attachmentId){transformations.push({kind:"transformed",object:`Link:${entry.path}->${decoded}`,reason:"relative_attachment_link"});return `${embed?"!":""}[${label}](<./attachments/${attachmentId}/${encodePortableFilename(posix.basename(target))}>)`;}
      const candidate=noteByPath.get(target); if(!embed){const cleanLabel=(label.trim()||posix.basename(target,".md")).slice(0,200);
        noteLinks.push({schema:"stash.note-link.v2",id:randomUUID(),workspaceId,sourceNoteId:current.id,...(candidate?{targetNoteId:candidate.id,targetPath:candidate.path}:{targetPath:target}),candidateNoteIds:[],label:cleanLabel,revision:1});
        transformations.push({kind:candidate?"transformed":"skipped",object:`Link:${entry.path}->${decoded}`,reason:candidate?"relative_note_link":"relative_note_target_not_found"});}
      return whole;
    });
    text=text.replace(/(!?)\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g,(whole,embed:string,target:string,label?:string)=>{
      const decoded=target.trim(); const relative=posix.normalize(posix.join(posix.dirname(entry.path),decoded));
      const attachmentId=attachmentByPath.get(relative)??attachmentByPath.get(decoded);
      if(embed&&attachmentId){ transformations.push({kind:"transformed",object:`Link:${entry.path}->${decoded}`,reason:"embedded_attachment_link"}); return `![${label??posix.basename(decoded)}](<./attachments/${attachmentId}/${encodePortableFilename(posix.basename(decoded))}>)`; }
      const exact=noteByPath.get(relative.endsWith(".md")?relative:`${relative}.md`); const candidates=exact?[exact]:(basename.get(posix.basename(decoded,".md").toLowerCase())??[]);
      const linkId=randomUUID(); const cleanLabel=(label??posix.basename(decoded,".md")).trim().slice(0,200)||"Note";
      if(candidates.length===1){ noteLinks.push({schema:"stash.note-link.v2",id:linkId,workspaceId,sourceNoteId:current.id,targetNoteId:candidates[0]!.id,targetPath:candidates[0]!.path,candidateNoteIds:[],label:cleanLabel,revision:1}); transformations.push({kind:"transformed",object:`Link:${entry.path}->${decoded}`,reason:"wikilink_resolved"}); return `[${cleanLabel}](${posix.relative(posix.dirname(entry.path),candidates[0]!.path)})`; }
      noteLinks.push({schema:"stash.note-link.v2",id:linkId,workspaceId,sourceNoteId:current.id,targetPath:decoded,candidateNoteIds:candidates.map(({id})=>id),label:cleanLabel,revision:1});
      transformations.push({kind:candidates.length?"ambiguous":"skipped",object:`Link:${entry.path}->${decoded}`,reason:candidates.length?"multiple_note_targets":"note_target_not_found"}); return whole;
    });
    if(!text.trim()) text="# Untitled";
    try { markdownToRichText(text); } catch { throw new InvalidPortableWorkspaceImport(`unsupported_markdown:${entry.path}`); }
    return {schema:"stash.note.v1" as const,id:current.id,workspaceId,content:text,tags:[...new Set(tags.filter(Boolean))],createdAt,createdBy:identity};
  });
  const state:PortableWorkspaceCanonicalState={workspace:{schema:"stash.workspace.v1",id:workspaceId,name:commonRoot.slice(0,-1)||"Imported Markdown",owner:{type:"personal",identity},createdBy:identity},notes,tasks:[],boards:[],attachments,
    noteLocations:markdown.map(({path})=>({schema:"stash.note-location.v1",noteId:noteByPath.get(path)!.id,workspaceId,path,aliases:[],revision:1})),noteLinks,activities:[],noteHistory:[],durableObjects:[]};
  return {state:parseState(Buffer.from(JSON.stringify(state))),attachmentContent,identityStubs:[{sourceAccountId:sourceId,displayName:identity.displayName}],archiveSha256:createHash("sha256").update(archive).digest("hex"),destinationOwnerAccountId,attachmentStorageKeys:new Map(),transformations};
}

function parseState(content: Buffer): PortableWorkspaceCanonicalState {
  let value: unknown; try { value = JSON.parse(content.toString("utf8")); } catch { throw new InvalidPortableWorkspaceImport("invalid_canonical_state"); }
  if (!object(value) || !object(value.workspace) || value.workspace.schema !== "stash.workspace.v1"
    || !uuid.test(String(value.workspace.id)) || !Array.isArray(value.notes) || !Array.isArray(value.tasks)
    || !Array.isArray(value.boards) || !Array.isArray(value.attachments) || !Array.isArray(value.noteLocations)
    || !Array.isArray(value.noteLinks) || !Array.isArray(value.activities) || !Array.isArray(value.noteHistory)) {
    throw new InvalidPortableWorkspaceImport("invalid_canonical_state");
  }
  if (!onlyKeys(value, ["workspace","notes","tasks","boards","attachments","noteLocations","noteLinks","activities","noteHistory","durableObjects"])
    || !onlyKeys(value.workspace,["schema","id","name","owner","createdBy"]) || typeof value.workspace.name !== "string" || !value.workspace.name.trim())
    throw new InvalidPortableWorkspaceImport("invalid_canonical_state");
  if (!Array.isArray(value.durableObjects)) throw new InvalidPortableWorkspaceImport("invalid_canonical_state");
  const workspaceId = String(value.workspace.id);
  if (!portableIdentity(value.workspace.createdBy) || !object(value.workspace.owner)
    || !["personal","organization"].includes(String(value.workspace.owner.type))) {
    throw new InvalidPortableWorkspaceImport("invalid_canonical_state");
  }
  if (value.workspace.owner.type === "personal" && !portableIdentity(value.workspace.owner.identity))
    throw new InvalidPortableWorkspaceImport("invalid_canonical_state");
  if (value.workspace.owner.type === "organization" && (!object(value.workspace.owner.identity)
    || !uuid.test(String(value.workspace.owner.identity.localOrganizationId)) || typeof value.workspace.owner.identity.displayName !== "string"))
    throw new InvalidPortableWorkspaceImport("invalid_canonical_state");
  exactIdentity(value.workspace.createdBy,"workspace_creator");
  if(value.workspace.owner.type==="personal") { exact(value.workspace.owner,["type","identity"],"workspace_owner"); exactIdentity(value.workspace.owner.identity,"workspace_owner_identity"); }
  else { exact(value.workspace.owner,["type","identity"],"workspace_owner"); exact(value.workspace.owner.identity,["localOrganizationId","displayName"],"workspace_owner_identity"); }
  const typedArrays: Array<[unknown[], string, boolean]> = [
    [value.notes, "stash.note.v1", true], [value.tasks, "stash.task.v1", true],
    [value.boards, "stash.board.v1", false], [value.attachments, "stash.attachment.v1", true],
    [value.noteLocations, "stash.note-location.v1", true],
  ];
  for (const [items, schema, hasWorkspace] of typedArrays) {
    if (items.some((item) => !object(item) || item.schema !== schema || typeof item.id !== "string" && typeof item.noteId !== "string"
      || hasWorkspace && item.workspaceId !== workspaceId)) throw new InvalidPortableWorkspaceImport("invalid_canonical_state");
  }
  const allIdentityIds: string[] = [];
  const collectIdentity = (identity: unknown) => { if (portableIdentity(identity)) allIdentityIds.push(String(identity.localAccountId)); };
  collectIdentity(value.workspace.createdBy); if (value.workspace.owner.type === "personal") collectIdentity(value.workspace.owner.identity);
  for (const item of [...value.notes, ...value.tasks, ...value.attachments]) if (object(item)) collectIdentity(item.createdBy);
  for (const item of [...value.activities, ...value.noteHistory]) if (object(item)) collectIdentity(item.actor);
  const collectNestedIdentities = (child: unknown): void => { if (portableIdentity(child)) collectIdentity(child);
    if (Array.isArray(child)) for (const item of child) collectNestedIdentities(item);
    else if (object(child)) for (const item of Object.values(child)) collectNestedIdentities(item); };
  collectNestedIdentities(value.durableObjects);
  if (allIdentityIds.some((id) => !uuid.test(id))) throw new InvalidPortableWorkspaceImport("invalid_identity");
  const noteIds = ids(value.notes); const taskIds = ids(value.tasks); const boardIds = ids(value.boards);
  const attachmentIds = ids(value.attachments); const locationIds = ids(value.noteLocations, "noteId"); const linkIds = ids(value.noteLinks);
  const durableIds = value.durableObjects.map((item) => object(item) ? `${String(item.kind)}:${String(item.id)}` : "");
  if (![noteIds, taskIds, boardIds, attachmentIds, locationIds, linkIds, durableIds].every(unique)
    || !unique([...noteIds, ...taskIds, ...boardIds, ...attachmentIds, ...linkIds])
    || [...noteIds,...taskIds,...boardIds,...attachmentIds,...locationIds,...linkIds,
      ...value.durableObjects.map((item) => object(item) ? String(item.id) : "")].some((id) => !uuid.test(id)))
    throw new InvalidPortableWorkspaceImport("duplicate_identity");
  const notes = new Set(noteIds); const tasks = new Set(taskIds);
  const projectObjects = value.durableObjects.filter((item) => object(item) && item.kind === "Project");
  const projects = new Set(projectObjects.map((item) => object(item) ? String(item.id) : ""));
  if (locationIds.length !== noteIds.length || locationIds.some((id) => !notes.has(id))) throw new InvalidPortableWorkspaceImport("invalid_note_locations");
  if (value.noteLocations.some((location) => !object(location) || typeof location.path !== "string" || !Array.isArray(location.aliases)
    || location.aliases.some((alias) => typeof alias !== "string" || !safePath(alias)) || !Number.isInteger(location.revision) || Number(location.revision) < 1
    || location.parentId !== undefined && (!uuid.test(String(location.parentId)) || !notes.has(String(location.parentId)) || location.parentId === location.noteId)
    || location.position !== undefined && (typeof location.position !== "string" || !/^[1-9][0-9]*$/.test(location.position))
    || location.archivedAt !== undefined && !timestamp(location.archivedAt)
    || location.trashedAt !== undefined && !timestamp(location.trashedAt)))
    throw new InvalidPortableWorkspaceImport("invalid_note_locations");
  const parentByNote = new Map(value.noteLocations.map((location) => [String(location.noteId), object(location) && location.parentId ? String(location.parentId) : undefined]));
  for (const noteId of noteIds) { const seen = new Set<string>(); let cursor: string | undefined = noteId;
    while (cursor) { if (seen.has(cursor)) throw new InvalidPortableWorkspaceImport("invalid_note_locations"); seen.add(cursor); cursor = parentByNote.get(cursor); } }
  for (const note of value.notes) { exact(note,["schema","id","workspaceId","content","tags","createdAt","createdBy","projectId","reminder"],"note"); exactIdentity(note.createdBy,"note_creator");
    if(note.reminder!==undefined) { exact(note.reminder,["at"],"note_reminder"); if(!timestamp(note.reminder.at)) throw new InvalidPortableWorkspaceImport("invalid_note"); }
    if (typeof note.content !== "string" || !note.content.length
    || !Array.isArray(note.tags) || !note.tags.every((tag) => typeof tag === "string") || !timestamp(note.createdAt)
    || note.projectId !== undefined && !projects.has(String(note.projectId))) throw new InvalidPortableWorkspaceImport("invalid_note"); }
  for (const task of value.tasks) { exact(task,["schema","id","workspaceId","projectId","title","key","status","keyAliases","sourceNoteIds","createdAt","createdBy","sourceBlocks","assigneeIds","formerAssigneeIds","priority","labelNames","dueDate","estimate","linkedNoteIds","dependencies","developmentLinks"],"task");
    exactIdentity(task.createdBy,"task_creator"); exact(task.status,["id","name","category"],"task_status");
    if (task.projectId !== undefined && !projects.has(String(task.projectId)) || typeof task.title !== "string" || !task.title
    || task.key !== undefined && typeof task.key !== "string" || task.projectId === undefined !== (task.key === undefined)
    || !object(task.status) || !uuid.test(String(task.status.id)) || !timestamp(task.createdAt)
    || !Array.isArray(task.sourceNoteIds) || task.sourceNoteIds.some((id) => !notes.has(String(id)))
    || task.linkedNoteIds !== undefined && (!Array.isArray(task.linkedNoteIds) || task.linkedNoteIds.some((id) => !notes.has(String(id))))
    || task.dependencies !== undefined && (!Array.isArray(task.dependencies) || task.dependencies.some((edge) => !object(edge) || !tasks.has(String(edge.taskId))))
    || task.sourceBlocks !== undefined && (!Array.isArray(task.sourceBlocks) || task.sourceBlocks.some((source) => !object(source)
      || !notes.has(String(source.noteId)) || !uuid.test(String(source.blockId))))
    || typeof task.status.name !== "string" || !(task.projectId === undefined
      ? ["unstarted","started","completed","canceled"] : ["unstarted","started","completed"]).includes(String(task.status.category))
    || task.assigneeIds !== undefined && (!Array.isArray(task.assigneeIds) || task.assigneeIds.some((id)=>!uuid.test(String(id))))
    || task.formerAssigneeIds !== undefined && (!Array.isArray(task.formerAssigneeIds) || task.formerAssigneeIds.some((id)=>!uuid.test(String(id))))
    || task.labelNames !== undefined && (!Array.isArray(task.labelNames) || task.labelNames.some((label)=>typeof label!=="string"))
    || task.priority !== undefined && !["none","low","medium","high","urgent"].includes(String(task.priority))
    || task.dueDate !== undefined && !timestamp(task.dueDate) || task.estimate !== undefined && (!Number.isFinite(task.estimate) || Number(task.estimate)<0)
    || task.keyAliases !== undefined && (!Array.isArray(task.keyAliases) || task.keyAliases.some((alias) => !object(alias)
      || !projects.has(String(alias.projectId)) || typeof alias.key !== "string")))
    throw new InvalidPortableWorkspaceImport("invalid_task"); }
  for (const task of value.tasks) {
    for (const alias of task.keyAliases ?? []) exact(alias,["projectId","key"],"task_key_alias");
    for (const source of task.sourceBlocks ?? []) exact(source,["noteId","blockId"],"task_source_block");
    for (const edge of task.dependencies ?? []) { exact(edge,["taskId","type"],"task_dependency"); if(!["depends_on","required_by"].includes(String(edge.type))) throw new InvalidPortableWorkspaceImport("invalid_task_dependency"); }
    for (const link of task.developmentLinks ?? []) { exact(link,["provider","url","kind"],"task_development_link"); if(typeof link.provider!=="string"||typeof link.url!=="string"||!["branch","commit","pull_request"].includes(String(link.kind))) throw new InvalidPortableWorkspaceImport("invalid_task_development_link"); }
  }
  for (const board of value.boards) { exact(board,["schema","id","projectId","name","groupBy","createdAt"],"board"); if (!projects.has(String(board.projectId)) || typeof board.name !== "string"
    || !["status", "priority"].includes(String(board.groupBy)) || !timestamp(board.createdAt)) throw new InvalidPortableWorkspaceImport("invalid_board"); }
  for (const attachment of value.attachments) { exact(attachment,["schema","id","workspaceId","filename","contentType","size","relativePath","source","createdAt","createdBy"],"attachment"); exactIdentity(attachment.createdBy,"attachment_creator"); }
  for (const location of value.noteLocations) exact(location,["schema","noteId","workspaceId","path","aliases","revision","parentId","position","archivedAt","trashedAt"],"note_location");
  for (const link of value.noteLinks) { exact(link,link.schema==="stash.note-link.v1"?["schema","id","workspaceId","sourceNoteId","targetNoteId"]
    :["schema","id","workspaceId","sourceNoteId","targetNoteId","targetPath","candidateNoteIds","label","relationshipType","revision"],"note_link"); if (!notes.has(String(link.sourceNoteId))
    || link.targetNoteId !== undefined && link.targetNoteId !== null && !notes.has(String(link.targetNoteId))
    || link.relationshipType !== undefined && (typeof link.relationshipType !== "string" || !link.relationshipType.trim() || link.relationshipType.trim().length > 80 || /[\r\n]/.test(link.relationshipType))
    || !Number.isInteger(link.revision ?? 1) || Number(link.revision ?? 1) < 1) throw new InvalidPortableWorkspaceImport("invalid_note_link"); }
  const allowedDurable = new Map([["Project", ["stash.project.v1"]], ["Workflow", ["stash.workflow.v1"]],
    ["WorkspaceWorkflow", ["stash.workspace-workflow.v1"]], ["Collection", ["stash.collection.v1"]], ["ViewBlock", ["stash.view-block.v1"]],
    ["VisualizationBlock", ["stash.visualization.v1"]],
    ["GuestProjectAccess", ["stash.guest-project-access.v1"]], ["RepositoryConnection", ["stash.repository-connection.v1","stash.disconnected-repository-connection.v1"]],
    ["Discussion", ["stash.discussion.v1"]], ["DiscussionWorkLink", ["stash.discussion-work-link.v1"]]]);
  const sanitizedDurable: PortableWorkspaceCanonicalState["durableObjects"] = [];
  for (const item of value.durableObjects) {
    if (!object(item) || !onlyKeys(item,["kind","id","schema","payload"]) || !allowedDurable.get(String(item.kind))?.includes(String(item.schema)) || !object(item.payload) || item.payload.schema !== item.schema
      || item.payload.id !== undefined && item.payload.id !== item.id) throw new InvalidPortableWorkspaceImport("unsupported_durable_object");
    const payload = item.payload;
    let sanitized: unknown;
    if (item.kind === "Project") { exact(payload,["schema","id","workspaceId","name","key","createdBy"],"project"); exactIdentity(payload.createdBy,"project_creator");
      if (payload.workspaceId !== workspaceId || payload.id !== item.id || typeof payload.name !== "string" || typeof payload.key !== "string") throw new InvalidPortableWorkspaceImport("invalid_project");
      sanitized={schema:payload.schema,id:payload.id,workspaceId:payload.workspaceId,name:payload.name,key:payload.key,createdBy:{...payload.createdBy}}; }
    if (item.kind === "Workflow" && (!projects.has(String(payload.projectId)) || !Array.isArray(payload.statuses)
      || payload.statuses.some((status) => !object(status) || !uuid.test(String(status.id)) || typeof status.name !== "string"
        || !["unstarted", "started", "completed"].includes(String(status.category)) || !Number.isInteger(status.position) || typeof status.archived !== "boolean")))
      throw new InvalidPortableWorkspaceImport("invalid_workflow");
    if(item.kind==="Workflow") { exact(payload,["schema","projectId","revision","statuses"],"workflow");
      for(const status of payload.statuses as unknown[]) exact(status,["id","name","category","position","archived"],"workflow_status");
      if(!Number.isInteger(payload.revision)||Number(payload.revision)<0) throw new InvalidPortableWorkspaceImport("invalid_workflow");
      sanitized={schema:payload.schema,projectId:payload.projectId,revision:payload.revision,statuses:(payload.statuses as Record<string,unknown>[]).map((s)=>({...s}))}; }
    if(item.kind==="WorkspaceWorkflow") { exact(payload,["schema","id","workspaceId","statuses"],"workspace_workflow");
      if(payload.id!==item.id||payload.workspaceId!==workspaceId||!Array.isArray(payload.statuses)||payload.statuses.length<1) throw new InvalidPortableWorkspaceImport("invalid_workspace_workflow");
      const positions=new Set<number>(); const names=new Set<string>();
      for(const status of payload.statuses as unknown[]) { exact(status,["id","name","category","position"],"workspace_workflow_status");
        if(!object(status)||!uuid.test(String(status.id))||typeof status.name!=="string"||!status.name.trim()||names.has(status.name)
          ||!["unstarted","started","completed","canceled"].includes(String(status.category))||!Number.isInteger(status.position)||Number(status.position)<1||positions.has(Number(status.position))) throw new InvalidPortableWorkspaceImport("invalid_workspace_workflow");
        names.add(status.name); positions.add(Number(status.position)); }
      sanitized=structuredClone(payload); }
    if(item.kind==="Collection") { exact(payload,["schema","id","workspaceId","ownerNoteId","title","properties","records"],"collection");
      if(payload.id!==item.id||payload.workspaceId!==workspaceId||!notes.has(String(payload.ownerNoteId))||typeof payload.title!=="string"||!payload.title.trim()||payload.title.length>120||/[\r\n]/.test(payload.title)||!Array.isArray(payload.properties)||!Array.isArray(payload.records)) throw new InvalidPortableWorkspaceImport("invalid_collection");
      const propertyIds=new Set<string>(); const propertyPositions=new Set<number>(); for(const property of payload.properties){exact(property,["id","name","type","position"],"collection_property"); if(!uuid.test(String(property.id))||propertyIds.has(String(property.id))||typeof property.name!=="string"||!property.name.trim()||property.name.length>120||/[\r\n]/.test(property.name)||property.type!=="text"||!Number.isInteger(property.position)||Number(property.position)<1||propertyPositions.has(Number(property.position))) throw new InvalidPortableWorkspaceImport("invalid_collection"); propertyIds.add(String(property.id));propertyPositions.add(Number(property.position));}
      const recordIds=new Set<string>(); const recordPositions=new Set<number>(); for(const record of payload.records){exact(record,["id","position","values"],"collection_record");if(!uuid.test(String(record.id))||recordIds.has(String(record.id))||!Number.isInteger(record.position)||Number(record.position)<1||recordPositions.has(Number(record.position))||!object(record.values)||Object.keys(record.values).some((id)=>!propertyIds.has(id))||Object.values(record.values).some((entry)=>typeof entry!=="string"))throw new InvalidPortableWorkspaceImport("invalid_collection");recordIds.add(String(record.id));recordPositions.add(Number(record.position));}
      sanitized=structuredClone(payload); }
    if(item.kind==="ViewBlock") { exact(payload,["schema","id","workspaceId","ownerNoteId","blockId","title","source","definition"],"view_block");
      if(payload.id!==item.id||payload.workspaceId!==workspaceId||!notes.has(String(payload.ownerNoteId))||!uuid.test(String(payload.blockId))||typeof payload.title!=="string"||!payload.title.trim()||payload.title.length>120||/[\r\n]/.test(payload.title)||!object(payload.source)||!object(payload.definition)) throw new InvalidPortableWorkspaceImport("invalid_view_block");
      exact(payload.source,["kind","workspaceId","project"],"view_block_source"); exact(payload.definition,["query","layout"],"view_definition");
      if(payload.source.kind!=="tasks"||payload.source.workspaceId!==workspaceId||payload.source.project!=="none"||!["list","table"].includes(String(payload.definition.layout))||!object(payload.definition.query)) throw new InvalidPortableWorkspaceImport("invalid_view_block");
      exact(payload.definition.query,["scope","titleContains"],"view_query"); if(payload.definition.query.scope!=="projectless"||typeof payload.definition.query.titleContains!=="string"||payload.definition.query.titleContains.length>120||/[\r\n]/.test(payload.definition.query.titleContains)) throw new InvalidPortableWorkspaceImport("invalid_view_block"); sanitized=structuredClone(payload); }
    if(item.kind==="VisualizationBlock") { exact(payload,["schema","id","kind","query","filters","layout","viewEdges","workspaceId","ownerNoteId","revision"],"visualization_block");
      if(payload.workspaceId!==workspaceId||payload.id!==item.id||!notes.has(String(payload.ownerNoteId))||!Number.isInteger(payload.revision)||Number(payload.revision)<1)
        throw new InvalidPortableWorkspaceImport("invalid_visualization_block");
      let definition; try { definition=normalizeVisualizationDefinition({ schema:payload.schema,id:payload.id,kind:payload.kind,query:payload.query,
        filters:payload.filters,layout:payload.layout,viewEdges:payload.viewEdges }); } catch { throw new InvalidPortableWorkspaceImport("invalid_visualization_block"); }
      if(definition.query.kind==="relationship"&&!notes.has(definition.query.input.rootId)
        ||("positions" in definition.layout)&&Object.keys(definition.layout.positions).some((id)=>!notes.has(id))
        ||definition.viewEdges.some((edge)=>!notes.has(edge.sourceNoteId)||!notes.has(edge.targetNoteId)))
        throw new InvalidPortableWorkspaceImport("invalid_visualization_block");
      sanitized={...definition,workspaceId,ownerNoteId:payload.ownerNoteId,revision:payload.revision}; }
    if (item.kind === "Discussion" && (payload.workspaceId !== workspaceId || !object(payload.target)
      || payload.target.kind === "task" && !tasks.has(String(payload.target.taskId))
      || ["note", "block"].includes(String(payload.target.kind)) && !notes.has(String(payload.target.noteId))
      || !Array.isArray(payload.messages) || payload.messages.some((message) => !object(message) || !uuid.test(String(message.id))
        || typeof message.content !== "string" || !message.content || !portableIdentity(message.author) || !timestamp(message.createdAt))))
      throw new InvalidPortableWorkspaceImport("invalid_discussion");
    if(item.kind==="Discussion") { exact(payload,["schema","id","workspaceId","target","messages","createdAt","resolvedAt"],"discussion");
      if(object(payload.target)&&payload.target.kind==="note") exact(payload.target,["kind","noteId"],"discussion_target");
      else if(object(payload.target)&&payload.target.kind==="task") exact(payload.target,["kind","taskId"],"discussion_target");
      else if(object(payload.target)&&payload.target.kind==="block") { exact(payload.target,["kind","noteId","blockId"],"discussion_target"); if(!uuid.test(String(payload.target.blockId))) throw new InvalidPortableWorkspaceImport("invalid_discussion"); }
      else throw new InvalidPortableWorkspaceImport("invalid_discussion");
      for(const message of payload.messages as unknown[]) { exact(message,["id","content","author","createdAt"],"discussion_message"); exactIdentity(message.author,"discussion_author"); }
      if(!timestamp(payload.createdAt)||(payload.resolvedAt!==undefined&&!timestamp(payload.resolvedAt))) throw new InvalidPortableWorkspaceImport("invalid_discussion");
      sanitized=structuredClone(payload); }
    if (item.kind === "DiscussionWorkLink" && (payload.workspaceId !== workspaceId || !object(payload.work)
      || payload.work.kind === "note" && !notes.has(String(payload.work.id)) || payload.work.kind === "task" && !tasks.has(String(payload.work.id))))
      throw new InvalidPortableWorkspaceImport("invalid_discussion_link");
    if(item.kind==="DiscussionWorkLink") { exact(payload,["schema","id","workspaceId","discussionId","work","selectedMessages","createdAt","createdBy"],"discussion_link");
      exact(payload.work,["kind","id"],"discussion_work"); exactIdentity(payload.createdBy,"discussion_link_creator");
      if(!uuid.test(String(payload.discussionId))||!value.durableObjects.some((candidate)=>object(candidate)&&candidate.kind==="Discussion"&&candidate.id===payload.discussionId)
        ||!Array.isArray(payload.selectedMessages)||!timestamp(payload.createdAt)) throw new InvalidPortableWorkspaceImport("invalid_discussion_link");
      const discussion=value.durableObjects.find((candidate)=>object(candidate)&&candidate.kind==="Discussion"&&candidate.id===payload.discussionId);
      const discussionMessageIds=new Set(object(discussion)&&object(discussion.payload)&&Array.isArray(discussion.payload.messages)?ids(discussion.payload.messages):[]);
      for(const message of payload.selectedMessages) { exact(message,["id","content","author","createdAt"],"discussion_selected_message"); exactIdentity(message.author,"discussion_selected_author"); if(!timestamp(message.createdAt)) throw new InvalidPortableWorkspaceImport("invalid_discussion_link"); }
      if(payload.selectedMessages.some((message)=>!discussionMessageIds.has(String(message.id)))) throw new InvalidPortableWorkspaceImport("invalid_discussion_link");
      sanitized=structuredClone(payload); }
    if (item.kind === "GuestProjectAccess" && (!Array.isArray(payload.projects) || payload.projects.some((project) => !object(project)
      || project.workspaceId !== workspaceId || !projects.has(String(project.projectId))))) throw new InvalidPortableWorkspaceImport("invalid_permission");
    if(item.kind==="GuestProjectAccess") { exact(payload,["schema","id","organizationId","guest","projects","acceptedAt","invitedBy"],"permission");
      exactIdentity(payload.guest,"guest"); exactIdentity(payload.invitedBy,"inviter");
      for(const project of payload.projects as unknown[]) exact(project,["projectId","workspaceId"],"guest_project");
      if(!uuid.test(String(payload.organizationId))||!timestamp(payload.acceptedAt)) throw new InvalidPortableWorkspaceImport("invalid_permission"); sanitized=structuredClone(payload); }
    if (item.kind === "RepositoryConnection" && (!Array.isArray(payload.projectIds) || payload.projectIds.some((id) => !projects.has(String(id)))))
      throw new InvalidPortableWorkspaceImport("invalid_repository_connection");
    if(item.kind==="RepositoryConnection") { const disconnected=item.schema==="stash.disconnected-repository-connection.v1";
      exact(payload,disconnected?["schema","id","provider","repositoryUrl","organization","createdBy","projectIds","ownership","state","reason"]
        :["schema","id","provider","repositoryUrl","organization","createdBy","projectIds","ownership","state"],"repository_connection");
      exact(payload.organization,["localOrganizationId","displayName"],"repository_organization");
      exact(payload.createdBy,["localAccountId","displayName","attribution"],"repository_creator");
      if(payload.provider!=="github"||typeof payload.repositoryUrl!=="string"||!/^https:\/\//.test(payload.repositoryUrl)
        ||!uuid.test(String(payload.organization.localOrganizationId))||typeof payload.organization.displayName!=="string"
        ||value.workspace.owner.type!=="organization"||!object(value.workspace.owner.identity)
        ||payload.organization.localOrganizationId!==(value.workspace.owner.identity as Record<string, unknown>).localOrganizationId
        ||!uuid.test(String(payload.createdBy.localAccountId))||typeof payload.createdBy.displayName!=="string"
        ||!["recorded","inferred-during-upgrade"].includes(String(payload.createdBy.attribution))
        ||!Array.isArray(payload.projectIds)
        ||payload.ownership!==undefined&&!["organization","personal"].includes(String(payload.ownership))
        ||(disconnected ? payload.state!=="disconnected"||payload.reason!=="credentials_not_portable"
          :payload.state!==undefined&&!["active","degraded"].includes(String(payload.state))))
        throw new InvalidPortableWorkspaceImport("invalid_repository_connection"); sanitized=structuredClone(payload); }
    sanitizedDurable.push({kind:String(item.kind),id:String(item.id),schema:String(item.schema),payload:sanitized!});
  }
  const projectStatusOwners = new Map<string,string>(); const workspaceStatuses = new Set<string>();
  for(const item of value.durableObjects) if(object(item)&&object(item.payload)&&Array.isArray(item.payload.statuses)) {
    if(item.kind==="Workflow") for(const statusId of ids(item.payload.statuses)) projectStatusOwners.set(statusId,String(item.payload.projectId));
    if(item.kind==="WorkspaceWorkflow") for(const statusId of ids(item.payload.statuses)) workspaceStatuses.add(statusId);
  }
  if (value.tasks.some((task) => object(task) && object(task.status) && (task.projectId === undefined
    ? !workspaceStatuses.has(String(task.status.id)) : projectStatusOwners.get(String(task.status.id)) !== task.projectId)))
    throw new InvalidPortableWorkspaceImport("dangling_task_status");
  const domainIds = new Set([...noteIds,...taskIds,...linkIds,...value.durableObjects.map((item) => object(item) ? String(item.id) : "")]);
  if (value.activities.some((activity) => !object(activity) || !object(activity.object) || !domainIds.has(String(activity.object.id))
    || typeof activity.action !== "string" || !timestamp(activity.occurredAt) || !object(activity.before) || !object(activity.after)))
    throw new InvalidPortableWorkspaceImport("invalid_activity");
  for(const activity of value.activities) { exact(activity,["schema","id","workspaceId","object","action","actor","cause","occurredAt","before","after"],"activity");
    exact(activity.object,["kind","id"],"activity_object"); exactIdentity(activity.actor,"activity_actor"); exactCause(activity.cause,"activity_cause"); }
  const revisions = new Set<string>();
  if (value.noteHistory.some((history) => !object(history) || !notes.has(String(history.noteId)) || !Number.isInteger(history.revision)
    || Number(history.revision) < 1 || typeof history.content !== "string" || !history.content.length || !isRichTextDocument(history.document)
    || !timestamp(history.recordedAt) || revisions.has(`${String(history.noteId)}:${String(history.revision)}`)
    || !revisions.add(`${String(history.noteId)}:${String(history.revision)}`))) throw new InvalidPortableWorkspaceImport("invalid_note_history");
  for(const history of value.noteHistory) { exact(history,["noteId","workspaceId","revision","content","document","recordedAt","actor","cause"],"note_history"); exactIdentity(history.actor,"history_actor");
    exactCause(history.cause,"history_cause"); }
  if (value.noteLinks.some((item) => !object(item) || !["stash.note-link.v1", "stash.note-link.v2"].includes(String(item.schema))
    || item.workspaceId !== workspaceId)
    || value.activities.some((item) => !object(item) || item.schema !== "stash.activity.v1" || item.workspaceId !== workspaceId)
    || value.noteHistory.some((item) => !object(item) || item.workspaceId !== workspaceId)
    || value.durableObjects.some((item) => !object(item) || typeof item.kind !== "string" || typeof item.id !== "string"
      || typeof item.schema !== "string" || !("payload" in item))) throw new InvalidPortableWorkspaceImport("invalid_canonical_state");
  for (const attachment of value.attachments) {
    if (!object(attachment) || typeof attachment.relativePath !== "string" || typeof attachment.size !== "number"
      || !Number.isSafeInteger(attachment.size) || attachment.size < 0 || typeof attachment.contentType !== "string"
      || !["upload","paste"].includes(String(attachment.source)) || !timestamp(attachment.createdAt)) throw new InvalidPortableWorkspaceImport("invalid_canonical_state");
    const expected = `./attachments/${String(attachment.id)}/${encodePortableFilename(String(attachment.filename))}`;
    if (!uuid.test(String(attachment.id)) || typeof attachment.filename !== "string" || attachment.relativePath !== expected)
      throw new InvalidPortableWorkspaceImport("invalid_attachment_path");
  }
  if ([...value.notes, ...value.tasks, ...value.attachments].some((item) => !object(item) || !portableIdentity(item.createdBy))
    || value.activities.some((item) => !object(item) || !portableIdentity(item.actor))
    || value.noteHistory.some((item) => !object(item) || !portableIdentity(item.actor))) throw new InvalidPortableWorkspaceImport("invalid_canonical_state");
  // Nothing from the untrusted parsed object crosses the repository boundary by
  // reference. Exact schemas above reject unknown fields; this reconstruction
  // also prevents later mutation of the parsed archive from affecting storage.
  rejectSensitiveKeys(value);
  return structuredClone({
    workspace: value.workspace,
    notes: value.notes,
    tasks: value.tasks,
    boards: value.boards,
    attachments: value.attachments,
    noteLocations: value.noteLocations,
    noteLinks: value.noteLinks,
    activities: value.activities,
    noteHistory: value.noteHistory,
    durableObjects: sanitizedDurable,
  }) as unknown as PortableWorkspaceCanonicalState;
}
function identities(state: PortableWorkspaceCanonicalState): IdentityStub[] {
  const values = new Map<string, string>();
  const add = (value: unknown) => { if (object(value) && typeof value.localAccountId === "string" && typeof value.displayName === "string") values.set(value.localAccountId, value.displayName); };
  add(state.workspace.createdBy); if (state.workspace.owner.type === "personal") add(state.workspace.owner.identity);
  for (const item of [...state.notes, ...state.tasks, ...state.attachments]) add(item.createdBy);
  for (const item of state.activities) add(item.actor);
  for (const item of state.noteHistory) add(item.actor);
  const nested = (value: unknown): void => { add(value); if (Array.isArray(value)) for (const item of value) nested(item);
    else if (object(value)) for (const item of Object.values(value)) nested(item); };
  nested(state.durableObjects);
  return [...values].sort(([left], [right]) => left.localeCompare(right)).map(([sourceAccountId, displayName]) => ({ sourceAccountId, displayName }));
}

export class PortableWorkspaceImportService {
  constructor(private readonly repository: PortableWorkspaceImportRepository,
    private readonly storage?: AttachmentStorage,
    private readonly limits = { maxArchiveBytes: 256 * 1024 * 1024, maxEntries: 100_000, maxFileBytes: 256 * 1024 * 1024 }) {}

  async import(importId: string, destinationOwnerAccountId: string, archive: Buffer) {
    if (!uuid.test(importId) || !uuid.test(destinationOwnerAccountId)) throw new InvalidPortableWorkspaceImport("invalid_import_id");
    if (archive.length > this.limits.maxArchiveBytes) throw new PortableWorkspaceImportTooLarge("archive_too_large");
    const entries = unzipStored(archive, this.limits); const files = new Map(entries.map((entry) => [entry.path, entry.content]));
    const manifestContent = files.get("manifest.json"); if (!manifestContent) throw new InvalidPortableWorkspaceImport("missing_manifest");
    let manifest: Manifest; try { manifest = JSON.parse(manifestContent.toString("utf8")) as Manifest; } catch { throw new InvalidPortableWorkspaceImport("invalid_manifest"); }
    if (!object(manifest) || typeof manifest.schema !== "string" || !(publishedPortableWorkspaceExportSchemas as readonly string[]).includes(manifest.schema)
      || !Array.isArray(manifest.files)) throw new UnsupportedPortableWorkspaceImport("unsupported_schema");
    const declared = new Set<string>();
    for (const entry of manifest.files) {
      if (!object(entry) || typeof entry.path !== "string" || !safePath(entry.path) || entry.path === "manifest.json"
        || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || typeof entry.sha256 !== "string" || !digest.test(entry.sha256)
        || declared.has(entry.path)) throw new InvalidPortableWorkspaceImport("invalid_manifest_entry");
      const content = files.get(entry.path); if (!content || content.length !== entry.bytes
        || createHash("sha256").update(content).digest("hex") !== entry.sha256) throw new InvalidPortableWorkspaceImport("checksum_mismatch");
      declared.add(entry.path);
    }
    if (files.size !== declared.size + 1 || [...files].some(([path]) => path !== "manifest.json" && !declared.has(path))) throw new InvalidPortableWorkspaceImport("undeclared_archive_entry");
    const canonical = files.get("objects/workspace.json"); if (!canonical) throw new UnsupportedPortableWorkspaceImport("canonical_state_missing");
    const state = parseState(canonical);
    if (!object(manifest.workspace) || manifest.workspace.id !== state.workspace.id) throw new InvalidPortableWorkspaceImport("workspace_identity_mismatch");
    const attachmentContent = new Map<string, Buffer>();
    const canonicalPaths = new Set<string>();
    const requireCanonicalFile = (path: string) => { if (!safePath(path) || canonicalPaths.has(path) || !files.has(path))
      throw new InvalidPortableWorkspaceImport("canonical_file_binding"); canonicalPaths.add(path); };
    for (const location of state.noteLocations) requireCanonicalFile(location.path);
    for (const task of state.tasks) requireCanonicalFile(`tasks/${task.key ?? "projectless"}--${task.id}.md`);
    for (const board of state.boards) requireCanonicalFile(`boards/${board.id}.json`);
    for (const attachment of state.attachments) {
      const path = attachment.relativePath.replace(/^\.\//, ""); const content = files.get(path);
      if (!content || content.length !== attachment.size) throw new InvalidPortableWorkspaceImport("attachment_missing");
      requireCanonicalFile(path);
      attachmentContent.set(attachment.id, content);
    }
    const archiveSha256 = createHash("sha256").update(archive).digest("hex");
    return this.commit(importId,{ state, attachmentContent, identityStubs: identities(state), archiveSha256, destinationOwnerAccountId, attachmentStorageKeys:new Map() });
  }

  async importMarkdown(importId:string,destinationOwnerAccountId:string,archive:Buffer){
    if (!uuid.test(importId) || !uuid.test(destinationOwnerAccountId)) throw new InvalidPortableWorkspaceImport("invalid_import_id");
    if (archive.length > this.limits.maxArchiveBytes) throw new PortableWorkspaceImportTooLarge("archive_too_large");
    return this.commit(importId,markdownBundle(archive,destinationOwnerAccountId,this.limits));
  }

  private async commit(importId:string,bundle:PortableWorkspaceImportBundle){
    const {attachmentContent,archiveSha256}=bundle;
    const existing = await this.repository.findWorkspaceImport(importId);
    if (existing) return existing.archiveSha256 === archiveSha256
      ? { status: "duplicate" as const, report: existing.report } : { status: "workspace_conflict" as const };
    if (attachmentContent.size && !this.storage) throw new Error("attachment_storage_unavailable");
    const attachmentStorageKeys = new Map<string, string>();
    try {
      for (const [attachmentId, content] of attachmentContent) {
        const key = `${randomUUID()}/${attachmentId}`; await this.storage!.put(key, content); attachmentStorageKeys.set(attachmentId, key);
      }
      const result = await this.repository.importWorkspace(importId, { ...bundle, attachmentStorageKeys });
      if (result.status !== "imported") for (const key of attachmentStorageKeys.values()) await this.storage!.delete(key).catch(() => undefined);
      return result;
    } catch (error) {
      for (const key of attachmentStorageKeys.values()) await this.storage!.delete(key).catch(() => undefined);
      throw error;
    }
  }

  async mapIdentity(input: { importId: string; sourceAccountId: string; localAccountId: string; idempotencyKey: string }) {
    if (![input.importId,input.sourceAccountId,input.localAccountId,input.idempotencyKey].every((value)=>uuid.test(value)))
      throw new InvalidPortableWorkspaceImport("invalid_identity_mapping");
    return this.repository.mapImportedIdentity(input);
  }
}

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as Y from "yjs";
import { NoteCollaborationService, type CollaborationSnapshot, type NoteCollaborationRepository } from "../../src/note-collaboration.js";
import { yDocToProsemirrorJSON } from "y-prosemirror";
import { collaborativeDocumentFromRichText, richTextFromCollaborativeDocument, validatedRichTextFromCollaborativeDocument } from "../../src/postgres-database.js";
import { InvalidCollaborationUpdate } from "../../src/note-collaboration.js";
import { markdownToRichText, proseMirrorToMarkdown, proseMirrorToRichText, richTextToMarkdown, type RichTextDocument } from "../../src/rich-text.js";

function portable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(portable);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "blockKey")
    .map(([key, child]) => [key, portable(child)]));
  return value;
}

class MemoryRepository implements NoteCollaborationRepository {
  snapshot?: CollaborationSnapshot;
  async loadNoteCollaboration(memberId: string, noteId: string) { return ["allowed", "reader"].includes(memberId) ? this.snapshot ?? {
    noteId, sequence: 0, update: Y.encodeStateAsUpdate(new Y.Doc()), updatedAt: new Date(0).toISOString(), updatedByMemberId: memberId,
    access: memberId === "allowed" ? "edit" as const : "read" as const,
  } : undefined; }
  async appendNoteCollaboration(memberId: string, noteId: string, update: Uint8Array) {
    if (memberId !== "allowed") return undefined;
    const document = new Y.Doc(); if (this.snapshot) Y.applyUpdate(document, this.snapshot.update); Y.applyUpdate(document, update);
    return this.snapshot = { noteId, sequence: (this.snapshot?.sequence ?? 0) + 1, update: Y.encodeStateAsUpdate(document),
      updatedAt: new Date().toISOString(), updatedByMemberId: memberId, access: "edit" };
  }
}

describe("self-hosted Note collaboration", () => {
  it("seeds one authoritative collaborative document with stable Block identity", () => {
    const document = collaborativeDocumentFromRichText({ type: "doc", blocks: [{ type: "paragraph",
      blockKey: "44444444-4444-4444-8444-444444444444", id: "55555555-5555-4555-8555-555555555555",
      content: [{ text: "Linked planning context", marks: ["bold"] }] }] });
    assert.deepEqual(JSON.parse(JSON.stringify(yDocToProsemirrorJSON(document, "default"))), { type: "doc", content: [{ type: "paragraph",
      attrs: { blockKey: "44444444-4444-4444-8444-444444444444", blockId: "55555555-5555-4555-8555-555555555555" },
      content: [{ type: "text", marks: [{ type: "bold", attrs: {} }], text: "Linked planning context" }] }] });
  });

  it("merges concurrent and offline contributions without discarding either", async () => {
    const repository = new MemoryRepository(); const service = new NoteCollaborationService(repository);
    const first = new Y.Doc(); first.getText("note").insert(0, "Alpha");
    const second = new Y.Doc(); second.getText("note").insert(0, "Beta");
    await service.apply("allowed", "note", Y.encodeStateAsUpdate(first));
    const merged = await service.apply("allowed", "note", Y.encodeStateAsUpdate(second));
    const restored = new Y.Doc(); Y.applyUpdate(restored, merged!.update);
    assert.match(restored.getText("note").toString(), /Alpha/); assert.match(restored.getText("note").toString(), /Beta/);
    assert.equal(merged?.sequence, 2); assert.equal(merged?.updatedByMemberId, "allowed");
  });

  it("materializes collaborative rich text as the canonical Note document", () => {
    const document = collaborativeDocumentFromRichText({ type: "doc", blocks: [{ type: "heading", level: 2,
      blockKey: "44444444-4444-4444-8444-444444444444", id: "55555555-5555-4555-8555-555555555555",
      content: [{ text: "Original" }] }] });
    const fragment = document.getXmlFragment("default");
    const headingText = (fragment.get(0)! as Y.XmlElement).get(0) as Y.XmlText;
    headingText.delete(0, headingText.length); headingText.insert(0, "Edited together");
    assert.deepEqual(richTextFromCollaborativeDocument(document), { type: "doc", blocks: [{ type: "heading", level: 2,
      blockKey: "44444444-4444-4444-8444-444444444444", id: "55555555-5555-4555-8555-555555555555",
      content: [{ text: "Edited together" }] }] });
    document.destroy();
  });

  it("materializes every list item and callout paragraph with its stable identity", () => {
    const source = { type: "doc", content: [
      { type: "bulletList", content: [
        { type: "listItem", attrs: { blockKey: "11111111-1111-4111-8111-111111111111", blockId: "21111111-1111-4111-8111-111111111111" }, content: [{ type: "paragraph", content: [{ type: "text", text: "First item" }] }] },
        { type: "listItem", attrs: { blockKey: "22222222-2222-4222-8222-222222222222", blockId: "32222222-2222-4222-8222-222222222222" }, content: [{ type: "paragraph", content: [{ type: "text", text: "Second item" }] }] },
      ] },
      { type: "taskList", content: [
        { type: "taskItem", attrs: { checked: false, blockKey: "33333333-3333-4333-8333-333333333333" }, content: [{ type: "paragraph", content: [{ type: "text", text: "First task" }] }] },
        { type: "taskItem", attrs: { checked: true, blockKey: "44444444-4444-4444-8444-444444444444" }, content: [{ type: "paragraph", content: [{ type: "text", text: "Second task" }] }] },
      ] },
      { type: "callout", attrs: { kind: "warning", blockKey: "55555555-5555-4555-8555-555555555555" }, content: [
        { type: "paragraph", content: [{ type: "text", text: "First warning" }] },
        { type: "paragraph", attrs: { blockKey: "66666666-6666-4666-8666-666666666666" }, content: [{ type: "text", text: "Second warning" }] },
      ] },
    ] };
    const materialized = proseMirrorToRichText(source);
    assert.deepEqual(materialized.blocks.flatMap((block) => block.type === "callout"
      ? block.paragraphs.map((paragraph) => [block.type, paragraph.blockKey ?? block.blockKey, paragraph.content[0]?.text])
      : [[block.type, block.blockKey, "content" in block ? block.content[0]?.text : undefined]]), [
      ["bullet", "11111111-1111-4111-8111-111111111111", "First item"],
      ["bullet", "22222222-2222-4222-8222-222222222222", "Second item"],
      ["check", "33333333-3333-4333-8333-333333333333", "First task"],
      ["check", "44444444-4444-4444-8444-444444444444", "Second task"],
      ["callout", "55555555-5555-4555-8555-555555555555", "First warning"],
      ["callout", "66666666-6666-4666-8666-666666666666", "Second warning"],
    ]);
    const markdown = proseMirrorToMarkdown(source);
    for (const contribution of ["First item", "Second item", "First task", "Second task", "First warning", "Second warning"])
      assert.match(markdown, new RegExp(contribution));
  });

  it("preserves nested list contributions and their stable identities in canonical Markdown", () => {
    const source = { type: "doc", content: [{ type: "bulletList", content: [
      { type: "listItem", attrs: { blockKey: "11111111-1111-4111-8111-111111111111", blockId: "21111111-1111-4111-8111-111111111111" }, content: [
        { type: "paragraph", content: [{ type: "text", text: "Parent contribution" }] },
        { type: "taskList", content: [{ type: "taskItem", attrs: { checked: true, blockKey: "22222222-2222-4222-8222-222222222222", blockId: "32222222-2222-4222-8222-222222222222" }, content: [
          { type: "paragraph", content: [{ type: "text", text: "Nested contribution" }] },
          { type: "bulletList", content: [{ type: "listItem", attrs: { blockKey: "33333333-3333-4333-8333-333333333333", blockId: "43333333-3333-4333-8333-333333333333" }, content: [
            { type: "paragraph", content: [{ type: "text", text: "Deep contribution" }] },
          ] }] },
        ] }] },
      ] },
    ] }] };
    const materialized = proseMirrorToRichText(source);
    assert.deepEqual(materialized.blocks, [{ type: "bullet", blockKey: "11111111-1111-4111-8111-111111111111",
      id: "21111111-1111-4111-8111-111111111111", content: [{ text: "Parent contribution" }], children: [{ type: "check", items: [{
        blockKey: "22222222-2222-4222-8222-222222222222", id: "32222222-2222-4222-8222-222222222222", checked: true,
        content: [{ text: "Nested contribution" }], children: [{ type: "bullet", items: [{ blockKey: "33333333-3333-4333-8333-333333333333",
          id: "43333333-3333-4333-8333-333333333333", content: [{ text: "Deep contribution" }] }] }],
      }] }] }]);
    const markdown = proseMirrorToMarkdown(source);
    for (const contribution of ["Parent contribution", "Nested contribution", "Deep contribution"])
      assert.match(markdown, new RegExp(contribution));
    for (const identifier of ["21111111-1111-4111-8111-111111111111", "32222222-2222-4222-8222-222222222222", "43333333-3333-4333-8333-333333333333"])
      assert.match(markdown, new RegExp(`stash-block:${identifier}`));
    assert.deepEqual(markdownToRichText(markdown), portable(materialized));
  });

  it("accepts an empty code block as a normal collaborative editing state", () => {
    const document = collaborativeDocumentFromRichText({ type: "doc", blocks: [{ type: "code", text: "",
      blockKey: "11111111-1111-4111-8111-111111111111" }] });
    assert.deepEqual(validatedRichTextFromCollaborativeDocument(document), { type: "doc", blocks: [{ type: "code", text: "",
      blockKey: "11111111-1111-4111-8111-111111111111" }] });
    document.destroy();
  });

  it("round-trips expressive blocks into portable Markdown without losing stable identity", () => {
    const source: RichTextDocument = { type: "doc", blocks: [
      { type: "callout", kind: "note", blockKey: "11111111-1111-4111-8111-111111111111", paragraphs: [
        { id: "66666666-6666-4666-8666-666666666666", content: [{ text: "Remember this" }] },
        { id: "77777777-7777-4777-8777-777777777777", content: [{ text: "And preserve this paragraph" }] },
      ] },
      { type: "attachment", href: "./attachments/asset-id/spec%20sheet.pdf", label: "Spec sheet",
        blockKey: "22222222-2222-4222-8222-222222222222", id: "33333333-3333-4333-8333-333333333333" },
      { type: "image", src: "./attachments/image-id/diagram.png", alt: "System diagram", title: "Architecture",
        blockKey: "44444444-4444-4444-8444-444444444444" },
      { type: "table", blockKey: "55555555-5555-4555-8555-555555555555", rows: [
        [{ header: true, content: [{ text: "Owner" }] }, { header: true, content: [{ text: "State" }] }],
        [{ header: false, content: [{ text: "Ada" }] }, { header: false, content: [{ text: "Ready" }] }],
      ] },
    ] };
    const document = collaborativeDocumentFromRichText(source);
    assert.deepEqual(richTextFromCollaborativeDocument(document), source); document.destroy();
    const markdown = richTextToMarkdown(source);
    assert.match(markdown, /> \[!NOTE\]\n> Remember this/);
    assert.deepEqual(markdownToRichText(markdown), portable(source));
    assert.match(markdown, /\[Spec sheet\]\(<\.\/attachments\/asset-id\/spec%20sheet\.pdf>\)/);
    assert.match(markdown, /!\[System diagram\]\(<\.\/attachments\/image-id\/diagram\.png> "Architecture"\)/);
    assert.match(markdown, /\| Owner \| State \|\n\| --- \| --- \|\n\| Ada \| Ready \|/);
  });

  it("rejects collaborative content that violates canonical rich-text invariants", () => {
    const unsafe = collaborativeDocumentFromRichText({ type: "doc", blocks: [
      { type: "image", src: "javascript:alert(1)", alt: "Unsafe", id: "11111111-1111-4111-8111-111111111111" },
      { type: "attachment", href: "https://outside.example/file", label: "Not Workspace-owned", id: "11111111-1111-4111-8111-111111111111" },
    ] });
    assert.throws(() => validatedRichTextFromCollaborativeDocument(unsafe), InvalidCollaborationUpdate);
    unsafe.destroy();
  });

  it("allows permission-aware reads without granting collaboration edits", async () => {
    const service = new NoteCollaborationService(new MemoryRepository());
    const doc = new Y.Doc(); doc.getText("note").insert(0, "read-only");
    assert.equal((await service.load("reader", "note"))?.access, "read");
    assert.equal(await service.apply("reader", "note", Y.encodeStateAsUpdate(doc)), undefined);
  });

  it("rejects duplicate operational Block keys before canonicalizing a collaborative update", () => {
    const duplicateKey = "11111111-1111-4111-8111-111111111111";
    const unsafe = collaborativeDocumentFromRichText({ type: "doc", blocks: [
      { type: "paragraph", blockKey: duplicateKey, content: [{ text: "First target" }] },
      { type: "paragraph", blockKey: duplicateKey, content: [{ text: "Ambiguous target" }] },
    ] });
    assert.throws(() => validatedRichTextFromCollaborativeDocument(unsafe), InvalidCollaborationUpdate);
    unsafe.destroy();
  });

  it("does not reveal or accept a document without Note authority", async () => {
    const service = new NoteCollaborationService(new MemoryRepository()); const doc = new Y.Doc(); doc.getText("note").insert(0, "secret");
    assert.equal(await service.load("denied", "note"), undefined);
    assert.equal(await service.apply("denied", "note", Y.encodeStateAsUpdate(doc)), undefined);
  });
});

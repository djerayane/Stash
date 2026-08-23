import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as Y from "yjs";
import { NoteCollaborationService, type CollaborationSnapshot, type NoteCollaborationRepository } from "../src/note-collaboration.js";
import { yDocToProsemirrorJSON } from "y-prosemirror";
import { collaborativeDocumentFromRichText, richTextFromCollaborativeDocument } from "../src/postgres-database.js";
import { richTextToMarkdown, type RichTextDocument } from "../src/rich-text.js";

class MemoryRepository implements NoteCollaborationRepository {
  snapshot?: CollaborationSnapshot;
  async loadNoteCollaboration(memberId: string, noteId: string) { return ["allowed", "reader"].includes(memberId) ? this.snapshot ?? {
    noteId, sequence: 0, update: Y.encodeStateAsUpdate(new Y.Doc()), updatedAt: new Date(0).toISOString(), updatedByMemberId: memberId,
  } : undefined; }
  async appendNoteCollaboration(memberId: string, noteId: string, update: Uint8Array) {
    if (memberId !== "allowed") return undefined;
    const document = new Y.Doc(); if (this.snapshot) Y.applyUpdate(document, this.snapshot.update); Y.applyUpdate(document, update);
    return this.snapshot = { noteId, sequence: (this.snapshot?.sequence ?? 0) + 1, update: Y.encodeStateAsUpdate(document),
      updatedAt: new Date().toISOString(), updatedByMemberId: memberId };
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

  it("round-trips expressive blocks into portable Markdown without losing stable identity", () => {
    const source: RichTextDocument = { type: "doc", blocks: [
      { type: "callout", kind: "note", blockKey: "11111111-1111-4111-8111-111111111111", content: [{ text: "Remember this" }] },
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
    assert.match(markdown, /\[Spec sheet\]\(<\.\/attachments\/asset-id\/spec%20sheet\.pdf>\)/);
    assert.match(markdown, /!\[System diagram\]\(<\.\/attachments\/image-id\/diagram\.png> "Architecture"\)/);
    assert.match(markdown, /\| Owner \| State \|\n\| --- \| --- \|\n\| Ada \| Ready \|/);
  });

  it("allows permission-aware reads without granting collaboration edits", async () => {
    const service = new NoteCollaborationService(new MemoryRepository());
    const doc = new Y.Doc(); doc.getText("note").insert(0, "read-only");
    assert.ok(await service.load("reader", "note"));
    assert.equal(await service.apply("reader", "note", Y.encodeStateAsUpdate(doc)), undefined);
  });

  it("does not reveal or accept a document without Note authority", async () => {
    const service = new NoteCollaborationService(new MemoryRepository()); const doc = new Y.Doc(); doc.getText("note").insert(0, "secret");
    assert.equal(await service.load("denied", "note"), undefined);
    assert.equal(await service.apply("denied", "note", Y.encodeStateAsUpdate(doc)), undefined);
  });
});

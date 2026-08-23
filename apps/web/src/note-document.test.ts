import { describe, expect, it } from "vitest";
import { markdownToRichText, proseMirrorToRichText } from "@stash/rich-text";
import { markdownFromTiptap, toTiptap } from "./note-document";

describe("Note Markdown round trips", () => {
  it("keeps stable Block identities and portable constructs", () => {
    const document = toTiptap({ type: "doc", blocks: [
      { type: "heading", level: 2, blockKey: "stable-key", id: "linked-block", content: [{ text: "Decision", marks: ["bold"], href: "https://stash.example/decision" }] },
      { type: "check", checked: true, blockKey: "check-key", content: [{ text: "Ship it" }] },
      { type: "code", blockKey: "code-key", language: "ts", text: "const ready = true" },
    ] });
    expect(document.content?.[0]?.attrs).toMatchObject({ blockKey: "stable-key", blockId: "linked-block" });
    expect(markdownFromTiptap(document)).toBe("## [**Decision**](<https://stash.example/decision>)\n<!-- stash-block:linked-block -->\n\n- [x] Ship it\n\n```ts\nconst ready = true\n```");
  });

  it("projects tables and images to readable portable Markdown", () => {
    expect(markdownFromTiptap({ type: "doc", content: [{ type: "table", content: [
      { type: "tableRow", content: [{ type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "Owner" }] }] }, { type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "State" }] }] }] },
      { type: "tableRow", content: [{ type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "Ada" }] }] }, { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "Ready" }] }] }] },
    ] }, { type: "image", attrs: { alt: "Diagram", src: "attachments/diagram.png" } }] })).toBe("| Owner | State |\n| --- | --- |\n| Ada | Ready |\n\n![Diagram](<attachments/diagram.png>)");
  });

  it("projects callouts and Workspace Attachments to portable Markdown", () => {
    expect(markdownFromTiptap({ type: "doc", content: [
      { type: "callout", attrs: { kind: "note" }, content: [{ type: "paragraph", content: [{ type: "text", text: "Keep this context" }] }] },
      { type: "workspaceAttachment", attrs: { href: "./attachments/attachment-id/design.pdf", label: "design.pdf" } },
    ] })).toBe("> [!NOTE]\n> Keep this context\n\n[design.pdf](<./attachments/attachment-id/design.pdf>)");
  });

  it("round-trips nested lists and grouped callout paragraphs without losing linked identities", () => {
    const source = { type: "doc" as const, content: [
      { type: "taskList", content: [{ type: "taskItem", attrs: { checked: true, blockId: "11111111-1111-4111-8111-111111111111" }, content: [
        { type: "paragraph", content: [{ type: "text", text: "Parent" }] },
        { type: "bulletList", content: [{ type: "listItem", attrs: { blockId: "22222222-2222-4222-8222-222222222222" }, content: [
          { type: "paragraph", content: [{ type: "text", text: "Nested" }] },
        ] }] },
      ] }] },
      { type: "callout", attrs: { kind: "warning", blockId: "33333333-3333-4333-8333-333333333333" }, content: [
        { type: "paragraph", attrs: { blockId: "44444444-4444-4444-8444-444444444444" }, content: [{ type: "text", text: "First paragraph" }] },
        { type: "paragraph", attrs: { blockId: "55555555-5555-4555-8555-555555555555" }, content: [{ type: "text", text: "Second paragraph" }] },
      ] },
    ] };
    const canonical = proseMirrorToRichText(source);
    const markdown = markdownFromTiptap(source);
    expect(markdown).toContain("  - Nested");
    expect(markdown).toContain(">\n> Second paragraph");
    expect(markdownToRichText(markdown)).toEqual(canonical);
  });
});

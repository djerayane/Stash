import { describe, expect, it } from "vitest";
import { markdownFromTiptap, toTiptap } from "./note-document";

describe("Note Markdown round trips", () => {
  it("keeps stable Block identities and portable constructs", () => {
    const document = toTiptap({ type: "doc", blocks: [
      { type: "heading", level: 2, blockKey: "stable-key", id: "linked-block", content: [{ text: "Decision", marks: ["bold"], href: "https://stash.example/decision" }] },
      { type: "check", checked: true, blockKey: "check-key", content: [{ text: "Ship it" }] },
      { type: "code", blockKey: "code-key", language: "ts", text: "const ready = true" },
    ] });
    expect(document.content?.[0]?.attrs).toMatchObject({ blockKey: "stable-key", blockId: "linked-block" });
    expect(markdownFromTiptap(document)).toBe("## [**Decision**](<https://stash.example/decision>)\n\n- [x] Ship it\n\n```ts\nconst ready = true\n```");
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
});

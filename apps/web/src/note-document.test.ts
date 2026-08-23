import { describe, expect, it } from "vitest";
import { markdownFromTiptap, toTiptap } from "./note-document";

describe("Note Markdown round trips", () => {
  it("keeps stable Block identities and portable constructs", () => {
    const document = toTiptap({ type: "doc", blocks: [
      { type: "heading", level: 2, blockKey: "stable-key", id: "linked-block", content: [{ text: "Decision" }] },
      { type: "check", checked: true, blockKey: "check-key", content: [{ text: "Ship it" }] },
      { type: "code", blockKey: "code-key", language: "ts", text: "const ready = true" },
    ] });
    expect(document.content?.[0]?.attrs).toMatchObject({ blockKey: "stable-key", blockId: "linked-block" });
    expect(markdownFromTiptap(document)).toBe("## Decision\n\n- [x] Ship it\n\n```ts\nconst ready = true\n```");
  });
});

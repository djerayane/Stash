import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { markdownToRichText, richTextToMarkdown, UnsupportedMarkdown, type RichTextDocument, type RichTextSpan } from "../src/rich-text.js";

describe("portable rich-text Markdown", () => {
  it("round-trips every supported foundation construct", () => {
    const document: RichTextDocument = { type: "doc", blocks: [
      { type: "heading", level: 2, content: [{ text: "Heading" }] },
      { type: "paragraph", content: [{ text: "Bold", marks: ["bold"] }] },
      { type: "paragraph", content: [{ text: "Italic", marks: ["italic"] }] },
      { type: "paragraph", content: [{ text: "Code", marks: ["code"] }] },
      { type: "paragraph", content: [{ text: "Link", href: "https://example.test/path" }] },
      { type: "quote", content: [{ text: "Quoted" }] },
      { type: "bullet", content: [{ text: "Listed" }] },
      { type: "check", checked: true, id: "44444444-4444-4444-8444-444444444444", content: [{ text: "Checked" }] },
      { type: "code", language: "typescript", text: "const value = 1;" },
    ] };
    const markdown = richTextToMarkdown(document);
    assert.deepEqual(markdownToRichText(markdown), document);
  });

  it("surfaces unsupported downstream constructs instead of discarding them", () => {
    for (const markdown of [":::callout\ntext"])
      assert.throws(() => markdownToRichText(markdown), UnsupportedMarkdown);
  });

  it("round-trips portable callouts, attachments, images, and tables", () => {
    const document: RichTextDocument = { type: "doc", blocks: [
      { type: "callout", kind: "note", paragraphs: [{ content: [{ text: "Remember this" }] }] },
      { type: "attachment", href: "./attachments/asset/spec%20sheet.pdf", label: "Spec sheet" },
      { type: "image", src: "./attachments/image/diagram.png", alt: "Diagram", title: "Architecture" },
      { type: "table", rows: [[{ header: true, content: [{ text: "Owner" }] }, { header: true, content: [{ text: "State" }] }],
        [{ header: false, content: [{ text: "Ada" }] }, { header: false, content: [{ text: "Ready" }] }]] },
    ] };
    assert.deepEqual(markdownToRichText(richTextToMarkdown(document)), document);
  });

  it("round-trips mixed and nested inline content without delimiter guessing", () => {
    const cases: RichTextSpan[][] = [
      [{ text: "plain " }, { text: "bold", marks: ["bold"] }, { text: " tail" }],
      [{ text: "nested", marks: ["bold", "italic"] }, { text: " and " }, { text: "a`b", marks: ["code"] }],
      [{ text: "escaped *_[]<>" }, { text: "linked", marks: ["italic"], href: "https://example.test/a(b)" }],
    ];
    for (const content of cases) {
      const document = { type: "doc" as const, blocks: [{ type: "paragraph" as const, content }] };
      assert.deepEqual(markdownToRichText(richTextToMarkdown(document)), document);
    }
  });
});

import type { RichTextBlock } from "@stash/domain-types";
import type { JSONContent } from "@tiptap/react";

export interface NoteDocument { type: "doc"; blocks: RichTextBlock[] }

const text = (value: string): JSONContent[] => value ? [{ type: "text", text: value }] : [];
const blockText = (block: RichTextBlock) => "text" in block ? block.text : block.content.map((span) => span.text).join("");

export function toTiptap(document: NoteDocument): JSONContent {
  return { type: "doc", content: document.blocks.map((block) => {
    const attrs = { blockKey: block.blockKey ?? crypto.randomUUID(), blockId: block.id ?? null };
    if (block.type === "heading") return { type: "heading", attrs: { ...attrs, level: block.level }, content: text(blockText(block)) };
    if (block.type === "code") return { type: "codeBlock", attrs: { ...attrs, language: block.language ?? null }, content: text(block.text) };
    if (block.type === "quote") return { type: "blockquote", attrs, content: [{ type: "paragraph", content: text(blockText(block)) }] };
    if (block.type === "bullet") return { type: "bulletList", attrs, content: [{ type: "listItem", content: [{ type: "paragraph", content: text(blockText(block)) }] }] };
    if (block.type === "check") return { type: "taskList", attrs, content: [{ type: "taskItem", attrs: { checked: block.checked }, content: [{ type: "paragraph", content: text(blockText(block)) }] }] };
    return { type: "paragraph", attrs, content: text(blockText(block)) };
  }) };
}

export function markdownFromTiptap(document: JSONContent): string {
  return (document.content ?? []).map((node) => {
    const value = plainText(node);
    if (node.type === "heading") return `${"#".repeat(Number(node.attrs?.level ?? 1))} ${value}`;
    if (node.type === "codeBlock") return `\`\`\`${node.attrs?.language ?? ""}\n${value}\n\`\`\``;
    if (node.type === "blockquote") return value.split("\n").map((line) => `> ${line}`).join("\n");
    if (node.type === "bulletList") return `- ${value}`;
    if (node.type === "taskList") return `- [${node.content?.[0]?.attrs?.checked ? "x" : " "}] ${value}`;
    if (node.type === "image") return `![${node.attrs?.alt ?? ""}](${node.attrs?.src ?? ""})`;
    return value;
  }).join("\n\n");
}

function plainText(node: JSONContent): string {
  if (node.type === "text") return node.text ?? "";
  return (node.content ?? []).map(plainText).join("");
}

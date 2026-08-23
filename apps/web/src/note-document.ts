import type { RichTextBlock } from "@stash/domain-types";
import type { JSONContent } from "@tiptap/react";

export interface NoteDocument { type: "doc"; blocks: RichTextBlock[] }

const text = (value: string): JSONContent[] => value ? [{ type: "text", text: value }] : [];
const inline = (block: Exclude<RichTextBlock, { type: "code" }>): JSONContent[] => block.content.map((span) => ({ type: "text", text: span.text,
  ...((span.marks?.length || span.href) ? { marks: [...(span.marks ?? []).map((type) => ({ type })), ...(span.href ? [{ type: "link", attrs: { href: span.href } }] : [])] } : {}) }));

export function toTiptap(document: NoteDocument): JSONContent {
  return { type: "doc", content: document.blocks.map((block) => {
    const attrs = { blockKey: block.blockKey ?? crypto.randomUUID(), blockId: block.id ?? null };
    if (block.type === "heading") return { type: "heading", attrs: { ...attrs, level: block.level }, content: inline(block) };
    if (block.type === "code") return { type: "codeBlock", attrs: { ...attrs, language: block.language ?? null }, content: text(block.text) };
    if (block.type === "quote") return { type: "blockquote", attrs, content: [{ type: "paragraph", content: inline(block) }] };
    if (block.type === "bullet") return { type: "bulletList", attrs, content: [{ type: "listItem", content: [{ type: "paragraph", content: inline(block) }] }] };
    if (block.type === "check") return { type: "taskList", attrs, content: [{ type: "taskItem", attrs: { checked: block.checked }, content: [{ type: "paragraph", content: inline(block) }] }] };
    return { type: "paragraph", attrs, content: inline(block) };
  }) };
}

export function markdownFromTiptap(document: JSONContent): string {
  return (document.content ?? []).map((node) => {
    const value = portableText(node);
    if (node.type === "heading") return `${"#".repeat(Number(node.attrs?.level ?? 1))} ${value}`;
    if (node.type === "codeBlock") return `\`\`\`${node.attrs?.language ?? ""}\n${value}\n\`\`\``;
    if (node.type === "blockquote") return value.split("\n").map((line) => `> ${line}`).join("\n");
    if (node.type === "bulletList") return `- ${value}`;
    if (node.type === "taskList") return `- [${node.content?.[0]?.attrs?.checked ? "x" : " "}] ${value}`;
    if (node.type === "image") return `![${node.attrs?.alt ?? ""}](${node.attrs?.src ?? ""})`;
    if (node.type === "table") {
      const rows = (node.content ?? []).map((row) => (row.content ?? []).map((cell) => portableText(cell).replaceAll("|", "\\|")).join(" | "));
      return rows.length ? `| ${rows[0]} |\n| ${(node.content?.[0]?.content ?? []).map(() => "---").join(" | ")} |${rows.slice(1).map((row) => `\n| ${row} |`).join("")}` : "";
    }
    return value;
  }).join("\n\n");
}

function portableText(node: JSONContent): string {
  if (node.type !== "text") return (node.content ?? []).map(portableText).join("");
  let value = node.text ?? "";
  for (const mark of node.marks ?? []) {
    if (mark.type === "code") value = `\`${value}\``;
    else if (mark.type === "italic") value = `_${value}_`;
    else if (mark.type === "bold") value = `**${value}**`;
    else if (mark.type === "link") value = `[${value}](<${mark.attrs?.href}>)`;
  }
  return value;
}

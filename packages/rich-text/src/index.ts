import type { RichTextBlock, RichTextSpan } from "@stash/domain-types";
import { richTextToMarkdown } from "./domain.js";

export * from "./domain.js";

export interface RichTextDocument { type: "doc"; blocks: RichTextBlock[] }
export interface ProseMirrorNode {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
  content?: ProseMirrorNode[];
}

const text = (value: string): ProseMirrorNode[] => value ? [{ type: "text", text: value }] : [];
const inline = (spans: RichTextSpan[]): ProseMirrorNode[] => spans.map((span) => ({ type: "text", text: span.text,
  ...((span.marks?.length || span.href) ? { marks: [...(span.marks ?? []).map((type) => ({ type })),
    ...(span.href ? [{ type: "link", attrs: { href: span.href } }] : [])] } : {}) }));

export function richTextToProseMirror(document: RichTextDocument, createBlockKey?: () => string): ProseMirrorNode {
  return { type: "doc", content: document.blocks.map((block) => {
    const attrs = { blockKey: block.blockKey ?? createBlockKey?.() ?? null, blockId: block.id ?? null };
    if (block.type === "heading") return { type: "heading", attrs: { ...attrs, level: block.level }, content: inline(block.content) };
    if (block.type === "code") return { type: "codeBlock", attrs: { ...attrs, language: block.language ?? null }, content: text(block.text) };
    if (block.type === "quote") return { type: "blockquote", attrs, content: [{ type: "paragraph", attrs, content: inline(block.content) }] };
    if (block.type === "bullet") return { type: "bulletList", content: [{ type: "listItem", attrs, content: [{ type: "paragraph", content: inline(block.content) }] }] };
    if (block.type === "check") return { type: "taskList", content: [{ type: "taskItem", attrs: { ...attrs, checked: block.checked }, content: [{ type: "paragraph", content: inline(block.content) }] }] };
    if (block.type === "callout") return { type: "callout", attrs: { ...attrs, kind: block.kind }, content: [{ type: "paragraph", content: inline(block.content) }] };
    if (block.type === "attachment") return { type: "workspaceAttachment", attrs: { ...attrs, href: block.href, label: block.label } };
    if (block.type === "image") return { type: "image", attrs: { ...attrs, src: block.src, alt: block.alt, title: block.title ?? null } };
    if (block.type === "table") return { type: "table", attrs, content: block.rows.map((row) => ({ type: "tableRow", content: row.map((cell) => ({
      type: cell.header ? "tableHeader" : "tableCell", content: [{ type: "paragraph", content: inline(cell.content) }],
    })) })) };
    return { type: "paragraph", attrs, content: inline(block.content) };
  }) };
}

export function proseMirrorToRichText(source: ProseMirrorNode): RichTextDocument {
  const readInline = (nodes: ProseMirrorNode[] | undefined): RichTextSpan[] => {
    const spans = (nodes ?? []).filter((node) => node.type === "text").map((node) => {
      const marks = (node.marks ?? []).map((mark) => mark.type).filter((type): type is "bold" | "italic" | "code" => ["bold", "italic", "code"].includes(type));
      const link = (node.marks ?? []).find((mark) => mark.type === "link");
      const href = link?.attrs?.href;
      return { text: node.text ?? "", ...(marks.length ? { marks } : {}), ...(typeof href === "string" && href ? { href } : {}) };
    });
    return spans.length ? spans : [{ text: "" }];
  };
  const identity = (node: ProseMirrorNode) => ({ ...(typeof node.attrs?.blockKey === "string" && node.attrs.blockKey ? { blockKey: node.attrs.blockKey } : {}),
    ...(typeof node.attrs?.blockId === "string" && node.attrs.blockId ? { id: node.attrs.blockId } : {}) });
  const listItems = (node: ProseMirrorNode, type: "bullet" | "check"): RichTextBlock[] => (node.content ?? []).flatMap((item) => {
    const [paragraph, ...descendants] = item.content ?? [];
    const current: RichTextBlock = type === "check"
      ? { type, checked: Boolean(item.attrs?.checked), ...identity(item), content: readInline(paragraph?.content) }
      : { type, ...identity(item), content: readInline(paragraph?.content) };
    return [current, ...descendants.flatMap(convertNode)];
  });
  function convertNode(node: ProseMirrorNode): RichTextBlock[] {
    if (node.type === "heading") return [{ type: "heading", level: [1, 2, 3].includes(Number(node.attrs?.level)) ? Number(node.attrs?.level) as 1 | 2 | 3 : 1, ...identity(node), content: readInline(node.content) }];
    if (node.type === "codeBlock") return [{ type: "code", ...identity(node), ...(typeof node.attrs?.language === "string" && node.attrs.language ? { language: node.attrs.language } : {}), text: (node.content ?? []).map((child) => child.text ?? "").join("") }];
    if (node.type === "blockquote") return (node.content ?? []).map((child) => ({ type: "quote" as const, ...identity(child), content: readInline(child.content) }));
    if (node.type === "bulletList") return listItems(node, "bullet");
    if (node.type === "taskList") return listItems(node, "check");
    if (node.type === "callout") { const kind = ["note", "tip", "warning"].includes(String(node.attrs?.kind)) ? node.attrs?.kind as "note" | "tip" | "warning" : "note";
      return (node.content ?? []).map((child, index) => ({ type: "callout" as const, kind, ...identity(index === 0 ? node : child), content: readInline(child.content) })); }
    if (node.type === "workspaceAttachment") return [{ type: "attachment", ...identity(node), href: String(node.attrs?.href ?? ""), label: String(node.attrs?.label ?? "Attachment") }];
    if (node.type === "image") return [{ type: "image", ...identity(node), src: String(node.attrs?.src ?? ""), alt: String(node.attrs?.alt ?? ""), ...(typeof node.attrs?.title === "string" && node.attrs.title ? { title: node.attrs.title } : {}) }];
    if (node.type === "table") return [{ type: "table", ...identity(node), rows: (node.content ?? []).map((row) => (row.content ?? []).map((cell) => ({ header: cell.type === "tableHeader", content: readInline(cell.content?.[0]?.content) }))) }];
    return [{ type: "paragraph", ...identity(node), content: readInline(node.content) }];
  }
  const blocks = (source.content ?? []).flatMap(convertNode);
  return { type: "doc", blocks: blocks.length ? blocks : [{ type: "paragraph", content: [{ text: "" }] }] };
}

export function proseMirrorToMarkdown(document: ProseMirrorNode): string {
  return richTextToMarkdown(proseMirrorToRichText(document));
}

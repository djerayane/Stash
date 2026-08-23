import type { RichTextBlock, RichTextSpan, RichTextTableCell } from "@stash/domain-types";

export type { RichTextBlock, RichTextMark, RichTextSpan, RichTextTableCell } from "@stash/domain-types";

export interface RichTextDocument { type: "doc"; blocks: RichTextBlock[] }

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const safeLink = /^(https?:\/\/|mailto:|\/|\.\.\/|\.\/|#)/;
const safeCodeLanguage = /^[a-z0-9_+.-]{1,64}$/i;

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validContent(value: unknown): value is RichTextSpan[] {
  return Array.isArray(value) && value.length > 0 && value.every((span) => {
    if (!plainObject(span) || typeof span.text !== "string") return false;
    if (span.marks !== undefined && (!Array.isArray(span.marks)
      || new Set(span.marks).size !== span.marks.length
      || span.marks.some((mark) => !["bold", "italic", "code"].includes(String(mark))))) return false;
    if (span.href !== undefined && (typeof span.href !== "string" || !safeLink.test(span.href)
      || /[\s<>]/.test(span.href))) return false;
    return Object.keys(span).every((key) => ["text", "marks", "href"].includes(key));
  });
}

export function isRichTextDocument(value: unknown): value is RichTextDocument {
  if (!plainObject(value) || value.type !== "doc" || !Array.isArray(value.blocks)
    || value.blocks.length === 0 || value.blocks.length > 10_000
    || !Object.keys(value).every((key) => ["type", "blocks"].includes(key))) return false;
  const identifiers = new Set<string>();
  return value.blocks.every((block) => {
    if (!plainObject(block) || typeof block.type !== "string") return false;
    if (block.id !== undefined && (typeof block.id !== "string" || !uuid.test(block.id)
      || identifiers.has(block.id))) return false;
    if (typeof block.id === "string") identifiers.add(block.id);
    if (block.type === "code") {
      return typeof block.text === "string" && block.text.length > 0
        && (block.language === undefined || (typeof block.language === "string" && safeCodeLanguage.test(block.language)))
        && (block.blockKey === undefined || typeof block.blockKey === "string" && uuid.test(block.blockKey))
        && Object.keys(block).every((key) => ["type", "blockKey", "id", "text", "language"].includes(key));
    }
    if (block.type === "callout") return ["note", "tip", "warning"].includes(String(block.kind)) && validContent(block.content)
      && (block.blockKey === undefined || typeof block.blockKey === "string" && uuid.test(block.blockKey))
      && Object.keys(block).every((key) => ["type", "kind", "blockKey", "id", "content"].includes(key));
    if (block.type === "attachment") return typeof block.href === "string" && /^\.\/attachments\/[^\s<>]+$/.test(block.href)
      && typeof block.label === "string" && block.label.length > 0
      && (block.blockKey === undefined || typeof block.blockKey === "string" && uuid.test(block.blockKey))
      && Object.keys(block).every((key) => ["type", "href", "label", "blockKey", "id"].includes(key));
    if (block.type === "image") return typeof block.src === "string" && safeLink.test(block.src) && typeof block.alt === "string"
      && (block.title === undefined || typeof block.title === "string")
      && (block.blockKey === undefined || typeof block.blockKey === "string" && uuid.test(block.blockKey))
      && Object.keys(block).every((key) => ["type", "src", "alt", "title", "blockKey", "id"].includes(key));
    if (block.type === "table") { const rows = block.rows; return Array.isArray(rows) && rows.length > 0
      && rows.every((row) => Array.isArray(row) && row.length > 0 && row.every((cell) => plainObject(cell)
        && typeof cell.header === "boolean" && validContent(cell.content) && Object.keys(cell).every((key) => ["header", "content"].includes(key))))
      && rows.every((row) => row.length === rows[0]!.length)
      && (block.blockKey === undefined || typeof block.blockKey === "string" && uuid.test(block.blockKey))
      && Object.keys(block).every((key) => ["type", "rows", "blockKey", "id"].includes(key)); }
    if (!["paragraph", "quote", "bullet", "heading", "check"].includes(block.type)
      || !validContent(block.content)) return false;
    if (block.type === "heading" && ![1, 2, 3].includes(Number(block.level))) return false;
    if (block.type === "check" && typeof block.checked !== "boolean") return false;
    if (block.blockKey !== undefined && (typeof block.blockKey !== "string" || !uuid.test(block.blockKey))) return false;
    const allowed = block.type === "heading" ? ["type", "blockKey", "id", "level", "content"]
      : block.type === "check" ? ["type", "blockKey", "id", "checked", "content"] : ["type", "blockKey", "id", "content"];
    return Object.keys(block).every((key) => allowed.includes(key));
  });
}

export function escapeMarkdownText(text: string): string {
  return text.replace(/([\\`*_{}\[\]<>])/g, "\\$1");
}

function renderSpan(span: RichTextSpan): string {
  let text = escapeMarkdownText(span.text);
  const marks = new Set(span.marks ?? []);
  if (marks.has("code")) {
    const longestRun = Math.max(0, ...(span.text.match(/`+/g) ?? []).map((run) => run.length));
    const fence = "`".repeat(longestRun + 1);
    const needsPadding = longestRun > 0 || span.text.startsWith("`") || span.text.endsWith("`")
      || (span.text.startsWith(" ") && span.text.endsWith(" ") && span.text.trim().length > 0);
    text = `${fence}${needsPadding ? " " : ""}${span.text}${needsPadding ? " " : ""}${fence}`;
  }
  if (marks.has("italic")) text = `_${text}_`;
  if (marks.has("bold")) text = `**${text}**`;
  return span.href ? `[${text}](<${span.href}>)` : text;
}

export function richTextToMarkdown(document: RichTextDocument): string {
  return document.blocks.map((block) => {
    const identity = block.id ? `\n<!-- stash-block:${block.id} -->` : "";
    if (block.type === "code") {
      const longestRun = Math.max(0, ...(block.text.match(/`+/g) ?? []).map((run) => run.length));
      const fence = "`".repeat(Math.max(3, longestRun + 1));
      return `${fence}${block.language ?? ""}\n${block.text}\n${fence}${identity}`;
    }
    if (block.type === "callout") return `> [!${block.kind.toUpperCase()}]\n${block.content.map(renderSpan).join("").split("\n").map((line) => `> ${line}`).join("\n")}${identity}`;
    if (block.type === "attachment") return `[${escapeMarkdownText(block.label)}](<${block.href}>)${identity}`;
    if (block.type === "image") return `![${escapeMarkdownText(block.alt)}](<${block.src}>${block.title ? ` \"${block.title.replaceAll('"', '\\"')}\"` : ""})${identity}`;
    if (block.type === "table") {
      const renderCell = (cell: RichTextTableCell) => cell.content.map(renderSpan).join("").replaceAll("|", "\\|");
      const rows = block.rows.map((row) => `| ${row.map(renderCell).join(" | ")} |`);
      rows.splice(1, 0, `| ${block.rows[0]!.map(() => "---").join(" | ")} |`);
      return `${rows.join("\n")}${identity}`;
    }
    const content = block.content.map(renderSpan).join("");
    const markdown = block.type === "heading" ? `${"#".repeat(block.level)} ${content}`
      : block.type === "quote" ? `> ${content}`
      : block.type === "bullet" ? `- ${content}`
      : block.type === "check" ? `- [${block.checked ? "x" : " "}] ${content}` : content;
    return markdown + identity;
  }).join("\n\n");
}

export function paragraphDocument(content: string, blockKey?: string): RichTextDocument {
  return { type: "doc", blocks: [{ type: "paragraph", ...(blockKey ? { blockKey } : {}), content: [{ text: content }] }] };
}

export class UnsupportedMarkdown extends Error {}

function parseInline(text: string): RichTextSpan[] {
  const spans: RichTextSpan[] = [];
  const append = (span: RichTextSpan) => {
    if (span.marks) span = { ...span, marks: [...span.marks].sort((left, right) => ["bold", "italic", "code"].indexOf(left) - ["bold", "italic", "code"].indexOf(right)) };
    const previous = spans.at(-1);
    if (previous && JSON.stringify(previous.marks ?? []) === JSON.stringify(span.marks ?? []) && previous.href === span.href) previous.text += span.text;
    else spans.push(span);
  };
  let index = 0;
  while (index < text.length) {
    if (text[index] === "\\" && index + 1 < text.length) { append({ text: text[index + 1]! }); index += 2; continue; }
    const link = text.slice(index).match(/^\[([\s\S]*?)\]\(<([^>]+)>\)/);
    if (link) { for (const span of parseInline(link[1]!)) append({ ...span, href: link[2]! }); index += link[0].length; continue; }
    if (text.startsWith("**", index)) { const end = text.indexOf("**", index + 2); if (end >= 0) {
      for (const span of parseInline(text.slice(index + 2, end))) append({ ...span, marks: [...new Set([...(span.marks ?? []), "bold" as const])] }); index = end + 2; continue; } }
    if (text[index] === "_") { const end = text.indexOf("_", index + 1); if (end >= 0) {
      for (const span of parseInline(text.slice(index + 1, end))) append({ ...span, marks: [...new Set([...(span.marks ?? []), "italic" as const])] }); index = end + 1; continue; } }
    if (text[index] === "`") { const run = text.slice(index).match(/^`+/)![0]; const end = text.indexOf(run, index + run.length); if (end >= 0) {
      let content = text.slice(index + run.length, end); if (content.startsWith(" ") && content.endsWith(" ") && content.trim()) content = content.slice(1, -1);
      append({ text: content, marks: ["code"] }); index = end + run.length; continue; } }
    let end = index + 1;
    while (end < text.length && !["\\", "[", "_", "`"].includes(text[end]!) && !text.startsWith("**", end)) end += 1;
    append({ text: text.slice(index, end) }); index = end;
  }
  return spans;
}

export function markdownToRichText(markdown: string): RichTextDocument {
  if (!markdown.trim() || /^:::/m.test(markdown)) throw new UnsupportedMarkdown("Unsupported Markdown construct");
  const chunks = markdown.trim().split(/\n\n+/);
  const blocks: RichTextBlock[] = [];
  for (let index = 0; index < chunks.length; index += 1) {
    let chunk = chunks[index]!;
    const identity = chunk.match(/\n<!-- stash-block:([0-9a-f-]+) -->$/i);
    if (identity) chunk = chunk.slice(0, identity.index);
    const id = identity?.[1];
    const code = chunk.match(/^(`{3,})([a-z0-9_+.-]*)\n([\s\S]*)\n\1$/i);
    if (code) { blocks.push({ type: "code", text: code[3]!, ...(code[2] ? { language: code[2] } : {}), ...(id ? { id } : {}) }); continue; }
    const callout = chunk.match(/^> \[!(NOTE|TIP|WARNING)\]\n((?:> ?.*(?:\n|$))+)/i);
    if (callout) { blocks.push({ type: "callout", kind: callout[1]!.toLowerCase() as "note" | "tip" | "warning",
      content: parseInline(callout[2]!.replace(/^> ?/gm, "").trimEnd()), ...(id ? { id } : {}) }); continue; }
    const attachment = chunk.match(/^\[([^\]]+)\]\(<(\.\/attachments\/[^\s<>]+)>\)$/);
    if (attachment) { blocks.push({ type: "attachment", label: attachment[1]!, href: attachment[2]!, ...(id ? { id } : {}) }); continue; }
    const image = chunk.match(/^!\[([^\]]*)\]\(<([^>]+)>(?: "((?:\\"|[^"])*)")?\)$/);
    if (image) { blocks.push({ type: "image", alt: image[1]!, src: image[2]!, ...(image[3] ? { title: image[3].replaceAll('\\"', '"') } : {}),
      ...(id ? { id } : {}) }); continue; }
    const tableLines = chunk.split("\n");
    if (tableLines.length >= 2 && /^\|.*\|$/.test(tableLines[0]!) && /^\|(?:\s*:?-+:?\s*\|)+$/.test(tableLines[1]!)) {
      const cells = (line: string) => line.slice(1, -1).split(/(?<!\\)\|/).map((cell) => parseInline(cell.trim().replaceAll("\\|", "|")));
      const rows = [tableLines[0]!, ...tableLines.slice(2)].map((line, row) => cells(line).map((content) => ({ header: row === 0, content })));
      if (!rows.length || rows.some((row) => row.length !== rows[0]!.length)) throw new UnsupportedMarkdown("Malformed table");
      blocks.push({ type: "table", rows, ...(id ? { id } : {}) }); continue;
    }
    let type: "paragraph" | "quote" | "bullet" | "heading" | "check" = "paragraph";
    let level: 1 | 2 | 3 | undefined; let checked = false;
    const heading = chunk.match(/^(#{1,3}) (.*)$/s);
    if (heading) { type = "heading"; level = heading[1]!.length as 1 | 2 | 3; chunk = heading[2]!; }
    else if (chunk.startsWith("> ")) { type = "quote"; chunk = chunk.slice(2); }
    else { const check = chunk.match(/^- \[([ x])\] (.*)$/s); if (check) { type = "check"; checked = check[1] === "x"; chunk = check[2]!; }
      else if (chunk.startsWith("- ")) { type = "bullet"; chunk = chunk.slice(2); } }
    const base = { content: parseInline(chunk), ...(id ? { id } : {}) };
    blocks.push(type === "heading" ? { type, level: level!, ...base } : type === "check" ? { type, checked, ...base } : { type, ...base });
  }
  return { type: "doc", blocks };
}

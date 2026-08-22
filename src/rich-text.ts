export type RichTextMark = "bold" | "italic" | "code";

export interface RichTextSpan {
  text: string;
  marks?: RichTextMark[];
  href?: string;
}

export type RichTextBlock =
  | { type: "paragraph" | "quote" | "bullet"; id?: string; content: RichTextSpan[] }
  | { type: "heading"; level: 1 | 2 | 3; id?: string; content: RichTextSpan[] }
  | { type: "check"; checked: boolean; id?: string; content: RichTextSpan[] }
  | { type: "code"; language?: string; id?: string; text: string };

export interface RichTextDocument {
  type: "doc";
  blocks: RichTextBlock[];
}

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
        && Object.keys(block).every((key) => ["type", "id", "text", "language"].includes(key));
    }
    if (!["paragraph", "quote", "bullet", "heading", "check"].includes(block.type)
      || !validContent(block.content)) return false;
    if (block.type === "heading" && ![1, 2, 3].includes(Number(block.level))) return false;
    if (block.type === "check" && typeof block.checked !== "boolean") return false;
    const allowed = block.type === "heading" ? ["type", "id", "level", "content"]
      : block.type === "check" ? ["type", "id", "checked", "content"] : ["type", "id", "content"];
    return Object.keys(block).every((key) => allowed.includes(key));
  });
}

function renderSpan(span: RichTextSpan): string {
  let text = span.text.replace(/([\\`*_{}\[\]<>])/g, "\\$1");
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
    const content = block.content.map(renderSpan).join("");
    const markdown = block.type === "heading" ? `${"#".repeat(block.level)} ${content}`
      : block.type === "quote" ? `> ${content}`
      : block.type === "bullet" ? `- ${content}`
      : block.type === "check" ? `- [${block.checked ? "x" : " "}] ${content}` : content;
    return markdown + identity;
  }).join("\n\n");
}

export function paragraphDocument(content: string): RichTextDocument {
  return { type: "doc", blocks: [{ type: "paragraph", content: [{ text: content }] }] };
}

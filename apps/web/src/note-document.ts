import type { RichTextBlock } from "@stash/domain-types";
import { proseMirrorToMarkdown, richTextToProseMirror } from "@stash/rich-text";
import type { JSONContent } from "@tiptap/react";

export interface NoteDocument { type: "doc"; blocks: RichTextBlock[] }

export function toTiptap(document: NoteDocument): JSONContent {
  return richTextToProseMirror(document, () => crypto.randomUUID()) as JSONContent;
}

export function markdownFromTiptap(document: JSONContent): string {
  return proseMirrorToMarkdown(document);
}

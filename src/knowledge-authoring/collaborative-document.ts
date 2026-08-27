import { isRichTextDocument } from "../rich-text.js";
import { InvalidCollaborationUpdate } from "../note-collaboration.js";
import { proseMirrorToRichText, richTextToProseMirror } from "@stash/rich-text";
import { Schema } from "prosemirror-model";
import { prosemirrorJSONToYDoc, yDocToProsemirrorJSON } from "y-prosemirror";
import * as Y from "yjs";

const collaborationSchema = new Schema({
  nodes: {
    doc: { content: "block+" }, text: { group: "inline" },
    paragraph: { group: "block", content: "inline*", attrs: { blockKey: { default: null }, blockId: { default: null } } },
    heading: { group: "block", content: "inline*", attrs: { level: { default: 1 }, blockKey: { default: null }, blockId: { default: null } } },
    codeBlock: { group: "block", content: "text*", marks: "", code: true, attrs: { language: { default: null }, blockKey: { default: null }, blockId: { default: null } } },
    blockquote: { group: "block", content: "block+", attrs: { blockKey: { default: null }, blockId: { default: null } } },
    bulletList: { group: "block", content: "listItem+", attrs: { blockKey: { default: null }, blockId: { default: null } } },
    listItem: { content: "paragraph block*", attrs: { blockKey: { default: null }, blockId: { default: null } } },
    taskList: { group: "block", content: "taskItem+", attrs: { blockKey: { default: null }, blockId: { default: null } } },
    taskItem: { content: "paragraph block*", attrs: { checked: { default: false }, blockKey: { default: null }, blockId: { default: null } } },
    callout: { group: "block", content: "block+", attrs: { blockKey: { default: null }, blockId: { default: null }, kind: { default: "note" } } },
    workspaceAttachment: { group: "block", atom: true, attrs: { blockKey: { default: null }, blockId: { default: null }, href: {}, label: {} } },
    image: { group: "block", atom: true, attrs: { blockKey: { default: null }, blockId: { default: null }, src: {}, alt: { default: "" }, title: { default: null } } },
    table: { group: "block", content: "tableRow+", tableRole: "table", attrs: { blockKey: { default: null }, blockId: { default: null } } },
    tableRow: { content: "(tableCell|tableHeader)+", tableRole: "row" },
    tableCell: { content: "paragraph", tableRole: "cell", attrs: { colspan: { default: 1 }, rowspan: { default: 1 }, colwidth: { default: null } } },
    tableHeader: { content: "paragraph", tableRole: "header_cell", attrs: { colspan: { default: 1 }, rowspan: { default: 1 }, colwidth: { default: null } } },
  },
  marks: { bold: {}, italic: {}, code: { code: true }, link: { attrs: { href: {} }, inclusive: false } },
});

export function collaborativeDocumentFromRichText(document: import("../rich-text.js").RichTextDocument): Y.Doc {
  return prosemirrorJSONToYDoc(collaborationSchema, richTextToProseMirror(document), "default");
}

export function richTextFromCollaborativeDocument(document: Y.Doc): import("../rich-text.js").RichTextDocument {
  return proseMirrorToRichText(yDocToProsemirrorJSON(document, "default"));
}

export function validatedRichTextFromCollaborativeDocument(document: Y.Doc): import("../rich-text.js").RichTextDocument {
  const materialized = richTextFromCollaborativeDocument(document);
  if (!isRichTextDocument(materialized)) throw new InvalidCollaborationUpdate();
  return materialized;
}

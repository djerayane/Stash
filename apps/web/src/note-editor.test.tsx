import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { Schema } from "@tiptap/pm/model";
import { prosemirrorJSONToYDoc } from "y-prosemirror";
import * as Y from "yjs";
import { applyAcknowledgedUpdate, createSerializedSynchronization, encodeUpdateBase64, NoteEditor } from "./note-editor";

const emptyUpdate = () => btoa(String.fromCharCode(...Y.encodeStateAsUpdate(new Y.Doc())));
const collaborationSchema = new Schema({ nodes: {
  doc: { content: "block+" }, text: { group: "inline" },
  paragraph: { group: "block", content: "inline*", attrs: { blockKey: { default: null }, blockId: { default: null } } },
} });
const collaborativeUpdate = (text: string, blockKey: string) => {
  const document = prosemirrorJSONToYDoc(collaborationSchema, { type: "doc", content: [
    { type: "paragraph", attrs: { blockKey, blockId: null }, content: [{ type: "text", text }] },
  ] }, "default");
  return btoa(String.fromCharCode(...Y.encodeStateAsUpdate(document)));
};
const storage = new Map<string, string>();
beforeEach(() => {
  storage.clear();
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
});

it("does not acknowledge an unsent local contribution when an older server snapshot is polled", () => {
  const server = new Y.Doc(); server.getText("note").insert(0, "Published");
  const published = Y.encodeStateAsUpdate(server);
  const local = new Y.Doc(); let acknowledged = applyAcknowledgedUpdate(local, published);
  local.getText("note").insert(local.getText("note").length, " plus offline work");
  acknowledged = applyAcknowledgedUpdate(local, published);
  const stillPending = Y.encodeStateAsUpdate(local, acknowledged);
  const restoredServer = new Y.Doc(); Y.applyUpdate(restoredServer, published); Y.applyUpdate(restoredServer, stillPending);
  expect(restoredServer.getText("note").toString()).toBe("Published plus offline work");
  expect(stillPending.byteLength).toBeGreaterThan(2);
});

it("encodes updates up to the server limit without overflowing the browser call stack", () => {
  const update = new Uint8Array(1_048_576);
  for (let index = 0; index < update.length; index += 1) update[index] = index % 251;
  expect(Uint8Array.from(atob(encodeUpdateBase64(update)), (character) => character.charCodeAt(0))).toEqual(update);
});

it("loads an authorized collaborative Note and exposes keyboard-operable rich-text controls", async () => {
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/collaboration")) return new Response(JSON.stringify({ sequence: 0, update: emptyUpdate(), updatedAt: new Date(0).toISOString(), updatedByMemberId: "ada" }));
    return new Response(JSON.stringify({ id: "note", revision: 1, content: "Release plan", document: { type: "doc", blocks: [
      { type: "paragraph", blockKey: "stable-key", id: "linked-block", content: [{ text: "Preserve this Block" }] },
      { type: "image", blockKey: "image-key", id: "linked-image", src: "/diagram.png", alt: "Diagram" },
      { type: "table", blockKey: "table-key", id: "linked-table", rows: [[{ header: true, content: [{ text: "Owner" }] }]] },
    ] } }));
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><NoteEditor noteId="note" fetcher={fetcher} token="member-token" /></QueryClientProvider>);
  expect(await screen.findByRole("heading", { name: "Release plan" })).toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Note content" })).toHaveTextContent("Preserve this Block"));
  expect(screen.getByRole("toolbar", { name: "Text formatting" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Insert link" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Insert callout" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Insert Workspace Attachment" })).toBeEnabled();
  expect(document.querySelector("[data-block-id='linked-image']")).toHaveAttribute("data-block-key", "image-key");
  expect(document.querySelector("table[data-block-id='linked-table']")).toHaveAttribute("data-block-key", "table-key");
  fireEvent.click(screen.getByRole("button", { name: "Bold" }));
  expect(fetcher).toHaveBeenCalledWith("/api/notes/note", expect.objectContaining({ headers: { authorization: "Bearer member-token" } }));
});

it("loads the authoritative collaboration snapshot when navigating directly between Notes", async () => {
  const updates = {
    first: collaborativeUpdate("Authoritative first", "11111111-1111-4111-8111-111111111111"),
    second: collaborativeUpdate("Authoritative second", "22222222-2222-4222-8222-222222222222"),
  };
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = String(input); const noteId = url.includes("/second") ? "second" : "first";
    if (url.endsWith("/collaboration")) return new Response(JSON.stringify({ sequence: 1, update: updates[noteId],
      updatedAt: new Date(0).toISOString(), updatedByMemberId: "ada" }));
    return new Response(JSON.stringify({ id: noteId, revision: 1, content: `Canonical ${noteId}`, document: { type: "doc", blocks: [
      { type: "paragraph", blockKey: noteId === "first" ? "11111111-1111-4111-8111-111111111111" : "22222222-2222-4222-8222-222222222222",
        content: [{ text: `Canonical ${noteId}` }] },
    ] } }));
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(<QueryClientProvider client={client}><NoteEditor noteId="first" fetcher={fetcher} token="token" /></QueryClientProvider>);
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Note content" })).toHaveTextContent("Authoritative first"));
  view.rerender(<QueryClientProvider client={client}><NoteEditor noteId="second" fetcher={fetcher} token="token" /></QueryClientProvider>);
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Note content" })).toHaveTextContent("Authoritative second"));
  expect(screen.getByRole("textbox", { name: "Note content" })).not.toHaveTextContent("Canonical second");
});

it("replays a restored offline update as soon as collaboration reconnects", async () => {
  const pendingDocument = new Y.Doc(); pendingDocument.getText("offline").insert(0, "Kept contribution");
  localStorage.setItem("stash.pending-note-update:note", btoa(String.fromCharCode(...Y.encodeStateAsUpdate(pendingDocument))));
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { update: string };
      return new Response(JSON.stringify({ sequence: 1, update: body.update, updatedAt: new Date(0).toISOString(), updatedByMemberId: "ada" }));
    }
    if (url.endsWith("/collaboration")) return new Response(JSON.stringify({ sequence: 0, update: emptyUpdate(), updatedAt: new Date(0).toISOString(), updatedByMemberId: "ada" }));
    return new Response(JSON.stringify({ id: "note", revision: 1, content: "Offline plan", document: { type: "doc", blocks: [{ type: "paragraph", blockKey: "key", content: [{ text: "Draft" }] }] } }));
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><NoteEditor noteId="note" fetcher={fetcher} token="token" /></QueryClientProvider>);
  await waitFor(() => expect(fetcher.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true));
  await waitFor(() => expect(localStorage.getItem("stash.pending-note-update:note")).toBeNull());
});

it("keeps unsaved Yjs updates locally and offers recovery when the Instance is offline", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (init?.method === "POST") throw new TypeError("offline");
    if (url.endsWith("/collaboration")) return new Response(JSON.stringify({ sequence: 0, update: emptyUpdate(), updatedAt: new Date(0).toISOString(), updatedByMemberId: "ada" }));
    return new Response(JSON.stringify({ id: "note", revision: 1, content: "Offline plan", document: { type: "doc", blocks: [{ type: "paragraph", blockKey: "key", content: [{ text: "Draft" }] }] } }));
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><NoteEditor noteId="note" fetcher={fetcher} token="token" /></QueryClientProvider>);
  await vi.waitFor(() => expect(screen.getByRole("textbox", { name: "Note content" })).toHaveTextContent("Draft"));
  await vi.advanceTimersByTimeAsync(400);
  await vi.waitFor(() => expect(screen.getByRole("button", { name: "Retry saving" })).toBeInTheDocument());
  expect(localStorage.getItem("stash.pending-note-update:note")).toBeTruthy();
  vi.useRealTimers();
});

it("serializes autosaves even when an older acknowledgement and newer failure resolve out of order", async () => {
  let releaseFirst!: () => void; let calls = 0; let pending = "newer update";
  const firstResponse = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const synchronize = createSerializedSynchronization(async () => {
    calls += 1;
    if (calls === 1) { await firstResponse; pending = ""; return; }
    pending = "newer update"; throw new TypeError("offline");
  });
  const first = synchronize(); const second = synchronize();
  await Promise.resolve(); expect(calls).toBe(1);
  releaseFirst(); await first; await expect(second).rejects.toThrow("offline");
  expect(calls).toBe(2); expect(pending).toBe("newer update");
});

it("reports tab-only recovery and still sends changes when browser storage is unavailable", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("localStorage", { getItem: () => { throw new DOMException("disabled", "SecurityError"); },
    setItem: () => { throw new DOMException("quota", "QuotaExceededError"); }, removeItem: () => { throw new DOMException("disabled", "SecurityError"); } });
  let online = false;
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (init?.method === "POST") {
      if (!online) throw new TypeError("offline");
      const body = JSON.parse(String(init.body)) as { update: string };
      return new Response(JSON.stringify({ sequence: 1, update: body.update, updatedAt: new Date(0).toISOString(), updatedByMemberId: "ada" }));
    }
    if (url.endsWith("/collaboration")) return new Response(JSON.stringify({ sequence: 0, update: emptyUpdate(), updatedAt: new Date(0).toISOString(), updatedByMemberId: "ada" }));
    return new Response(JSON.stringify({ id: "note", revision: 1, content: "Online plan", document: { type: "doc", blocks: [{ type: "paragraph", blockKey: "key", content: [{ text: "Draft" }] }] } }));
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><NoteEditor noteId="note" fetcher={fetcher} token="token" /></QueryClientProvider>);
  await vi.waitFor(() => expect(screen.getByRole("textbox", { name: "Note content" })).toHaveTextContent("Draft"));
  await vi.advanceTimersByTimeAsync(400);
  await vi.waitFor(() => expect(fetcher.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true));
  await vi.waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Changes remain only in this open tab"));
  online = true;
  fireEvent.click(screen.getByRole("button", { name: "Retry saving" }));
  await vi.waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("All changes saved"));
  vi.useRealTimers();
});

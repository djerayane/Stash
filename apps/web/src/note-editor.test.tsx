import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { applyAcknowledgedUpdate, NoteEditor } from "./note-editor";

const emptyUpdate = () => btoa(String.fromCharCode(...Y.encodeStateAsUpdate(new Y.Doc())));
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

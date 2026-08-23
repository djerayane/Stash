import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { NoteEditor } from "./note-editor";

const emptyUpdate = () => btoa(String.fromCharCode(...Y.encodeStateAsUpdate(new Y.Doc())));
const storage = new Map<string, string>();
beforeEach(() => {
  storage.clear();
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
});

it("loads an authorized collaborative Note and exposes keyboard-operable rich-text controls", async () => {
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/collaboration")) return new Response(JSON.stringify({ sequence: 0, update: emptyUpdate(), updatedAt: new Date(0).toISOString(), updatedByMemberId: "ada" }));
    return new Response(JSON.stringify({ id: "note", revision: 1, content: "Release plan", document: { type: "doc", blocks: [
      { type: "paragraph", blockKey: "stable-key", id: "linked-block", content: [{ text: "Preserve this Block" }] },
    ] } }));
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><NoteEditor noteId="note" fetcher={fetcher} token="member-token" /></QueryClientProvider>);
  expect(await screen.findByRole("heading", { name: "Release plan" })).toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Note content" })).toHaveTextContent("Preserve this Block"));
  expect(screen.getByRole("toolbar", { name: "Text formatting" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Bold" }));
  expect(fetcher).toHaveBeenCalledWith("/api/notes/note", expect.objectContaining({ headers: { authorization: "Bearer member-token" } }));
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

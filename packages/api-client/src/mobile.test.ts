import { describe, expect, it, vi } from "vitest";
import { createMobileProtocolClient, createStashApiClient } from "./index.js";

describe("mobile protocol client", () => {
  it("uses the versioned capture-options endpoint and bearer authority", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ memberId: "member", projects: [], tags: [], reminders: [] })));
    const client = createMobileProtocolClient({ instanceUrl: "https://stash.example", memberToken: "secret", fetch: request });
    await client.captureOptions("workspace", new AbortController().signal);
    expect(request).toHaveBeenCalledWith("https://stash.example/api/mobile/v1/workspaces/workspace/capture-options",
      expect.objectContaining({ headers: { authorization: "Bearer secret" } }));
  });

  it("keeps transport errors observable to synchronization policy", async () => {
    const client = createMobileProtocolClient({ instanceUrl: "https://stash.example", memberToken: "secret",
      fetch: async () => new Response(JSON.stringify({ error: "rejected" }), { status: 409 }) });
    const response = await client.applyNoteEdit("note", { baseRevision: 1, operations: [] }, new AbortController().signal);
    expect(response.status).toBe(409);
  });
});

describe("Member API client", () => {
  it("uses bearer authority for reads and bodyless confirmation while preserving visible API messages", async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ signals: [] }))
      .mockResolvedValueOnce(Response.json({ suggestion: { status: "confirmed" } }))
      .mockResolvedValueOnce(Response.json({ message: "Signals are temporarily unavailable." }, { status: 503 }));
    const client = createStashApiClient({ baseUrl: "https://stash.example", memberToken: "secret", fetch: request });
    await client.get("/api/signals"); await client.post("/api/signals/confirm");
    await expect(client.get("/api/signals")).rejects.toMatchObject({ status: 503, message: "Signals are temporarily unavailable." });
    expect(request).toHaveBeenNthCalledWith(2, "https://stash.example/api/signals/confirm", expect.objectContaining({ method: "POST", headers: { authorization: "Bearer secret" } }));
  });
});

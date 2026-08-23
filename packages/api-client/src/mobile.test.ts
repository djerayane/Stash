import { describe, expect, it, vi } from "vitest";
import { createMobileProtocolClient } from "./index.js";

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

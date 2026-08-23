import { describe, expect, it } from "vitest";
import { createAgentGrantsApi } from "./index";

describe("Agent Grants API client", () => {
  it("uses the focused Member endpoints and bearer boundary", async () => { const calls: Array<{ url: string; init?: RequestInit }> = [];
    const api = createAgentGrantsApi({ baseUrl: "https://stash.test/", memberToken: "member", fetch: async (input, init) => { calls.push({ url: String(input), init }); return new Response(JSON.stringify(init?.method === "DELETE" ? { grantId: "grant/id", revoked: true } : input.toString().endsWith("proposals") ? { proposals: [] } : { grants: [] }), { status: 200 }); } });
    await api.list("org/id"); await api.proposals("org/id"); await api.revoke("org/id", "grant/id");
    expect(calls.map(({ url }) => url)).toEqual(["https://stash.test/api/organizations/org%2Fid/agent-grants", "https://stash.test/api/organizations/org%2Fid/agent-grants/proposals", "https://stash.test/api/organizations/org%2Fid/agent-grants/grant%2Fid"]);
    expect(calls[2]?.init?.method).toBe("DELETE"); expect((calls[0]?.init?.headers as Record<string, string>).authorization).toBe("Bearer member");
  });
});

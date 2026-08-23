import { describe, expect, it, vi } from "vitest";
import { createStashApiClient } from "./index";

describe("Stash API client writes", () => {
  it("puts validated client state with the Member credential", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ followed: true }), { status: 200 }));
    const client = createStashApiClient({ baseUrl: "https://stash.test", memberToken: "member", fetch: request });
    await expect(client.put("/api/projects/project/follow", { followed: true })).resolves.toEqual({ followed: true });
    expect(request).toHaveBeenCalledWith("https://stash.test/api/projects/project/follow", expect.objectContaining({ method: "PUT",
      headers: { authorization: "Bearer member", "content-type": "application/json" }, body: JSON.stringify({ followed: true }) }));
  });
});

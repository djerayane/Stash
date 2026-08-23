import { describe, expect, it, vi } from "vitest";
import { createProductSettingsApi, StashApiError } from "./index";

describe("Product settings API", () => {
  it("authenticates and validates settings responses at the shared client boundary", async () => {
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => Response.json({ locale: "en", timeZone: "UTC", dateFormat: "medium", weekStartsOn: "monday" }, { headers: init?.headers }));
    const api = createProductSettingsApi({ baseUrl: "https://stash.test", memberToken: "member-token", fetch: fetcher });
    await expect(api.localization()).resolves.toMatchObject({ locale: "en", timeZone: "UTC" });
    expect(fetcher).toHaveBeenCalledWith("https://stash.test/api/member/localization", expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer member-token" }) }));
  });

  it("rejects malformed domain responses instead of leaking them into React", async () => {
    const api = createProductSettingsApi({ baseUrl: "", memberToken: "member", fetch: vi.fn(async () => Response.json({ repositoryConnections: [{ id: "unsafe" }] })) });
    await expect(api.connections("organization")).rejects.toBeInstanceOf(StashApiError);
  });
});

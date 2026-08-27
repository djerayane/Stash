import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { identityAccessCapability } from "../../src/identity-access/index.js";

describe("Identity Access invitation composition", () => {
  it("publishes invitation and guest Project routes only when the service is composed", () => {
    const memberAccess = { authenticateBearer: async () => undefined };
    const basic = identityAccessCapability({ passwordAuth: memberAccess as never });
    const complete = identityAccessCapability({ passwordAuth: memberAccess as never, memberAccess, invitations: {} as never });
    const matches = (capability: ReturnType<typeof identityAccessCapability>, method: string, pathname: string) => capability.routes()
      .some((route) => route.matches(new Request(`http://stash.invalid${pathname}`, { method }) as never, new URL(`http://stash.invalid${pathname}`)));
    assert.equal(matches(basic, "POST", "/api/organizations/org/invitations"), false);
    assert.equal(matches(complete, "POST", "/api/organizations/org/invitations"), true);
    assert.equal(matches(complete, "POST", "/api/invitations/accept"), true);
    assert.equal(matches(complete, "GET", "/api/projects/project"), true);
    assert.ok(complete.owns?.includes("invitations"));
  });
});

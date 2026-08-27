import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCapabilityRegistry, memberAccessFromCapabilities, publicRoutesFromCapabilities, routesFromCapabilities } from "../../src/capability-registry.js";
import type { HttpRoute } from "../../src/http-routing.js";

function route(label: string): HttpRoute & { label: string } {
  return { label, matches: (_request, url) => url.pathname === `/${label}`, handle: () => true };
}
describe("Instance capability composition contract", () => {
  it("composes operational and public routes in module order and selects the sole Member access provider", () => {
    const memberAccess = { authenticateBearer: async () => ({ accountId: "member", sessionId: "session" }) };
    const identity = route("identity"); const tasks = route("tasks"); const publicTasks = route("public-tasks");
    const registry = createCapabilityRegistry([
      { name: "identity-access", memberAccess, routes: () => [identity] },
      { name: "work-planning", routes: () => [tasks], publicRoutes: () => [publicTasks] },
    ]);
    assert.deepEqual(routesFromCapabilities(registry), [identity, tasks]);
    assert.deepEqual(publicRoutesFromCapabilities(registry), [publicTasks]);
    assert.equal(memberAccessFromCapabilities(registry), memberAccess);
    assert.equal(routesFromCapabilities(registry)[1]!.matches(new Request("http://stash.invalid/tasks") as never, new URL("http://stash.invalid/tasks")), true);
  });
  it("rejects ambiguous Member access composition", () => {
    const provider = { authenticateBearer: async () => undefined };
    const registry = createCapabilityRegistry([
      { name: "identity-access", memberAccess: provider, routes: () => [] },
      { name: "other-identity", memberAccess: provider, routes: () => [] },
    ]);
    assert.throws(() => memberAccessFromCapabilities(registry), /Multiple capabilities provide Member access/);
  });
});

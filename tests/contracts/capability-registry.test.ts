import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  createCapabilityRegistry,
  routesFromCapabilities,
  type CapabilityModule,
} from "../../src/capability-registry.js";
import { json, type HttpRoute } from "../../src/http-routing.js";
import { startInstance } from "../../src/instance.js";

function route(label: string): HttpRoute & { readonly label: string } {
  return {
    label,
    matches: () => false,
    handle: () => false,
  };
}

function capability(name: string, routes: readonly HttpRoute[]): CapabilityModule {
  return { name, routes: () => routes };
}

describe("capability registry", () => {
  test("registers the five server capabilities and flattens their routes in declared order", () => {
    const identity = route("identity");
    const noteRead = route("note-read");
    const noteWrite = route("note-write");
    const task = route("task");
    const development = route("development");
    const operations = route("operations");

    const registry = createCapabilityRegistry([
      capability("identity-access", [identity]),
      capability("knowledge-authoring", [noteRead, noteWrite]),
      capability("work-planning", [task]),
      capability("development-integration", [development]),
      capability("instance-operations", [operations]),
    ]);

    assert.deepEqual(registry.modules.map(({ name }) => name), [
      "identity-access",
      "knowledge-authoring",
      "work-planning",
      "development-integration",
      "instance-operations",
    ]);
    assert.deepEqual(
      routesFromCapabilities(registry).map((registered) => (registered as HttpRoute & { label: string }).label),
      ["identity", "note-read", "note-write", "task", "development", "operations"],
    );
  });

  test("rejects duplicate capability names explicitly", () => {
    assert.throws(
      () => createCapabilityRegistry([
        capability("knowledge-authoring", []),
        capability("knowledge-authoring", []),
      ]),
      /Duplicate capability module name: knowledge-authoring/,
    );
  });

  test("the running Instance dispatches production behavior contributed only through the registry", async () => {
    const registry = createCapabilityRegistry([
      capability("identity-access", [{
        matches: (request, url) => request.method === "GET" && url.pathname === "/api/capability-contract",
        handle: (_request, response) => {
          json(response, 200, { capability: "identity-access" });
          return true;
        },
      }]),
    ]);
    const instance = await startInstance({
      database: { verifyConnection: async () => undefined, close: async () => undefined },
      host: "127.0.0.1",
      port: 0,
      instanceAdminToken: "capability-contract-admin",
      capabilities: registry,
    });

    try {
      const response = await fetch(`${instance.url}/api/capability-contract`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { capability: "identity-access" });
    } finally {
      await instance.close();
    }
  });
});

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  createCapabilityRegistry,
  publicRoutesFromCapabilities,
  routesFromCapabilities,
  type CapabilityModule,
} from "../../src/capability-registry.js";
import { developmentIntegrationCapability } from "../../src/development-integration/index.js";
import { createDiagnostics } from "../../src/diagnostics.js";
import type { HttpRoute } from "../../src/http-routing.js";
import { identityAccessCapability } from "../../src/identity-access/index.js";
import { startInstance } from "../../src/instance.js";
import { instanceOperationsCapability } from "../../src/instance-operations/index.js";
import { knowledgeAuthoringCapability } from "../../src/knowledge-authoring/index.js";
import { workPlanningCapability } from "../../src/work-planning/index.js";

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
    assert.deepEqual(publicRoutesFromCapabilities(registry), []);
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

  test("the running Instance dispatches representative production behavior from all five capabilities", async () => {
    const memberAccess = { authenticateBearer: async () => undefined };
    const diagnostics = createDiagnostics({
      instanceVersion: "capability-contract",
      transport: { async submit() {} },
    });
    diagnostics.recordCrashReport({
      id: "capability-contract-crash",
      occurredAt: "2026-08-26T12:00:00.000Z",
      component: "capability-registry",
      errorCode: "contract_probe",
    });
    const registry = createCapabilityRegistry([
      identityAccessCapability({
        passwordAuth: memberAccess as never,
        instanceAdminToken: "capability-contract-admin",
      }),
      knowledgeAuthoringCapability({ notes: {} as never, starterTutorials: {} as never, memberAccess }),
      workPlanningCapability({ tasks: {} as never, memberAccess }),
      developmentIntegrationCapability({
        memberAccess,
        repositoryConnections: {} as never,
      }),
      instanceOperationsCapability({
        instanceAdminToken: "capability-contract-admin",
        diagnostics,
      }),
    ]);

    const request = (method: string, pathname: string) => new Request(`http://stash.invalid${pathname}`, { method });
    const owns = (moduleName: string, method: string, pathname: string) => registry.modules
      .find(({ name }) => name === moduleName)!.routes()
      .some((registered) => registered.matches(request(method, pathname) as never, new URL(`http://stash.invalid${pathname}`)));
    assert.equal(owns("identity-access", "POST", "/api/instance/organizations/bootstrap"), true);
    assert.equal(owns("instance-operations", "POST", "/api/instance/organizations/bootstrap"), false);
    assert.equal(owns("instance-operations", "GET", "/api/diagnostics/schema"), true);
    assert.equal(owns("knowledge-authoring", "GET", "/api/notes/capability-contract-note/starter-tutorial"), true);
    assert.equal(owns("identity-access", "GET", "/api/notes/capability-contract-note/starter-tutorial"), false);

    const instance = await startInstance({
      database: { verifyConnection: async () => undefined, close: async () => undefined },
      host: "127.0.0.1",
      port: 0,
      instanceAdminToken: "capability-contract-admin",
      capabilities: registry,
    });

    try {
      const auth = await fetch(`${instance.url}/api/auth/registration`);
      assert.equal(auth.status, 200);
      assert.deepEqual(await auth.json(), { enabled: false });

      for (const pathname of [
        "/api/notes/capability-contract-note",
        "/api/notes/capability-contract-note/starter-tutorial",
        "/api/projects/capability-contract-project/tasks/STASH-167",
        "/api/organizations/capability-contract-organization/repository-connections",
      ]) {
        const response = await fetch(`${instance.url}${pathname}`);
        assert.equal(response.status, 401, pathname);
      }

      const schema = await fetch(`${instance.url}/api/diagnostics/schema`);
      assert.equal(schema.status, 200);
      assert.equal((await schema.json() as { id: string }).id, "stash.instance-diagnostics.v1");
      const crash = await fetch(`${instance.url}/api/diagnostics/crash-reports/capability-contract-crash`, {
        headers: { authorization: "Bearer capability-contract-admin" },
      });
      assert.equal(crash.status, 200);
      assert.equal((await crash.json() as { instanceVersion: string }).instanceVersion, "capability-contract");
    } finally {
      await instance.close();
    }
  });
});

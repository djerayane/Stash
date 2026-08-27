import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import { Pool } from "pg";
import { createAuthenticationSecretCodec } from "../../src/authentication-secrets.js";
import { PostgresDatabase } from "../../src/postgres-database.js";
import { workPlanningCapability } from "../../src/work-planning/index.js";

describe("PostgreSQL Work Planning composition", () => {
  it("exposes one stable repository satisfying every planning service seam", async () => {
    const database = new PostgresDatabase("postgresql://unused", createAuthenticationSecretCodec(randomBytes(32).toString("base64")), { pool: new Pool() });
    try {
      const planning = database.workPlanningRepositories();
      assert.equal(database.workPlanningRepositories(), planning);
      assert.notEqual(planning, database.identityAccessRepositories());
      for (const operation of ["createTaskFromBlock", "applyStructuredTaskEdit", "moveTask", "findWorkflow", "createBoard", "saveNotification", "enableAutomation"] as const)
        assert.equal(typeof planning[operation], "function", operation);
    } finally { await database.close(); }
  });

  it("publishes optional planning routes only for composed services", () => {
    const memberAccess = { authenticateBearer: async () => undefined };
    const basic = workPlanningCapability({ tasks: {} as never, memberAccess });
    const complete = workPlanningCapability({ tasks: {} as never, memberAccess, projectWorkflows: {} as never,
      boards: {} as never, notifications: {} as never, automations: {} as never });
    const matches = (capability: ReturnType<typeof workPlanningCapability>, method: string, pathname: string) => capability.routes()
      .some((route) => route.matches(new Request(`http://stash.invalid${pathname}`, { method }) as never, new URL(`http://stash.invalid${pathname}`)));
    assert.equal(matches(basic, "GET", "/api/projects/project/boards"), false);
    assert.equal(matches(complete, "GET", "/api/projects/project/boards"), true);
    assert.equal(matches(complete, "GET", "/api/projects/project/tasks/STASH-1/automations"), true);
    assert.ok(complete.owns?.includes("boards")); assert.ok(complete.owns?.includes("automations"));
  });
});

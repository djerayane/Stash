import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { planLegacyTaskDependencyMigration } from "../src/postgres-database.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const a = "22222222-2222-4222-8222-222222222222";
const b = "33333333-3333-4333-8333-333333333333";

function migrate(source: Array<{ id: string; workspaceId: string; dependencies: unknown }>) {
  let legacy: typeof source | undefined = structuredClone(source);
  let edges: ReturnType<typeof planLegacyTaskDependencyMigration> = [];
  try { edges = planLegacyTaskDependencyMigration(legacy); legacy = undefined; }
  catch (error) { return { error, legacy, edges }; }
  return { legacy, edges };
}

describe("legacy Task Dependency migration", () => {
  it("normalizes inverse duplicates before removing the legacy source", () => {
    const result = migrate([
      { id: a, workspaceId, dependencies: [{ taskId: b, type: "depends_on" }] },
      { id: b, workspaceId, dependencies: [{ taskId: a, type: "required_by" }] },
    ]);
    assert.equal(result.legacy, undefined);
    assert.deepEqual(result.edges, [{ dependent_task_id: a, prerequisite_task_id: b }]);
  });

  it("preserves every source value and writes no edge when a legacy entry is malformed", () => {
    const source = [{ id: a, workspaceId, dependencies: [{ taskId: "not-a-uuid", type: "depends_on" }] },
      { id: b, workspaceId, dependencies: [] }];
    const result = migrate(source);
    assert.match(String(result.error), /malformed relationship/);
    assert.deepEqual(result.legacy, source);
    assert.deepEqual(result.edges, []);
  });

  it("preserves every source value and writes no edge when normalization reveals a cycle", () => {
    const source = [
      { id: a, workspaceId, dependencies: [{ taskId: b, type: "depends_on" }] },
      { id: b, workspaceId, dependencies: [{ taskId: a, type: "depends_on" }] },
    ];
    const result = migrate(source);
    assert.match(String(result.error), /contains a cycle/);
    assert.deepEqual(result.legacy, source);
    assert.deepEqual(result.edges, []);
  });
});

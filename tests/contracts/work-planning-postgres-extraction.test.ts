import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

describe("PostgreSQL work-planning persistence ownership", () => {
  it("owns Workflow and Board persistence in the work-planning adapter", async () => {
    const adapter = await readFile(new URL("../../src/work-planning/postgres-work-planning-repositories.ts", import.meta.url), "utf8");
    const database = await readFile(new URL("../../src/postgres-database.ts", import.meta.url), "utf8");

    for (const method of ["findWorkflow", "replaceWorkflow", "listBoards", "createBoard", "readBoard", "moveTaskOnBoard"])
      assert.match(adapter, new RegExp(`async ${method}\\(`));
    assert.match(adapter, /CREATE TABLE IF NOT EXISTS stash_boards/);
    assert.match(database, /workPlanningRepositories\(\): WorkPlanningPostgresRepositories \{\s+return this\.#workPlanningAdapter;/);
    assert.doesNotMatch(database, /async #ensureBoardSchema\(/);
  });

  it("owns Task source reads and Automations outside the universal database", async () => {
    const adapter = await readFile(new URL("../../src/work-planning/postgres-work-planning-repositories.ts", import.meta.url), "utf8");
    const database = await readFile(new URL("../../src/postgres-database.ts", import.meta.url), "utf8");
    const methods = ["createTaskFromBlock", "createWorkspaceTaskFromBlock", "linkTaskToBlock", "listLinkedTasks", "listTaskSourceBlocks",
      "listAutomationState", "enableAutomation", "reverseAutomation", "applySignalAutomations"];
    for (const method of methods) assert.match(adapter, new RegExp(`(?:async )?${method}\\(`));
    assert.doesNotMatch(database, new RegExp(`(?:async )?(?:${methods.join("|")})\\(`));
  });

  it("owns structured Task edits and moves in the work-planning adapter", async () => {
    const adapter = await readFile(new URL("../../src/work-planning/postgres-work-planning-repositories.ts", import.meta.url), "utf8");
    const database = await readFile(new URL("../../src/postgres-database.ts", import.meta.url), "utf8");
    for (const method of ["applyStructuredTaskEdit", "listStructuredTaskConflicts", "resolveStructuredTaskConflict", "moveTask"])
      assert.match(adapter, new RegExp(`async ${method}\\(`));
    assert.match(adapter, /private async applyStructuredTaskChanges\(/);
    assert.match(adapter, /CREATE TABLE IF NOT EXISTS stash_task_edit_operations/);
    assert.match(database, /workPlanningRepositories\(\): WorkPlanningPostgresRepositories \{\s+return this\.#workPlanningAdapter;/);
    assert.doesNotMatch(database, /async (?:applyStructuredTaskEdit|listStructuredTaskConflicts|resolveStructuredTaskConflict|moveTask)\(/);
    assert.doesNotMatch(database, /async #(?:applyStructuredTaskChanges|createTask|ensureDefaultWorkflow)\(/);
  });
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

describe("Instance capability composition contract", () => {
  it("keeps production Instance composition capability-only", async () => {
    const source = await readFile(new URL("../../src/instance.ts", import.meta.url), "utf8");

    assert.doesNotMatch(source, /legacyPublicDomainRoutes/);
    for (const legacyOption of ["notes", "tasks", "boards", "memberAccess", "passwordAuth", "githubSignals"]) {
      assert.doesNotMatch(source, new RegExp(`\\n\\s+${legacyOption}\\?:`), legacyOption);
    }
    assert.match(source, /routesFromCapabilities\(options\.capabilities\)/);
    assert.match(source, /publicRoutesFromCapabilities\(options\.capabilities\)/);
  });
});

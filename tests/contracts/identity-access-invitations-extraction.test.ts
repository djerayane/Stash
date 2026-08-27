import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

describe("Invitation PostgreSQL ownership", () => {
  it("lives in the kernel-backed Identity Access adapter without universal-store bindings", async () => {
    const adapter = await readFile(
      new URL("../../src/identity-access/postgres-identity-access-repositories.ts", import.meta.url),
      "utf8",
    );
    const database = await readFile(new URL("../../src/postgres-database.ts", import.meta.url), "utf8");

    for (const method of ["createInvitation", "acceptInvitation", "prepareInvitations"]) {
      assert.match(adapter, new RegExp(`(?:async )?${method}\\(`), method);
      assert.doesNotMatch(database, new RegExp(`\\n\\s+(?:async )?${method}\\(`), method);
    }
    assert.doesNotMatch(database, /(?:createInvitation|acceptInvitation): this\./);
    for (const table of ["stash_invitations", "stash_invitation_projects", "stash_project_guests"]) {
      assert.match(adapter, new RegExp(table), table);
    }
    assert.doesNotMatch(database, /async #ensureInvitationSchema\(/);
  });
});

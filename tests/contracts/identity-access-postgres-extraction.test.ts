import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import { Pool } from "pg";
import { createAuthenticationSecretCodec } from "../../src/authentication-secrets.js";
import { PostgresDatabase } from "../../src/postgres-database.js";

describe("PostgreSQL capability repository composition", () => {
  it("exposes one stable Identity Access repository independently of other capabilities", async () => {
    const database = new PostgresDatabase("postgresql://unused", createAuthenticationSecretCodec(randomBytes(32).toString("base64")), { pool: new Pool() });
    try {
      const identity = database.identityAccessRepositories();
      assert.equal(database.identityAccessRepositories(), identity);
      assert.notEqual(identity, database.knowledgeAuthoringRepositories());
      assert.notEqual(identity, database.workPlanningRepositories());
      for (const operation of ["createInvitation", "findPortableMemberIdentity", "resolveClientSessionPrincipal"] as const)
        assert.equal(typeof identity[operation], "function", operation);
    } finally { await database.close(); }
  });
});

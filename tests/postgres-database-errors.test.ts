import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";

import { createAuthenticationSecretCodec } from "../src/authentication-secrets.js";
import { PostgresDatabase } from "../src/postgres-database.js";

test("reports an idle PostgreSQL client failure without forwarding protocol or credential data", async () => {
  const pool = new Pool();
  const diagnostics: unknown[] = [];
  const database = new PostgresDatabase("postgresql://unused", createAuthenticationSecretCodec(randomBytes(32).toString("base64")), {
    pool,
    reportIdleClientFailure: (diagnostic) => diagnostics.push(diagnostic),
  });
  const failure = Object.assign(new Error("postgresql://user:password@database/stash"), {
    code: "ECONNRESET",
    secretKey: 123456,
  });

  pool.emit("error", failure);

  assert.deepEqual(diagnostics, [{ operation: "idle_client", cause: "Error", code: "ECONNRESET" }]);
  assert.doesNotMatch(JSON.stringify(diagnostics), /password|secretKey|123456/);
  await database.close();
});

test("emits a fixed-shape safe idle-client diagnostic by default", async () => {
  const pool = new Pool();
  const messages: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message?: unknown) => messages.push(String(message));
  const database = new PostgresDatabase("postgresql://unused", createAuthenticationSecretCodec(randomBytes(32).toString("base64")), { pool });
  try {
    pool.emit("error", Object.assign(new Error("password=do-not-log"), { code: "57P01", secretKey: 987654 }));
    assert.deepEqual(messages, ["PostgreSQL idle client unavailable (operation=idle_client, cause=Error, code=57P01)."]);
    assert.doesNotMatch(messages.join("\n"), /password|secretKey|987654/);
  } finally {
    console.warn = originalWarn;
    await database.close();
  }
});

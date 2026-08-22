import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { Pool } from "pg";

import { workflowTemporaryRenameSql } from "../src/postgres-database.js";

const databaseUrl = process.env.STASH_TEST_DATABASE_URL;

describe("PostgreSQL Workflow replacement", { skip: databaseUrl ? false : "STASH_TEST_DATABASE_URL is not configured" }, () => {
  it("uses a temporary name outside the valid input namespace during UUID-like renames", async () => {
    const pool = new Pool({ connectionString: databaseUrl });
    const client = await pool.connect();
    const schema = `workflow_${randomUUID().replaceAll("-", "")}`;
    const projectId = "11111111-1111-4111-8111-111111111111";
    const firstId = "22222222-2222-4222-8222-222222222222";
    const secondId = "33333333-3333-4333-8333-333333333333";
    const newId = "44444444-4444-4444-8444-444444444444";
    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET search_path TO ${schema}`);
      await client.query(`CREATE TABLE stash_workflow_statuses (
        id UUID PRIMARY KEY, project_id UUID NOT NULL, name TEXT NOT NULL,
        category TEXT NOT NULL, position INTEGER NOT NULL, archived BOOLEAN NOT NULL DEFAULT FALSE,
        UNIQUE (project_id, name), UNIQUE (project_id, position)
      )`);
      await client.query(`INSERT INTO stash_workflow_statuses (id, project_id, name, category, position) VALUES
        ($1::uuid,$3::uuid,$2::text,'unstarted',0), ($2::uuid,$3::uuid,'Ready','unstarted',1)`, [firstId, secondId, projectId]);

      await client.query("BEGIN");
      await client.query(workflowTemporaryRenameSql, [projectId]);
      for (const status of [
        { id: firstId, name: "Ideas", category: "unstarted", position: 0 },
        { id: secondId, name: firstId, category: "started", position: 1 },
        { id: newId, name: "55555555-5555-4555-8555-555555555555", category: "completed", position: 2 },
      ]) await client.query(`INSERT INTO stash_workflow_statuses (id, project_id, name, category, position, archived)
        VALUES ($1,$2,$3,$4,$5,FALSE) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name,
          category = EXCLUDED.category, position = EXCLUDED.position, archived = EXCLUDED.archived`,
      [status.id, projectId, status.name, status.category, status.position]);
      await client.query("COMMIT");

      const saved = await client.query<{ id: string; name: string }>(
        "SELECT id, name FROM stash_workflow_statuses ORDER BY position");
      assert.deepEqual(saved.rows, [
        { id: firstId, name: "Ideas" },
        { id: secondId, name: firstId },
        { id: newId, name: "55555555-5555-4555-8555-555555555555" },
      ]);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
      client.release();
      await pool.end();
    }
  });
});

import { Pool } from "pg";
import type { InstanceUpgradeTarget, UpgradeCheck } from "./instance-upgrade.js";

export class PostgresInstanceUpgradeTarget implements InstanceUpgradeTarget {
  readonly #pool: Pool;
  constructor(connectionString: string, private readonly restore: (backupPath: string) => Promise<void>) { this.#pool = new Pool({ connectionString, connectionTimeoutMillis: 2_000, max: 1 }); }
  async inspect(): Promise<{ currentVersion: string; checks: UpgradeCheck[] }> {
    try {
      const server = await this.#pool.query<{ server_version_num: string }>("SHOW server_version_num");
      const version = Number(server.rows[0]?.server_version_num ?? 0);
      const stored = await this.#pool.query<{ version: string }>("SELECT version FROM stash_instance_format WHERE singleton = TRUE").catch((error: unknown) => {
        if ((error as { code?: string }).code === "42P01") return { rows: [] }; throw error;
      });
      return { currentVersion: stored.rows[0]?.version ?? "0.1.0", checks: [
        { id: "database", status: version >= 150_000 ? "pass" : "fail", message: version >= 150_000 ? "PostgreSQL 15 or newer is reachable." : "PostgreSQL 15 or newer is required." },
      ] };
    } catch { return { currentVersion: "unknown", checks: [{ id: "database", status: "fail", message: "PostgreSQL upgrade inspection failed." }] }; }
  }
  async apply(fromVersion: string, targetVersion: string): Promise<void> {
    const client = await this.#pool.connect();
    try { await client.query("BEGIN"); await client.query("SELECT pg_advisory_xact_lock($1)", [1914047861]);
      await client.query("CREATE TABLE IF NOT EXISTS stash_instance_format (singleton BOOLEAN PRIMARY KEY CHECK (singleton), version TEXT NOT NULL)");
      const stored = await client.query<{ version: string }>("SELECT version FROM stash_instance_format WHERE singleton = TRUE FOR UPDATE");
      const actual = stored.rows[0]?.version ?? "0.1.0"; if (actual !== fromVersion) throw new Error(`Instance format changed during preflight: ${actual}`);
      // A release adds its ordered, transactional migration immediately before advancing this marker.
      await client.query("INSERT INTO stash_instance_format (singleton, version) VALUES (TRUE, $1) ON CONFLICT (singleton) DO UPDATE SET version = EXCLUDED.version", [targetVersion]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
  }
  async rollback(backupPath: string): Promise<void> { await this.restore(backupPath); }
}

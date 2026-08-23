import { Pool, type PoolClient, type QueryResult } from "pg";
import type { InstanceUpgradeTarget, UpgradeCheck } from "./instance-upgrade.js";

export const legacyUnversionedFormat = "0.0.0";
interface MigrationConnection { query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<QueryResult<T>> }
interface UpgradeDatabase extends MigrationConnection { connect(): Promise<PoolClient>; end(): Promise<void> }
interface PostgresMigration { from: string; to: string; apply(connection: MigrationConnection): Promise<void> }

export const postgresInstanceMigrations: readonly PostgresMigration[] = [{
  from: legacyUnversionedFormat, to: "0.1.0",
  async apply(connection) {
    await connection.query("CREATE TABLE stash_instance_format (singleton BOOLEAN PRIMARY KEY CHECK (singleton), version TEXT NOT NULL)");
    await connection.query("INSERT INTO stash_instance_format (singleton, version) VALUES (TRUE, $1)", ["0.1.0"]);
  },
}];

function migrationPath(from: string, to: string): PostgresMigration[] | undefined {
  if (from === to) return [];
  const path: PostgresMigration[] = []; const visited = new Set<string>(); let current = from;
  while (current !== to && !visited.has(current)) { visited.add(current); const step = postgresInstanceMigrations.find((candidate) => candidate.from === current); if (!step) return undefined; path.push(step); current = step.to; }
  return current === to ? path : undefined;
}

async function currentFormat(connection: MigrationConnection, lock = false): Promise<string> {
  const table = await connection.query<{ table_name: string | null }>("SELECT to_regclass('stash_instance_format')::text AS table_name");
  if (!table.rows[0]?.table_name) return legacyUnversionedFormat;
  const stored = await connection.query<{ version: string }>(`SELECT version FROM stash_instance_format WHERE singleton = TRUE${lock ? " FOR UPDATE" : ""}`);
  return stored.rows[0]?.version ?? legacyUnversionedFormat;
}

export class PostgresInstanceUpgradeTarget implements InstanceUpgradeTarget {
  readonly #database: UpgradeDatabase;
  constructor(connectionString: string, private readonly restore: (backupPath: string) => Promise<void>, database?: UpgradeDatabase) {
    this.#database = database ?? new Pool({ connectionString, connectionTimeoutMillis: 2_000, max: 1 });
  }
  async inspect(targetVersion: string): Promise<{ currentVersion: string; checks: UpgradeCheck[] }> {
    try {
      const server = await this.#database.query<{ server_version_num: string }>("SHOW server_version_num");
      const version = Number(server.rows[0]?.server_version_num ?? 0); const currentVersion = await currentFormat(this.#database);
      const path = migrationPath(currentVersion, targetVersion);
      return { currentVersion, checks: [
        { id: "database", status: version >= 150_000 ? "pass" : "fail", message: version >= 150_000 ? "PostgreSQL 15 or newer is reachable." : "PostgreSQL 15 or newer is required." },
        { id: "migration_path", status: path ? "pass" : "fail", message: path ? `An ordered migration path to ${targetVersion} is available.` : `No supported migration path exists from ${currentVersion} to ${targetVersion}.` },
      ] };
    } catch { return { currentVersion: "unknown", checks: [{ id: "database", status: "fail", message: "PostgreSQL upgrade inspection failed." }] }; }
  }
  async apply(fromVersion: string, targetVersion: string): Promise<void> {
    const path = migrationPath(fromVersion, targetVersion); if (!path) throw new Error(`No supported migration path exists from ${fromVersion} to ${targetVersion}`);
    const client = await this.#database.connect();
    try { await client.query("BEGIN"); await client.query("SELECT pg_advisory_xact_lock($1)", [1914047861]);
      const actual = await currentFormat(client, true); if (actual !== fromVersion) throw new Error(`Instance format changed during preflight: ${actual}`);
      for (const migration of path) await migration.apply(client);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
  }
  async rollback(backupPath: string): Promise<void> { await this.restore(backupPath); }
  async close(): Promise<void> { await this.#database.end(); }
}

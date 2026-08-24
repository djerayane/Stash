import { PGlite, type Results } from "@electric-sql/pglite";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Pool } from "pg";

import type { AuthenticationSecretCodec } from "./authentication-secrets.js";
import { PostgresDatabase } from "./postgres-database.js";

export interface InstanceStorePaths {
  readonly root: string;
  readonly database: string;
  readonly attachments: string;
  readonly backups: string;
  readonly configuration: string;
}
export interface EmbeddedTableSnapshot { name: string; columns: string[]; dependsOn: string[]; rows: Array<Record<string, unknown>> }

export class EmbeddedInstanceStoreLocked extends Error {
  constructor(readonly dataDirectory: string, readonly ownerPid?: number) {
    super(ownerPid ? `Embedded Instance data directory is already in use by process ${ownerPid}: ${dataDirectory}`
      : `Embedded Instance data directory is already in use: ${dataDirectory}`);
    this.name = "EmbeddedInstanceStoreLocked";
  }
}

class Mutex {
  #tail = Promise.resolve();
  async acquire(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    const previous = this.#tail;
    this.#tail = previous.then(() => next);
    await previous;
    return release;
  }
}

function pgResult<T>(result: Results<T>) {
  return { ...result, rowCount: result.rowCount ?? result.affectedRows ?? result.rows.length };
}

async function queryEngine<T extends Record<string, unknown>>(engine: PGlite, sql: string, values?: unknown[]) {
  if ((!values || values.length === 0) && sql.split(";").filter((statement) => statement.trim()).length > 1) {
    const results = await engine.exec(sql);
    return pgResult((results.at(-1) ?? { rows: [], fields: [] }) as Results<T>);
  }
  return pgResult(await engine.query<T>(sql, values));
}

/**
 * Presents PGlite at the existing pg Pool seam. PGlite is a single PostgreSQL
 * process, so a checked-out client owns the serializer until release().
 */
class PGlitePoolAdapter {
  readonly #mutex = new Mutex();
  #engine: PGlite;
  constructor(engine: PGlite) { this.#engine = engine; }
  get engine(): PGlite { return this.#engine; }
  on() { return this; }
  async query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, values?: unknown[]) {
    const release = await this.#mutex.acquire();
    try { return await queryEngine<T>(this.#engine, sql, values); }
    finally { release(); }
  }
  async connect() {
    const releaseMutex = await this.#mutex.acquire();
    let released = false;
    return {
      query: async <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, values?: unknown[]) => {
        const result = await queryEngine<T>(this.#engine, sql, values);
        // PGlite 0.5.x does not flush at the end of its transaction helper.
        // Stash uses explicit transaction statements, so make COMMIT the
        // durability boundary promised by the repository interface.
        if (/^\s*COMMIT\b/i.test(sql)) await this.#engine.syncToFs();
        return result;
      },
      release: () => { if (!released) { released = true; releaseMutex(); } },
    };
  }
  async exclusive<T>(operation: (engine: PGlite, replace: (engine: PGlite) => void) => Promise<T>): Promise<T> {
    const release = await this.#mutex.acquire();
    try { return await operation(this.#engine, (engine) => { this.#engine = engine; }); } finally { release(); }
  }
  async end() { await this.exclusive(async (engine) => { if (!engine.closed) await engine.close(); }); }
}

interface LockRecord { pid: number }
function processIsRunning(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

async function acquireLock(path: string, dataDirectory: string): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const file = await open(path, "wx", 0o600);
      await file.writeFile(`${JSON.stringify({ pid: process.pid } satisfies LockRecord)}\n`);
      await file.sync();
      const identity = await file.stat();
      await file.close();
      return async () => {
        try {
          const current = await stat(path);
          if (current.dev === identity.dev && current.ino === identity.ino) await rm(path);
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let owner: LockRecord | undefined;
      try { owner = JSON.parse(await readFile(path, "utf8")) as LockRecord; } catch { /* malformed lock is stale */ }
      if (owner && processIsRunning(owner.pid)) throw new EmbeddedInstanceStoreLocked(dataDirectory, owner.pid);
      const stale = `${path}.stale-${process.pid}-${Date.now()}`;
      try { await rename(path, stale); await rm(stale, { force: true }); }
      catch (renameError) { if ((renameError as NodeJS.ErrnoException).code !== "ENOENT") throw new EmbeddedInstanceStoreLocked(dataDirectory, owner?.pid); }
    }
  }
  throw new EmbeddedInstanceStoreLocked(dataDirectory);
}

export class EmbeddedInstanceStore {
  #closed = false;
  private constructor(
    readonly paths: InstanceStorePaths,
    readonly database: PostgresDatabase,
    readonly upgradeDatabase: import("./postgres-instance-upgrade.js").UpgradeDatabase,
    private readonly releaseLock: () => Promise<void>,
    private readonly pool: PGlitePoolAdapter,
  ) {}

  static async open(dataDirectory: string, authenticationSecrets: AuthenticationSecretCodec): Promise<EmbeddedInstanceStore> {
    const root = resolve(dataDirectory);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const releaseLock = await acquireLock(join(root, ".instance.lock"), root);
    try {
      const paths: InstanceStorePaths = { root, database: join(root, "database"), attachments: join(root, "attachments"),
        backups: join(root, "backups"), configuration: join(root, "config") };
      await Promise.all([paths.database, paths.attachments, paths.backups, paths.configuration]
        .map((path) => mkdir(path, { recursive: true, mode: 0o700 })));
      const engine = await PGlite.create(paths.database, { relaxedDurability: false });
      const pool = new PGlitePoolAdapter(engine);
      const database = new PostgresDatabase("embedded://local", authenticationSecrets, { pool: pool as unknown as Pool });
      return new EmbeddedInstanceStore(paths, database, pool as unknown as import("./postgres-instance-upgrade.js").UpgradeDatabase, releaseLock, pool);
    } catch (error) { await releaseLock().catch(() => undefined); throw error; }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try { await this.database.close(); } finally { await this.releaseLock(); }
  }

  async captureDatabase(destination: string): Promise<void> {
    if (this.#closed) throw new Error("Embedded Instance store is closed");
    await this.pool.exclusive(async (engine) => {
      const dump = await engine.dumpDataDir("gzip");
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, Buffer.from(await dump.arrayBuffer()), { mode: 0o600 });
    });
  }

  async restoreDatabase(source: string): Promise<void> {
    await this.pool.exclusive(async (engine, replace) => {
      const staged = `${this.paths.database}.restore-staged-${process.pid}`; const previous = `${this.paths.database}.restore-previous-${process.pid}`;
      await rm(staged, { recursive: true, force: true }); await rm(previous, { recursive: true, force: true });
      const bytes = await readFile(source); const restored = await PGlite.create({ dataDir: staged, loadDataDir: new Blob([bytes]) }); await restored.close();
      if (!engine.closed) await engine.close(); let movedPrevious = false;
      try {
        await rename(this.paths.database, previous); movedPrevious = true; await rename(staged, this.paths.database);
        const reopened = await PGlite.create(this.paths.database, { relaxedDurability: false }); replace(reopened); await rm(previous, { recursive: true, force: true });
      } catch (error) {
        await rm(this.paths.database, { recursive: true, force: true }).catch(() => undefined);
        if (movedPrevious) await rename(previous, this.paths.database).catch(() => undefined);
        const reopened = await PGlite.create(this.paths.database, { relaxedDurability: false }); replace(reopened);
        await rm(staged, { recursive: true, force: true }).catch(() => undefined); throw error;
      }
    });
  }

  async semanticSnapshot(): Promise<EmbeddedTableSnapshot[]> {
    if (this.#closed) throw new Error("Embedded Instance store is closed");
    const engine = this.pool.engine;
    await engine.query("BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE READ ONLY");
    try {
      const tables = await engine.query<{ table_name: string }>(`SELECT table_name FROM information_schema.tables
        WHERE table_schema=current_schema() AND table_type='BASE TABLE' AND table_name LIKE 'stash_%' ORDER BY table_name`);
      const result: EmbeddedTableSnapshot[] = [];
      for (const { table_name: name } of tables.rows) {
        const columns = (await engine.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns
          WHERE table_schema=current_schema() AND table_name=$1 AND is_generated='NEVER' ORDER BY ordinal_position`, [name])).rows.map((row) => row.column_name);
        const dependencies = (await engine.query<{ referenced_table: string }>(`SELECT DISTINCT referenced.relname AS referenced_table
          FROM pg_constraint constraint_record
          JOIN pg_class referenced ON referenced.oid=constraint_record.confrelid
          WHERE constraint_record.contype='f' AND constraint_record.conrelid=$1::regclass AND constraint_record.confrelid<>constraint_record.conrelid
          ORDER BY referenced.relname`, [name])).rows.map((row) => row.referenced_table);
        const identifier = `"${name.replaceAll('"', '""')}"`;
        const rows = (await engine.query<Record<string, unknown>>(`SELECT * FROM ${identifier}`)).rows;
        result.push({ name, columns, dependsOn: dependencies, rows });
      }
      await engine.query("COMMIT");
      return result;
    } catch (error) { await engine.query("ROLLBACK").catch(() => undefined); throw error; }
  }
}

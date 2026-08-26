import { Pool, type QueryResult, type QueryResultRow } from "pg";

export interface IdlePostgresClientFailure {
  operation: "idle_client";
  cause: string;
  code: string;
}

export interface PostgresKernelOptions {
  pool?: Pool;
  reportIdleClientFailure?: (diagnostic: IdlePostgresClientFailure) => void;
}

export interface PostgresQueryable {
  query<T extends QueryResultRow = any>(text: string, values?: readonly unknown[]): Promise<QueryResult<T>>;
}

function safeIdleClientFailure(cause: unknown): IdlePostgresClientFailure {
  const candidateCause = cause instanceof Error ? cause.name : "UnknownFailure";
  const safeCause = /^[A-Za-z][A-Za-z0-9]{0,31}$/.test(candidateCause) ? candidateCause : "UnknownFailure";
  const candidateCode = cause && typeof cause === "object" && "code" in cause ? String(cause.code) : "";
  const code = /^(?:[A-Z0-9]{5}|E[A-Z_]{2,31})$/.test(candidateCode) ? candidateCode : "unclassified";
  return { operation: "idle_client", cause: safeCause, code };
}

/** Private PostgreSQL mechanics shared by capability-owned adapters. */
export class PostgresKernel implements PostgresQueryable {
  readonly #pool: Pool;

  constructor(connectionString: string, options: PostgresKernelOptions = {}) {
    this.#pool = options.pool ?? new Pool({ connectionString, connectionTimeoutMillis: 2_000 });
    const report = options.reportIdleClientFailure ?? ((diagnostic: IdlePostgresClientFailure) => {
      console.warn(`PostgreSQL idle client unavailable (operation=${diagnostic.operation}, cause=${diagnostic.cause}, code=${diagnostic.code}).`);
    });
    this.#pool.on("error", (cause) => report(safeIdleClientFailure(cause)));
  }

  query<T extends QueryResultRow = any>(text: string, values?: readonly unknown[]): Promise<QueryResult<T>> {
    return values === undefined ? this.#pool.query<T>(text) : this.#pool.query<T>(text, [...values]);
  }

  async withSession<T>(work: (session: PostgresQueryable) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    try {
      return await work(client);
    } finally {
      client.release();
    }
  }

  async transaction<T>(work: (transaction: PostgresQueryable) => Promise<T>): Promise<T> {
    return this.#transaction("BEGIN", work);
  }

  async readOnlySnapshot<T>(work: (transaction: PostgresQueryable) => Promise<T>): Promise<T> {
    return this.#transaction("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY", work);
  }

  async controlledTransaction<T>(
    work: (transaction: PostgresQueryable) => Promise<{ commit: boolean; value: T }>,
  ): Promise<T> {
    return this.preparedControlledTransaction(async () => undefined, work);
  }

  async preparedControlledTransaction<T>(
    prepare: (session: PostgresQueryable) => Promise<void>,
    work: (transaction: PostgresQueryable) => Promise<{ commit: boolean; value: T }>,
  ): Promise<T> {
    const client = await this.#pool.connect();
    try {
      await prepare(client);
      await client.query("BEGIN");
      const result = await work(client);
      await client.query(result.commit ? "COMMIT" : "ROLLBACK");
      return result.value;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async advisorySessionTransaction<T>(
    lockId: number,
    prepare: (session: PostgresQueryable) => Promise<void>,
    work: (transaction: PostgresQueryable) => Promise<T>,
  ): Promise<T> {
    this.#assertAdvisoryLockId(lockId);
    const client = await this.#pool.connect();
    try {
      await prepare(client);
      await client.query(`SELECT pg_advisory_lock(${lockId})`);
      try {
        await client.query("BEGIN");
        const result = await work(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        await client.query(`SELECT pg_advisory_unlock(${lockId})`).catch(() => undefined);
      }
    } finally {
      client.release();
    }
  }

  async advisoryTransactionLock(client: PostgresQueryable, lockId: number): Promise<void> {
    this.#assertAdvisoryLockId(lockId);
    await client.query(`SELECT pg_advisory_xact_lock(${lockId})`);
  }

  async prepareEmptySchemaVersion(
    targetVersion: string,
    initialize: (client: PostgresQueryable) => Promise<void>,
    beforeCommit?: () => Promise<void>,
  ): Promise<void> {
    await this.transaction(async (client) => {
      const existing = await client.query<{ object_name: string }>(`SELECT object_name FROM (
        SELECT c.relname AS object_name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname=current_schema() AND c.relkind IN ('r','p','v','m','S','f','c','i','I')
        UNION ALL SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=current_schema()
        UNION ALL SELECT t.typname FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
          WHERE n.nspname=current_schema() AND t.typrelid=0
        UNION ALL SELECT coll.collname FROM pg_collation coll JOIN pg_namespace n ON n.oid=coll.collnamespace WHERE n.nspname=current_schema()
        UNION ALL SELECT o.oprname FROM pg_operator o JOIN pg_namespace n ON n.oid=o.oprnamespace WHERE n.nspname=current_schema()
        UNION ALL SELECT f.opfname FROM pg_opfamily f JOIN pg_namespace n ON n.oid=f.opfnamespace WHERE n.nspname=current_schema()
        UNION ALL SELECT c.opcname FROM pg_opclass c JOIN pg_namespace n ON n.oid=c.opcnamespace WHERE n.nspname=current_schema()
        UNION ALL SELECT c.conname FROM pg_conversion c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname=current_schema()
        UNION ALL SELECT c.cfgname FROM pg_ts_config c JOIN pg_namespace n ON n.oid=c.cfgnamespace WHERE n.nspname=current_schema()
        UNION ALL SELECT d.dictname FROM pg_ts_dict d JOIN pg_namespace n ON n.oid=d.dictnamespace WHERE n.nspname=current_schema()
        UNION ALL SELECT p.prsname FROM pg_ts_parser p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=current_schema()
        UNION ALL SELECT t.tmplname FROM pg_ts_template t JOIN pg_namespace n ON n.oid=t.tmplnamespace WHERE n.nspname=current_schema()
        UNION ALL SELECT s.stxname FROM pg_statistic_ext s JOIN pg_namespace n ON n.oid=s.stxnamespace WHERE n.nspname=current_schema()
        UNION ALL SELECT e.extname FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE n.nspname=current_schema()
        UNION ALL SELECT co.conname FROM pg_constraint co JOIN pg_namespace n ON n.oid=co.connamespace WHERE n.nspname=current_schema()
        UNION ALL SELECT 'default privileges' FROM pg_default_acl d WHERE d.defaclnamespace=current_schema()::regnamespace
      ) objects ORDER BY object_name LIMIT 1`);
      if (existing.rowCount) throw new Error("Migration destination PostgreSQL schema must be empty before preparation; pre-existing user objects were found");
      await initialize(client);
      await client.query("CREATE TABLE stash_instance_format (singleton BOOLEAN PRIMARY KEY CHECK (singleton), version TEXT NOT NULL)");
      await client.query("INSERT INTO stash_instance_format (singleton, version) VALUES (TRUE, $1)", [targetVersion]);
      await beforeCommit?.();
    });
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }

  async #transaction<T>(begin: string, work: (transaction: PostgresQueryable) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    try {
      await client.query(begin);
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  #assertAdvisoryLockId(lockId: number): void {
    if (!Number.isSafeInteger(lockId)) throw new Error("PostgreSQL advisory lock ID must be a safe integer");
  }
}

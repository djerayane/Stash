import { Pool, type PoolClient } from "pg";

import type { DatabaseProbe } from "./instance.js";
import type { BootstrapRecord, OwnerBootstrapRepository } from "./owner-bootstrap.js";
import type { AccountAuthenticationRecord, PasswordAuthRepository, SessionRecord } from "./password-auth.js";
import type { AuthenticationSecretCodec } from "./authentication-secrets.js";

export class PostgresDatabase implements DatabaseProbe, OwnerBootstrapRepository, PasswordAuthRepository {
  readonly #pool: Pool;
  readonly #authenticationSecrets: AuthenticationSecretCodec;

  constructor(connectionString: string, authenticationSecrets: AuthenticationSecretCodec) {
    this.#pool = new Pool({ connectionString, connectionTimeoutMillis: 2_000 });
    this.#authenticationSecrets = authenticationSecrets;
  }

  async verifyConnection(): Promise<void> {
    await this.#pool.query("SELECT 1");
  }

  async createFirstOrganizationOwner(record: BootstrapRecord): Promise<boolean> {
    const client = await this.#pool.connect();
    try {
      await this.#ensureBootstrapSchema(client);
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(2080289093)");
      const existing = await client.query("SELECT 1 FROM stash_instance_bootstrap WHERE singleton = TRUE");
      if (existing.rowCount) {
        await client.query("ROLLBACK");
        return false;
      }

      await client.query("INSERT INTO stash_organizations (id, name) VALUES ($1, $2)", [
        record.organizationId,
        record.organizationName,
      ]);
      await client.query(
        "INSERT INTO stash_accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)",
        [record.ownerId, record.ownerName, record.ownerEmail, this.#authenticationSecrets.encrypt(record.passwordHash)],
      );
      await client.query(
        "INSERT INTO stash_organization_memberships (organization_id, account_id, role) VALUES ($1, $2, $3)",
        [record.organizationId, record.ownerId, record.role],
      );
      await client.query("INSERT INTO stash_instance_bootstrap (singleton) VALUES (TRUE)");
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }

  async findAccountByEmail(email: string): Promise<AccountAuthenticationRecord | undefined> {
    await this.#ensureAuthSchema();
    const result = await this.#pool.query<AccountRow>(
      "SELECT id, name, email, password_hash FROM stash_accounts WHERE email = $1", [email],
    );
    return result.rows[0] ? this.#accountRecord(result.rows[0]) : undefined;
  }

  async findAccountById(id: string): Promise<AccountAuthenticationRecord | undefined> {
    await this.#ensureAuthSchema();
    const result = await this.#pool.query<AccountRow>(
      "SELECT id, name, email, password_hash FROM stash_accounts WHERE id = $1", [id],
    );
    return result.rows[0] ? this.#accountRecord(result.rows[0]) : undefined;
  }

  async createSession(session: SessionRecord): Promise<void> {
    await this.#ensureAuthSchema();
    await this.#pool.query(
      "INSERT INTO stash_sessions (id, account_id, token_lookup, token_hash, created_at, last_seen_at, user_agent) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [
        session.id,
        session.accountId,
        this.#authenticationSecrets.blindIndex(session.tokenHash),
        this.#authenticationSecrets.encrypt(session.tokenHash),
        session.createdAt,
        session.lastSeenAt,
        session.userAgent ?? null,
      ],
    );
  }

  async findSessionByTokenHash(hash: string): Promise<SessionRecord | undefined> {
    await this.#ensureAuthSchema();
    const result = await this.#pool.query<SessionRow>(
      "SELECT * FROM stash_sessions WHERE token_lookup = $1", [this.#authenticationSecrets.blindIndex(hash)],
    );
    return result.rows[0] ? this.#sessionRecord(result.rows[0]) : undefined;
  }

  async listSessions(accountId: string): Promise<SessionRecord[]> {
    await this.#ensureAuthSchema();
    const result = await this.#pool.query<SessionRow>(
      "SELECT * FROM stash_sessions WHERE account_id = $1 ORDER BY created_at", [accountId],
    );
    return result.rows.map((row) => this.#sessionRecord(row));
  }

  async deleteSession(accountId: string, sessionId: string): Promise<boolean> {
    const result = await this.#pool.query("DELETE FROM stash_sessions WHERE account_id = $1 AND id = $2", [accountId, sessionId]);
    return result.rowCount === 1;
  }

  async changePasswordAndDeleteOtherSessions(
    accountId: string, currentSessionId: string, passwordHash: string,
  ): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "UPDATE stash_accounts SET password_hash = $2 WHERE id = $1",
        [accountId, this.#authenticationSecrets.encrypt(passwordHash)],
      );
      await client.query("DELETE FROM stash_sessions WHERE account_id = $1 AND id <> $2", [accountId, currentSessionId]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async #ensureAuthSchema(): Promise<void> {
    await this.#pool.query(`
      CREATE TABLE IF NOT EXISTS stash_sessions (
        id UUID PRIMARY KEY,
        account_id UUID NOT NULL REFERENCES stash_accounts(id) ON DELETE CASCADE,
        token_lookup TEXT NOT NULL UNIQUE,
        token_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        last_seen_at TIMESTAMPTZ NOT NULL,
        user_agent TEXT
      )
    `);
  }

  #accountRecord(row: AccountRow): AccountAuthenticationRecord {
    return {
      id: row.id,
      name: row.name,
      email: row.email,
      passwordHash: this.#authenticationSecrets.decrypt(row.password_hash),
    };
  }

  #sessionRecord(row: SessionRow): SessionRecord {
    return {
      id: row.id,
      accountId: row.account_id,
      tokenHash: this.#authenticationSecrets.decrypt(row.token_hash),
      createdAt: new Date(row.created_at).toISOString(),
      lastSeenAt: new Date(row.last_seen_at).toISOString(),
      ...(row.user_agent ? { userAgent: row.user_agent } : {}),
    };
  }

  async #ensureBootstrapSchema(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE IF NOT EXISTS stash_organizations (
        id UUID PRIMARY KEY,
        name TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS stash_accounts (
        id UUID PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS stash_organization_memberships (
        organization_id UUID NOT NULL REFERENCES stash_organizations(id),
        account_id UUID NOT NULL REFERENCES stash_accounts(id),
        role TEXT NOT NULL CHECK (role IN ('Owner', 'Admin', 'Member')),
        PRIMARY KEY (organization_id, account_id)
      );
      CREATE TABLE IF NOT EXISTS stash_instance_bootstrap (
        singleton BOOLEAN PRIMARY KEY CHECK (singleton)
      );
    `);
  }
}

interface AccountRow { id: string; name: string; email: string; password_hash: string }
interface SessionRow { id: string; account_id: string; token_hash: string; created_at: Date | string; last_seen_at: Date | string; user_agent: string | null }

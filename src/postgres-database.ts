import { Pool, type PoolClient } from "pg";

import type { DatabaseProbe } from "./instance.js";
import type { BootstrapRecord, OwnerBootstrapRepository } from "./owner-bootstrap.js";
import type { AccountAuthenticationRecord, PasswordAuthRepository, SessionRecord } from "./password-auth.js";
import {
  createAuthenticationKeyCheck,
  verifyAuthenticationKeyCheck,
  type AuthenticationSecretCodec,
} from "./authentication-secrets.js";
import type {
  PortableIdentity,
  PortableProjectProjection,
  PortableWorkspaceProjection,
  WorkspaceProjectRecord,
  WorkspaceProjectRepository,
  WorkspaceRecord,
} from "./workspaces-projects.js";

// First 31 bits of SHA-256("stash:authentication-key-check:v1"); reserved in Stash's
// PostgreSQL advisory-lock ID domain for serializing only the authentication key-check transaction.
const authenticationKeyCheckLockId = 795_541_992;

export class PostgresDatabase implements
  DatabaseProbe,
  OwnerBootstrapRepository,
  PasswordAuthRepository,
  WorkspaceProjectRepository
{
  readonly #pool: Pool;
  readonly #authenticationSecrets: AuthenticationSecretCodec;

  constructor(connectionString: string, authenticationSecrets: AuthenticationSecretCodec) {
    this.#pool = new Pool({ connectionString, connectionTimeoutMillis: 2_000 });
    this.#authenticationSecrets = authenticationSecrets;
  }

  async verifyConnection(): Promise<void> {
    await this.#pool.query("SELECT 1");
    await this.#verifyAuthenticationKey();
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

  async findPortableMemberIdentity(memberId: string): Promise<PortableIdentity | undefined> {
    const client = await this.#pool.connect();
    try {
      await this.#ensureBootstrapSchema(client);
      const result = await client.query<{ id: string; name: string }>(
        "SELECT id, name FROM stash_accounts WHERE id = $1",
        [memberId],
      );
      const member = result.rows[0];
      return member
        ? { localAccountId: member.id, displayName: member.name }
        : undefined;
    } finally {
      client.release();
    }
  }

  async createWorkspace(
    record: WorkspaceRecord,
    createdBy: PortableIdentity,
  ): Promise<
    | { status: "created"; projection: PortableWorkspaceProjection }
    | { status: "organization_forbidden" }
  > {
    return this.#withTransaction(async (client) => {
      await this.#ensureWorkspaceProjectSchema(client);
      let owner: PortableWorkspaceProjection["owner"];
      if (record.owner.type === "organization") {
        const authorizedOrganization = await client.query<{ id: string; name: string }>(
          `SELECT organization.id, organization.name
           FROM stash_organization_memberships membership
           JOIN stash_organizations organization ON organization.id = membership.organization_id
           WHERE membership.organization_id = $1 AND membership.account_id = $2`,
          [record.owner.id, record.createdByMemberId],
        );
        const organization = authorizedOrganization.rows[0];
        if (!organization) return { status: "organization_forbidden" };
        owner = {
          type: "organization",
          identity: {
            localOrganizationId: organization.id,
            displayName: organization.name,
          },
        };
      } else {
        owner = { type: "personal", identity: createdBy };
      }
      const projection: PortableWorkspaceProjection = {
        schema: "stash.workspace.v1",
        id: record.id,
        name: record.name,
        owner,
        createdBy,
      };
      await client.query(
        `INSERT INTO stash_workspaces
          (id, name, owner_type, personal_owner_id, organization_owner_id, created_by_account_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          record.id,
          record.name,
          record.owner.type,
          record.owner.type === "personal" ? record.owner.id : null,
          record.owner.type === "organization" ? record.owner.id : null,
          record.createdByMemberId,
        ],
      );
      await this.#recordPortableProjection(
        client,
        "Workspace",
        record.id,
        "stash.workspace.v1",
        projection,
      );
      return { status: "created", projection };
    });
  }

  async createProject(
    memberId: string,
    record: WorkspaceProjectRecord,
    projection: PortableProjectProjection,
  ): Promise<"created" | "workspace_forbidden" | "workspace_not_found" | "key_conflict"> {
    return this.#withTransaction(async (client) => {
      await this.#ensureWorkspaceProjectSchema(client);
      const access = await client.query<{ allowed: boolean }>(
        `SELECT (
           (owner_type = 'personal' AND personal_owner_id = $2)
           OR (owner_type = 'organization' AND EXISTS (
             SELECT 1 FROM stash_organization_memberships membership
             WHERE membership.organization_id = stash_workspaces.organization_owner_id
               AND membership.account_id = $2
           ))
         ) AS allowed
         FROM stash_workspaces WHERE id = $1`,
        [record.workspaceId, memberId],
      );
      if (!access.rowCount) return "workspace_not_found";
      if (!access.rows[0]!.allowed) return "workspace_forbidden";
      const inserted = await client.query(
        `INSERT INTO stash_projects (id, workspace_id, name, project_key, created_by_account_id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (workspace_id, project_key) DO NOTHING
         RETURNING id`,
        [record.id, record.workspaceId, record.name, record.key, record.createdByMemberId],
      );
      if (!inserted.rowCount) return "key_conflict";
      await this.#recordPortableProjection(
        client,
        "Project",
        record.id,
        "stash.project.v1",
        projection,
      );
      return "created";
    });
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

  async #verifyAuthenticationKey(): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS stash_authentication_key_check (
          singleton BOOLEAN PRIMARY KEY CHECK (singleton),
          encrypted_check TEXT NOT NULL
        )
      `);
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [authenticationKeyCheckLockId]);
      const result = await client.query<{ encrypted_check: string }>(
        "SELECT encrypted_check FROM stash_authentication_key_check WHERE singleton = TRUE",
      );
      const existing = result.rows[0];
      if (existing) {
        verifyAuthenticationKeyCheck(this.#authenticationSecrets, existing.encrypted_check);
      } else {
        await client.query(
          "INSERT INTO stash_authentication_key_check (singleton, encrypted_check) VALUES (TRUE, $1)",
          [createAuthenticationKeyCheck(this.#authenticationSecrets)],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
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

  async #ensureWorkspaceProjectSchema(client: PoolClient): Promise<void> {
    await this.#ensureBootstrapSchema(client);
    await client.query(`
      CREATE TABLE IF NOT EXISTS stash_workspaces (
        id UUID PRIMARY KEY,
        name TEXT NOT NULL,
        owner_type TEXT NOT NULL CHECK (owner_type IN ('personal', 'organization')),
        personal_owner_id UUID REFERENCES stash_accounts(id),
        organization_owner_id UUID REFERENCES stash_organizations(id),
        created_by_account_id UUID NOT NULL REFERENCES stash_accounts(id),
        CHECK (
          (owner_type = 'personal' AND personal_owner_id IS NOT NULL AND organization_owner_id IS NULL)
          OR
          (owner_type = 'organization' AND personal_owner_id IS NULL AND organization_owner_id IS NOT NULL)
        )
      );
      CREATE TABLE IF NOT EXISTS stash_projects (
        id UUID PRIMARY KEY,
        workspace_id UUID NOT NULL REFERENCES stash_workspaces(id),
        name TEXT NOT NULL,
        project_key TEXT NOT NULL,
        created_by_account_id UUID NOT NULL REFERENCES stash_accounts(id),
        UNIQUE (workspace_id, project_key)
      );
      CREATE TABLE IF NOT EXISTS stash_portable_projection_outbox (
        object_kind TEXT NOT NULL CHECK (object_kind IN ('Workspace', 'Project')),
        object_id UUID NOT NULL,
        revision INTEGER NOT NULL CHECK (revision > 0),
        projection_schema TEXT NOT NULL,
        payload JSONB NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'projected')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (object_kind, object_id, revision)
      );
    `);
  }

  async #recordPortableProjection(
    client: PoolClient,
    objectKind: "Workspace" | "Project",
    objectId: string,
    projectionSchema: "stash.workspace.v1" | "stash.project.v1",
    payload: PortableWorkspaceProjection | PortableProjectProjection,
  ): Promise<void> {
    await client.query(
      `INSERT INTO stash_portable_projection_outbox
        (object_kind, object_id, revision, projection_schema, payload)
       VALUES ($1, $2, 1, $3, $4::jsonb)`,
      [objectKind, objectId, projectionSchema, JSON.stringify(payload)],
    );
  }

  async #withTransaction<Result>(operation: (client: PoolClient) => Promise<Result>): Promise<Result> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

interface AccountRow { id: string; name: string; email: string; password_hash: string }
interface SessionRow { id: string; account_id: string; token_hash: string; created_at: Date | string; last_seen_at: Date | string; user_agent: string | null }

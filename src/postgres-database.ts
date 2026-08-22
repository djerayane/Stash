import { Pool, type PoolClient } from "pg";

import type { DatabaseProbe } from "./instance.js";
import type { NoteRecord, NoteRepository, PortableNoteProjection } from "./notes.js";
import type { BootstrapRecord, OwnerBootstrapRepository } from "./owner-bootstrap.js";
import type { AccountAuthenticationRecord, PasswordAuthRepository, SessionRecord } from "./password-auth.js";
import type { OidcAuthRepository, OidcIdentityKey, OidcIdentityRecord, OidcOrganizationConfiguration } from "./oidc-auth.js";
import type { AccountRecoveryRepository, ClaimedEmailRecoveryDelivery, EmailRecoveryDeliveryClaim, EmailRecoveryDeliveryJob, EmailRecoveryRecord, PasskeyRecord, RecoveryCodeRecord } from "./account-recovery.js";
import type { BuiltInOrganizationRole, OrganizationRoleRepository } from "./organization-roles.js";
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
  WorkspaceProjectRepository,
  NoteRepository,
  OidcAuthRepository,
  AccountRecoveryRepository,
  OrganizationRoleRepository
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

  async createNote(
    memberId: string,
    note: NoteRecord,
    projection: PortableNoteProjection,
  ): Promise<"created" | "workspace_forbidden" | "project_forbidden"> {
    return this.#withTransaction(async (client) => {
      await this.#ensureNoteSchema(client);
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
        [note.workspaceId, memberId],
      );
      if (!access.rows[0]?.allowed) return "workspace_forbidden";
      if (note.projectId) {
        const project = await client.query(
          "SELECT 1 FROM stash_projects WHERE id = $1 AND workspace_id = $2",
          [note.projectId, note.workspaceId],
        );
        if (!project.rowCount) return "project_forbidden";
      }
      await client.query(
        `INSERT INTO stash_notes
          (id, workspace_id, project_id, content, tags, reminder_at, created_by_account_id, created_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)`,
        [
          note.id,
          note.workspaceId,
          note.projectId ?? null,
          note.content,
          JSON.stringify(note.tags),
          note.reminder?.at ?? null,
          note.createdByMemberId,
          note.createdAt,
        ],
      );
      await this.#recordPortableProjection(client, "Note", note.id, "stash.note.v1", projection);
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

  async findOidcIdentity(key: OidcIdentityKey): Promise<OidcIdentityRecord | undefined> {
    await this.#ensureOidcSchema();
    const result = await this.#pool.query<OidcIdentityRow>(`
      SELECT a.id, a.name, a.email, i.subject_secret
      FROM stash_oidc_identities i
      JOIN stash_accounts a ON a.id = i.account_id
      JOIN stash_organization_memberships m ON m.account_id = a.id AND m.organization_id = i.organization_id
      WHERE i.organization_id = $1 AND i.issuer = $2 AND i.subject_lookup = $3
    `, [key.organizationId, key.issuer, this.#oidcIdentityLookup(key)]);
    const row = result.rows[0];
    if (!row || this.#authenticationSecrets.decrypt(row.subject_secret) !== key.subject) return undefined;
    return { accountId: row.id, name: row.name, email: row.email };
  }

  async findOidcConfiguration(organizationId: string): Promise<OidcOrganizationConfiguration | undefined> {
    await this.#ensureOidcSchema();
    const result = await this.#pool.query<OidcConfigurationRow>(
      "SELECT organization_id, issuer, client_id, client_secret FROM stash_oidc_configurations WHERE organization_id = $1",
      [organizationId],
    );
    const row = result.rows[0];
    return row ? {
      organizationId: row.organization_id,
      issuer: row.issuer,
      clientId: row.client_id,
      clientSecret: this.#authenticationSecrets.decrypt(row.client_secret),
    } : undefined;
  }

  async organizationRole(organizationId: string, accountId: string): Promise<BuiltInOrganizationRole | undefined> {
    const result = await this.#pool.query<{ role: BuiltInOrganizationRole }>(
      "SELECT role FROM stash_organization_memberships WHERE organization_id = $1 AND account_id = $2",
      [organizationId, accountId],
    );
    return result.rows[0]?.role;
  }

  async assignBuiltInRole(
    organizationId: string,
    actorId: string,
    accountId: string,
    role: BuiltInOrganizationRole,
  ): Promise<"updated" | "member_not_found" | "final_owner" | "forbidden"> {
    return this.#withTransaction(async (client) => {
      const memberships = await this.#lockedOrganizationMemberships(client, organizationId);
      if (!this.#canManageRoles(memberships, actorId)) return "forbidden";
      const target = memberships.find((membership) => membership.account_id === accountId);
      if (!target) return "member_not_found";
      if (target.role === "Owner" && role !== "Owner"
        && this.#isOnlyOwner(memberships, accountId)) {
        return "final_owner";
      }
      await client.query(
        `UPDATE stash_organization_memberships SET role = $3
         WHERE organization_id = $1 AND account_id = $2`,
        [organizationId, accountId, role],
      );
      return "updated";
    });
  }

  async removeOrganizationMember(
    organizationId: string,
    actorId: string,
    accountId: string,
  ): Promise<"removed" | "member_not_found" | "final_owner" | "forbidden"> {
    return this.#withTransaction(async (client) => {
      const memberships = await this.#lockedOrganizationMemberships(client, organizationId);
      if (!this.#canManageRoles(memberships, actorId)) return "forbidden";
      const target = memberships.find((membership) => membership.account_id === accountId);
      if (!target) return "member_not_found";
      if (target.role === "Owner" && this.#isOnlyOwner(memberships, accountId)) {
        return "final_owner";
      }
      await client.query(
        "DELETE FROM stash_organization_memberships WHERE organization_id = $1 AND account_id = $2",
        [organizationId, accountId],
      );
      return "removed";
    });
  }

  async #lockedOrganizationMemberships(client: PoolClient, organizationId: string) {
    await this.#ensureBootstrapSchema(client);
    const memberships = await client.query<{ account_id: string; role: BuiltInOrganizationRole }>(
      `SELECT account_id, role FROM stash_organization_memberships
       WHERE organization_id = $1 FOR UPDATE`,
      [organizationId],
    );
    return memberships.rows;
  }

  #isOnlyOwner(
    memberships: ReadonlyArray<{ account_id: string; role: BuiltInOrganizationRole }>,
    accountId: string,
  ): boolean {
    return memberships.filter((membership) => membership.role === "Owner").length === 1
      && memberships.some(
        (membership) => membership.account_id === accountId && membership.role === "Owner",
      );
  }

  #canManageRoles(
    memberships: ReadonlyArray<{ account_id: string; role: BuiltInOrganizationRole }>,
    accountId: string,
  ): boolean {
    return memberships.some(
      (membership) => membership.account_id === accountId && membership.role === "Owner",
    );
  }

  async saveOidcConfiguration(configuration: OidcOrganizationConfiguration): Promise<void> {
    await this.#ensureOidcSchema();
    await this.#pool.query(`
      INSERT INTO stash_oidc_configurations (organization_id, issuer, client_id, client_secret)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (organization_id) DO UPDATE SET issuer = EXCLUDED.issuer, client_id = EXCLUDED.client_id, client_secret = EXCLUDED.client_secret
    `, [configuration.organizationId, configuration.issuer, configuration.clientId, this.#authenticationSecrets.encrypt(configuration.clientSecret)]);
  }

  async linkOidcIdentity(key: OidcIdentityKey, accountId: string): Promise<boolean> {
    await this.#ensureOidcSchema();
    const result = await this.#pool.query(`
      INSERT INTO stash_oidc_identities (organization_id, issuer, subject_lookup, subject_secret, account_id)
      SELECT $1, $3, $4, $5, account_id FROM stash_organization_memberships
      WHERE organization_id = $1 AND account_id = $2
      ON CONFLICT (organization_id, issuer, account_id) DO UPDATE
      SET subject_lookup = EXCLUDED.subject_lookup, subject_secret = EXCLUDED.subject_secret
    `, [key.organizationId, accountId, key.issuer, this.#oidcIdentityLookup(key), this.#authenticationSecrets.encrypt(key.subject)]);
    return result.rowCount === 1;
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

  async savePasskey(record: PasskeyRecord): Promise<void> {
    await this.#ensureRecoverySchema();
    await this.#pool.query(
      "INSERT INTO stash_passkeys (credential_id, account_id, public_key, signature_counter, transports, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
      [record.credentialId, record.accountId, this.#authenticationSecrets.encrypt(record.publicKey), record.counter, record.transports ?? null, record.createdAt],
    );
  }

  async findPasskey(credentialId: string): Promise<PasskeyRecord | undefined> {
    await this.#ensureRecoverySchema();
    const result = await this.#pool.query<{ credential_id: string; account_id: string; public_key: string; signature_counter: number; transports: string[] | null; created_at: Date | string }>(
      "SELECT credential_id, account_id, public_key, signature_counter, transports, created_at FROM stash_passkeys WHERE credential_id = $1", [credentialId],
    );
    const row = result.rows[0];
    return row ? { credentialId: row.credential_id, accountId: row.account_id, publicKey: this.#authenticationSecrets.decrypt(row.public_key), counter: row.signature_counter, ...(row.transports ? { transports: row.transports } : {}), createdAt: new Date(row.created_at).toISOString() } : undefined;
  }

  async updatePasskeyCounterAndCreateSession(credentialId: string, previousCounter: number, newCounter: number, session: SessionRecord): Promise<boolean> {
    return this.#transaction(async (client) => {
      const result = await client.query("UPDATE stash_passkeys SET signature_counter = $3 WHERE credential_id = $1 AND signature_counter = $2", [credentialId, previousCounter, newCounter]);
      if (result.rowCount !== 1) return { commit: false, value: false };
      await this.#insertSession(client, session);
      return { commit: true, value: true };
    });
  }

  async replaceRecoveryCodes(accountId: string, records: RecoveryCodeRecord[]): Promise<void> {
    await this.#ensureRecoverySchema();
    await this.#transaction(async (client) => {
      await client.query("DELETE FROM stash_recovery_codes WHERE account_id = $1", [accountId]);
      for (const record of records) await client.query("INSERT INTO stash_recovery_codes (account_id, code_lookup, protected_secret) VALUES ($1, $2, $3)", [accountId, this.#authenticationSecrets.blindIndex(record.lookup), record.protectedSecret]);
      return { commit: true, value: undefined };
    });
  }

  async consumeRecoveryCodeAndCreateSession(accountId: string, lookup: string, session?: SessionRecord): Promise<boolean> {
    await this.#ensureRecoverySchema();
    return this.#transaction(async (client) => {
      const result = await client.query("DELETE FROM stash_recovery_codes WHERE account_id = $1 AND code_lookup = $2", [accountId, this.#authenticationSecrets.blindIndex(lookup)]);
      if (result.rowCount !== 1 || !session) return { commit: false, value: false };
      await this.#insertSession(client, session);
      return { commit: true, value: true };
    });
  }

  async enqueueEmailRecovery(job: EmailRecoveryDeliveryJob): Promise<void> {
    await this.#ensureRecoverySchema();
    await this.#transaction(async (client) => {
      await client.query("INSERT INTO stash_email_recovery_delivery_jobs (id, protected_delivery, created_at) VALUES ($1, $2, $3)", [job.id, job.protectedDelivery, job.createdAt]);
      return { commit: true, value: undefined };
    });
  }

  async findEmailRecoveryAccount(lookup: string, now: string): Promise<string | undefined> {
    await this.#ensureRecoverySchema();
    const result = await this.#pool.query<{ account_id: string }>("SELECT account_id FROM stash_email_recoveries WHERE token_lookup = $1 AND expires_at > $2", [this.#authenticationSecrets.blindIndex(lookup), now]);
    return result.rows[0]?.account_id;
  }

  async consumeEmailRecoveryAndCreateSession(lookup: string, now: string, session: SessionRecord): Promise<boolean> {
    return this.#transaction(async (client) => {
      const result = await client.query("DELETE FROM stash_email_recoveries WHERE token_lookup = $1 AND account_id = $2 AND expires_at > $3", [this.#authenticationSecrets.blindIndex(lookup), session.accountId, now]);
      if (result.rowCount !== 1) return { commit: false, value: false };
      await this.#insertSession(client, session);
      return { commit: true, value: true };
    });
  }

  async claimEmailRecoveryDelivery(owner: string, leaseUntil: string): Promise<ClaimedEmailRecoveryDelivery | undefined> {
    await this.#ensureRecoverySchema();
    return this.#transaction(async (client) => {
      const result = await client.query<{ id: string; protected_delivery: string; created_at: Date | string; claim_version: number }>("SELECT id, protected_delivery, created_at, claim_version FROM stash_email_recovery_delivery_jobs WHERE available_at <= NOW() AND (lease_until IS NULL OR lease_until <= NOW()) ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED");
      const row = result.rows[0];
      if (!row) return { commit: false, value: undefined };
      const claimVersion = Number(row.claim_version) + 1;
      await client.query("UPDATE stash_email_recovery_delivery_jobs SET claim_owner = $2, claim_version = $3, lease_until = $4 WHERE id = $1", [row.id, owner, claimVersion, leaseUntil]);
      return { commit: true, value: {
        job: { id: row.id, protectedDelivery: row.protected_delivery, createdAt: new Date(row.created_at).toISOString() },
        claim: { jobId: row.id, owner, version: claimVersion },
      } };
    });
  }
  async renewEmailRecoveryDelivery(claim: EmailRecoveryDeliveryClaim, leaseUntil: string): Promise<boolean> {
    const result = await this.#pool.query("UPDATE stash_email_recovery_delivery_jobs SET lease_until = $4 WHERE id = $1 AND claim_owner = $2 AND claim_version = $3", [claim.jobId, claim.owner, claim.version, leaseUntil]);
    return result.rowCount === 1;
  }
  async completeEmailRecoveryDelivery(claim: EmailRecoveryDeliveryClaim, activation?: EmailRecoveryRecord): Promise<boolean> {
    return this.#transaction(async (client) => {
      const deleted = await client.query("DELETE FROM stash_email_recovery_delivery_jobs WHERE id = $1 AND claim_owner = $2 AND claim_version = $3", [claim.jobId, claim.owner, claim.version]);
      if (deleted.rowCount !== 1) return { commit: false, value: false };
      if (activation) await client.query("INSERT INTO stash_email_recoveries (token_lookup, account_id, protected_secret, expires_at) VALUES ($1, $2, $3, $4)", [this.#authenticationSecrets.blindIndex(activation.tokenLookup), activation.accountId, activation.protectedSecret, activation.expiresAt]);
      return { commit: true, value: true };
    });
  }
  async retryEmailRecoveryDelivery(claim: EmailRecoveryDeliveryClaim, reason: string): Promise<boolean> {
    const result = await this.#pool.query("UPDATE stash_email_recovery_delivery_jobs SET attempts = attempts + 1, last_error = $4, available_at = NOW() + INTERVAL '1 minute', claim_owner = NULL, lease_until = NULL WHERE id = $1 AND claim_owner = $2 AND claim_version = $3", [claim.jobId, claim.owner, claim.version, reason.slice(0, 500)]);
    return result.rowCount === 1;
  }

  async #insertSession(client: PoolClient, session: SessionRecord): Promise<void> {
    await client.query(
      "INSERT INTO stash_sessions (id, account_id, token_lookup, token_hash, created_at, last_seen_at, user_agent) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [session.id, session.accountId, this.#authenticationSecrets.blindIndex(session.tokenHash), this.#authenticationSecrets.encrypt(session.tokenHash), session.createdAt, session.lastSeenAt, session.userAgent ?? null],
    );
  }

  async #transaction<T>(work: (client: PoolClient) => Promise<{ commit: boolean; value: T }>): Promise<T> {
    const client = await this.#pool.connect();
    try {
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

  async #ensureOidcSchema(): Promise<void> {
    await this.#pool.query(`
      CREATE TABLE IF NOT EXISTS stash_oidc_configurations (
        organization_id UUID PRIMARY KEY REFERENCES stash_organizations(id) ON DELETE CASCADE,
        issuer TEXT NOT NULL,
        client_id TEXT NOT NULL,
        client_secret TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS stash_oidc_identities (
        organization_id UUID NOT NULL REFERENCES stash_organizations(id) ON DELETE CASCADE,
        issuer TEXT NOT NULL,
        subject_lookup TEXT NOT NULL,
        subject_secret TEXT NOT NULL,
        account_id UUID NOT NULL REFERENCES stash_accounts(id) ON DELETE CASCADE,
        PRIMARY KEY (organization_id, issuer, subject_lookup),
        UNIQUE (organization_id, issuer, account_id)
      )
    `);
  }

  #oidcIdentityLookup(key: OidcIdentityKey): string {
    return this.#authenticationSecrets.blindIndex(
      `oidc-identity-v1:${JSON.stringify([key.organizationId, key.issuer, key.subject])}`,
    );
  }

  async #ensureRecoverySchema(): Promise<void> {
    await this.#ensureAuthSchema();
    await this.#pool.query(`
      CREATE TABLE IF NOT EXISTS stash_passkeys (
        credential_id TEXT PRIMARY KEY,
        account_id UUID NOT NULL REFERENCES stash_accounts(id) ON DELETE CASCADE,
        public_key TEXT NOT NULL,
        signature_counter BIGINT NOT NULL,
        transports TEXT[],
        created_at TIMESTAMPTZ NOT NULL
      );
      CREATE TABLE IF NOT EXISTS stash_recovery_codes (
        account_id UUID NOT NULL REFERENCES stash_accounts(id) ON DELETE CASCADE,
        code_lookup TEXT NOT NULL,
        protected_secret TEXT NOT NULL,
        PRIMARY KEY (account_id, code_lookup)
      );
      CREATE TABLE IF NOT EXISTS stash_email_recoveries (
        token_lookup TEXT PRIMARY KEY,
        account_id UUID NOT NULL REFERENCES stash_accounts(id) ON DELETE CASCADE,
        protected_secret TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL
      );
      CREATE TABLE IF NOT EXISTS stash_email_recovery_delivery_jobs (
        id UUID PRIMARY KEY,
        protected_delivery TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        claim_owner UUID,
        claim_version BIGINT NOT NULL DEFAULT 0,
        lease_until TIMESTAMPTZ
      );
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
        object_kind TEXT NOT NULL CHECK (object_kind IN ('Workspace', 'Project', 'Note')),
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

  async #ensureNoteSchema(client: PoolClient): Promise<void> {
    await this.#ensureWorkspaceProjectSchema(client);
    await client.query(`
      CREATE TABLE IF NOT EXISTS stash_notes (
        id UUID PRIMARY KEY,
        workspace_id UUID NOT NULL REFERENCES stash_workspaces(id),
        project_id UUID REFERENCES stash_projects(id),
        content TEXT NOT NULL CHECK (length(content) > 0),
        tags JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(tags) = 'array'),
        reminder_at TIMESTAMPTZ,
        created_by_account_id UUID NOT NULL REFERENCES stash_accounts(id),
        created_at TIMESTAMPTZ NOT NULL
      )
    `);
    await client.query("SELECT pg_advisory_xact_lock(1094218495)");
    await client.query(`
      DO $migration$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = 'stash_portable_projection_outbox'::regclass
            AND conname = 'stash_portable_projection_outbox_object_kind_check'
            AND pg_get_constraintdef(oid) NOT LIKE '%Note%'
        ) THEN
          ALTER TABLE stash_portable_projection_outbox
            DROP CONSTRAINT stash_portable_projection_outbox_object_kind_check;
          ALTER TABLE stash_portable_projection_outbox
            ADD CONSTRAINT stash_portable_projection_outbox_object_kind_check
            CHECK (object_kind IN ('Workspace', 'Project', 'Note'));
        END IF;
      END
      $migration$
    `);
  }

  async #recordPortableProjection(
    client: PoolClient,
    objectKind: "Workspace" | "Project" | "Note",
    objectId: string,
    projectionSchema: "stash.workspace.v1" | "stash.project.v1" | "stash.note.v1",
    payload: PortableWorkspaceProjection | PortableProjectProjection | PortableNoteProjection,
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
interface OidcIdentityRow { id: string; name: string; email: string; subject_secret: string }
interface OidcConfigurationRow { organization_id: string; issuer: string; client_id: string; client_secret: string }

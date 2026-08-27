import type { AccountRegistrationRepository, RegistrationRecord } from "../account-registration.js";
import type { AuthenticationSecretCodec } from "../authentication-secrets.js";
import type { AccountAuthenticationRecord, PasswordAuthRepository, SessionRecord } from "../password-auth.js";
import type { PostgresKernel, PostgresQueryable } from "../instance-operations/storage/postgres-kernel.js";

interface AccountRow { id: string; name: string; email: string; password_hash: string }
interface SessionRow { id: string; account_id: string; token_hash: string; created_at: Date | string; last_seen_at: Date | string; user_agent: string | null }

/** PostgreSQL persistence owned by the Identity Access capability. */
export class PostgresIdentityAccessRepositories implements PasswordAuthRepository, AccountRegistrationRepository {
  constructor(
    private readonly kernel: PostgresKernel,
    private readonly secrets: AuthenticationSecretCodec,
    private readonly dependencies: {
      prepareRegistration(client: PostgresQueryable): Promise<void>;
      recordWorkspaceProjection(client: PostgresQueryable, record: RegistrationRecord): Promise<void>;
    },
  ) {}

  async createAccountWithPersonalWorkspaceAndSession(record: RegistrationRecord): Promise<boolean> {
    return this.kernel.transaction(async (client) => {
      await this.dependencies.prepareRegistration(client);
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`registration:${record.account.email}`]);
      if ((await client.query("SELECT 1 FROM stash_accounts WHERE email=$1", [record.account.email])).rowCount) return false;
      await client.query("INSERT INTO stash_accounts(id,name,email,password_hash) VALUES($1,$2,$3,$4)", [
        record.account.id, record.account.name, record.account.email, this.secrets.encrypt(record.account.passwordHash),
      ]);
      await client.query(
        `INSERT INTO stash_workspaces
          (id,name,owner_type,personal_owner_id,organization_owner_id,created_by_account_id,created_at)
         VALUES($1,$2,'personal',$3,NULL,$3,$4)`,
        [record.workspace.id, record.workspace.name, record.account.id, record.session.createdAt],
      );
      await this.dependencies.recordWorkspaceProjection(client, record);
      await this.insertSession(client, record.session);
      return true;
    });
  }

  async findAccountByEmail(email: string): Promise<AccountAuthenticationRecord | undefined> {
    const result = await this.kernel.query<AccountRow>(
      "SELECT id, name, email, password_hash FROM stash_accounts WHERE email = $1", [email],
    );
    return result.rows[0] ? this.accountRecord(result.rows[0]) : undefined;
  }

  async findAccountById(id: string): Promise<AccountAuthenticationRecord | undefined> {
    const result = await this.kernel.query<AccountRow>(
      "SELECT id, name, email, password_hash FROM stash_accounts WHERE id = $1", [id],
    );
    return result.rows[0] ? this.accountRecord(result.rows[0]) : undefined;
  }

  async createSession(session: SessionRecord): Promise<void> { await this.insertSession(this.kernel, session); }

  async findSessionByTokenHash(hash: string): Promise<SessionRecord | undefined> {
    const result = await this.kernel.query<SessionRow>(
      "SELECT * FROM stash_sessions WHERE token_lookup = $1", [this.secrets.blindIndex(hash)],
    );
    return result.rows[0] ? this.sessionRecord(result.rows[0]) : undefined;
  }

  async listSessions(accountId: string): Promise<SessionRecord[]> {
    const result = await this.kernel.query<SessionRow>(
      "SELECT * FROM stash_sessions WHERE account_id = $1 ORDER BY created_at", [accountId],
    );
    return result.rows.map((row) => this.sessionRecord(row));
  }

  async deleteSession(accountId: string, sessionId: string): Promise<boolean> {
    const result = await this.kernel.query("DELETE FROM stash_sessions WHERE account_id = $1 AND id = $2", [accountId, sessionId]);
    return result.rowCount === 1;
  }

  async changePasswordAndDeleteOtherSessions(accountId: string, currentSessionId: string, passwordHash: string): Promise<void> {
    await this.kernel.transaction(async (client) => {
      await client.query("UPDATE stash_accounts SET password_hash = $2 WHERE id = $1", [accountId, this.secrets.encrypt(passwordHash)]);
      await client.query("DELETE FROM stash_sessions WHERE account_id = $1 AND id <> $2", [accountId, currentSessionId]);
    });
  }

  private async insertSession(client: PostgresQueryable, session: SessionRecord): Promise<void> {
    await client.query(
      "INSERT INTO stash_sessions (id, account_id, token_lookup, token_hash, created_at, last_seen_at, user_agent) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [session.id, session.accountId, this.secrets.blindIndex(session.tokenHash), this.secrets.encrypt(session.tokenHash),
        session.createdAt, session.lastSeenAt, session.userAgent ?? null],
    );
  }

  private accountRecord(row: AccountRow): AccountAuthenticationRecord {
    return { id: row.id, name: row.name, email: row.email, passwordHash: this.secrets.decrypt(row.password_hash) };
  }

  private sessionRecord(row: SessionRow): SessionRecord {
    return { id: row.id, accountId: row.account_id, tokenHash: this.secrets.decrypt(row.token_hash),
      createdAt: new Date(row.created_at).toISOString(), lastSeenAt: new Date(row.last_seen_at).toISOString(),
      ...(row.user_agent ? { userAgent: row.user_agent } : {}) };
  }
}

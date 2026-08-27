import type { AccountRegistrationRepository, RegistrationRecord } from "../account-registration.js";
import type { AuthenticationSecretCodec } from "../authentication-secrets.js";
import type { AccountAuthenticationRecord, PasswordAuthRepository, SessionRecord } from "../password-auth.js";
import type { PostgresKernel, PostgresQueryable } from "../instance-operations/storage/postgres-kernel.js";
import type { OidcAuthRepository, OidcIdentityKey, OidcIdentityRecord, OidcOrganizationConfiguration } from "../oidc-auth.js";
import type { BuiltInOrganizationRole } from "../organization-roles.js";
import type { MemberLocalizationPreferences, MemberLocalizationRepository } from "../member-localization.js";
import type { PortableIdentity, PortableProjectProjection, PortableWorkspaceProjection, WorkspaceProjectRecord,
  WorkspaceProjectRepository, WorkspaceRecord } from "../workspaces-projects.js";

interface AccountRow { id: string; name: string; email: string; password_hash: string }
interface SessionRow { id: string; account_id: string; token_hash: string; created_at: Date | string; last_seen_at: Date | string; user_agent: string | null }

/** PostgreSQL persistence owned by the Identity Access capability. */
export class PostgresIdentityAccessRepositories implements PasswordAuthRepository, AccountRegistrationRepository,
  MemberLocalizationRepository, WorkspaceProjectRepository, OidcAuthRepository {
  constructor(
    private readonly kernel: PostgresKernel,
    private readonly secrets: AuthenticationSecretCodec,
    private readonly dependencies: {
      prepareRegistration(client: PostgresQueryable): Promise<void>;
      recordWorkspaceProjection(client: PostgresQueryable, record: RegistrationRecord): Promise<void>;
      recordProjection(client: PostgresQueryable, kind: "Workspace" | "Project", id: string,
        schema: "stash.workspace.v1" | "stash.project.v1", payload: object): Promise<void>;
      authorizeProject(client: PostgresQueryable, memberId: string, workspaceId: string): Promise<{ found: boolean; allowed: boolean }>;
      ensureDefaultWorkflow(client: PostgresQueryable, projectId: string): Promise<void>;
      findPortableMemberIdentity(memberId: string): Promise<PortableIdentity | undefined>;
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

  async findMemberLocalizationPreferences(memberId: string): Promise<MemberLocalizationPreferences | undefined> {
    return this.kernel.withSession(async (client) => { await this.prepareLocalization(client);
      const row = (await client.query<{locale:string;time_zone:string;date_format:MemberLocalizationPreferences["dateFormat"];
        week_starts_on:MemberLocalizationPreferences["weekStartsOn"];updated_at:Date|string}>(`SELECT locale,time_zone,date_format,week_starts_on,updated_at
        FROM stash_member_localization_preferences WHERE account_id=$1`, [memberId])).rows[0];
      return row ? { locale:row.locale,timeZone:row.time_zone,dateFormat:row.date_format,weekStartsOn:row.week_starts_on,
        updatedAt:new Date(row.updated_at).toISOString() } : undefined; });
  }

  async saveMemberLocalizationPreferences(memberId: string, preferences: MemberLocalizationPreferences): Promise<void> {
    await this.kernel.withSession(async (client) => { await this.prepareLocalization(client); await client.query(`INSERT INTO stash_member_localization_preferences
      (account_id,locale,time_zone,date_format,week_starts_on,updated_at) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(account_id) DO UPDATE SET locale=EXCLUDED.locale,time_zone=EXCLUDED.time_zone,date_format=EXCLUDED.date_format,
      week_starts_on=EXCLUDED.week_starts_on,updated_at=EXCLUDED.updated_at`, [memberId,preferences.locale,preferences.timeZone,preferences.dateFormat,
      preferences.weekStartsOn,preferences.updatedAt]); });
  }

  async createWorkspace(record: WorkspaceRecord, createdBy: PortableIdentity): Promise<
    {status:"created";projection:PortableWorkspaceProjection}|{status:"organization_forbidden"}> {
    return this.kernel.transaction(async (client) => { await this.prepareWorkspaceProjects(client); let owner:PortableWorkspaceProjection["owner"];
      if (record.owner.type === "organization") { const organization=(await client.query<{id:string;name:string}>(`SELECT organization.id,organization.name
        FROM stash_organization_memberships membership JOIN stash_organizations organization ON organization.id=membership.organization_id
        WHERE membership.organization_id=$1 AND membership.account_id=$2`,[record.owner.id,record.createdByMemberId])).rows[0];
        if(!organization)return {status:"organization_forbidden" as const}; owner={type:"organization",identity:{localOrganizationId:organization.id,displayName:organization.name}};
      } else owner={type:"personal",identity:createdBy};
      const projection:PortableWorkspaceProjection={schema:"stash.workspace.v1",id:record.id,name:record.name,owner,createdBy};
      await client.query(`INSERT INTO stash_workspaces(id,name,owner_type,personal_owner_id,organization_owner_id,created_by_account_id)
        VALUES($1,$2,$3,$4,$5,$6)`,[record.id,record.name,record.owner.type,record.owner.type==="personal"?record.owner.id:null,
        record.owner.type==="organization"?record.owner.id:null,record.createdByMemberId]);
      await this.dependencies.recordProjection(client,"Workspace",record.id,projection.schema,projection); return {status:"created" as const,projection}; });
  }

  async listAccessibleWorkspaces(memberId:string){return this.kernel.withSession(async(client)=>{await this.prepareWorkspaceProjects(client);
    const result=await client.query<{workspace_id:string;workspace_name:string;owner_type:"personal"|"organization";project_id:string|null;project_name:string|null;project_key:string|null}>(`
      SELECT workspace.id workspace_id,workspace.name workspace_name,workspace.owner_type,project.id project_id,project.name project_name,project.project_key
      FROM stash_workspaces workspace LEFT JOIN stash_projects project ON project.workspace_id=workspace.id AND
      ((workspace.owner_type='personal' AND workspace.personal_owner_id=$1) OR (workspace.owner_type='organization' AND EXISTS(SELECT 1 FROM stash_organization_memberships membership
      WHERE membership.organization_id=workspace.organization_owner_id AND membership.account_id=$1)) OR EXISTS(SELECT 1 FROM stash_project_guests guest WHERE guest.project_id=project.id AND guest.account_id=$1))
      WHERE (workspace.owner_type='personal' AND workspace.personal_owner_id=$1) OR (workspace.owner_type='organization' AND EXISTS(SELECT 1 FROM stash_organization_memberships membership
      WHERE membership.organization_id=workspace.organization_owner_id AND membership.account_id=$1)) OR EXISTS(SELECT 1 FROM stash_projects visible JOIN stash_project_guests guest
      ON guest.project_id=visible.id WHERE visible.workspace_id=workspace.id AND guest.account_id=$1) ORDER BY workspace.name,project.name`,[memberId]);
    const output=new Map<string,{id:string;name:string;ownerType:"personal"|"organization";projects:Array<{id:string;name:string;key:string}>}>();
    for(const row of result.rows){const workspace=output.get(row.workspace_id)??{id:row.workspace_id,name:row.workspace_name,ownerType:row.owner_type,projects:[]};
      if(row.project_id)workspace.projects.push({id:row.project_id,name:row.project_name!,key:row.project_key!});output.set(row.workspace_id,workspace);}return [...output.values()];});}

  async canCreateProject(memberId:string,workspaceId:string):Promise<boolean>{return this.kernel.withSession(async(client)=>{await this.prepareWorkspaceProjects(client);
    return (await this.dependencies.authorizeProject(client,memberId,workspaceId)).allowed;});}

  async createProject(memberId:string,record:WorkspaceProjectRecord,projection:PortableProjectProjection):Promise<"created"|"workspace_forbidden"|"workspace_not_found"|"key_conflict">{
    return this.kernel.transaction(async(client)=>{await this.prepareWorkspaceProjects(client);const access=await this.dependencies.authorizeProject(client,memberId,record.workspaceId);
      if(!access.found)return "workspace_not_found";if(!access.allowed)return "workspace_forbidden";const inserted=await client.query(`INSERT INTO stash_projects
      (id,workspace_id,name,project_key,created_by_account_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(workspace_id,project_key) DO NOTHING RETURNING id`,
      [record.id,record.workspaceId,record.name,record.key,record.createdByMemberId]);if(!inserted.rowCount)return "key_conflict";
      await this.dependencies.recordProjection(client,"Project",record.id,projection.schema,projection);await this.dependencies.ensureDefaultWorkflow(client,record.id);return "created";});}

  async readProject(accountId:string,projectId:string){return this.kernel.withSession(async(client)=>{await this.prepareWorkspaceProjects(client);
    const row=(await client.query<{id:string;organization_id:string;name:string;project_key:string;creator_id:string;creator_name:string}>(`SELECT project.id,workspace.organization_owner_id organization_id,
      project.name,project.project_key,creator.id creator_id,creator.name creator_name FROM stash_projects project JOIN stash_workspaces workspace ON workspace.id=project.workspace_id
      JOIN stash_accounts creator ON creator.id=project.created_by_account_id WHERE project.id=$1 AND (EXISTS(SELECT 1 FROM stash_organization_memberships membership
      WHERE membership.organization_id=workspace.organization_owner_id AND membership.account_id=$2) OR EXISTS(SELECT 1 FROM stash_project_guests guest WHERE guest.project_id=project.id AND guest.account_id=$2))`,[projectId,accountId])).rows[0];
    return row?{id:row.id,organizationId:row.organization_id,name:row.name,key:row.project_key,createdBy:{localAccountId:row.creator_id,displayName:row.creator_name}}:undefined;});}

  async canWriteProject(accountId:string,projectId:string):Promise<boolean>{return this.kernel.withSession(async(client)=>{await this.prepareWorkspaceProjects(client);
    return (await client.query(`SELECT 1 FROM stash_projects project JOIN stash_workspaces workspace ON workspace.id=project.workspace_id
      JOIN stash_organization_memberships membership ON membership.organization_id=workspace.organization_owner_id WHERE project.id=$1 AND membership.account_id=$2`,[projectId,accountId])).rowCount===1;});}

  findPortableMemberIdentity(memberId: string): Promise<PortableIdentity | undefined> {
    return this.dependencies.findPortableMemberIdentity(memberId);
  }

  async findOidcIdentity(key: OidcIdentityKey): Promise<OidcIdentityRecord | undefined> {
    await this.prepareOidc();
    const result = await this.kernel.query<{ id:string;name:string;email:string;subject_secret:string }>(`
      SELECT account.id,account.name,account.email,identity.subject_secret FROM stash_oidc_identities identity
      JOIN stash_accounts account ON account.id=identity.account_id
      JOIN stash_organization_memberships membership ON membership.account_id=account.id AND membership.organization_id=identity.organization_id
      WHERE identity.organization_id=$1 AND identity.issuer=$2 AND identity.subject_lookup=$3`,
    [key.organizationId,key.issuer,this.oidcIdentityLookup(key)]);
    const row=result.rows[0];
    if(!row||this.secrets.decrypt(row.subject_secret)!==key.subject)return undefined;
    return {accountId:row.id,name:row.name,email:row.email};
  }

  async organizationRole(organizationId:string,accountId:string):Promise<BuiltInOrganizationRole|undefined>{
    return (await this.kernel.query<{role:BuiltInOrganizationRole}>(
      "SELECT role FROM stash_organization_memberships WHERE organization_id=$1 AND account_id=$2",[organizationId,accountId])).rows[0]?.role;
  }

  async findOidcConfiguration(organizationId:string):Promise<OidcOrganizationConfiguration|undefined>{
    await this.prepareOidc();const row=(await this.kernel.query<{organization_id:string;issuer:string;client_id:string;client_secret:string}>(
      "SELECT organization_id,issuer,client_id,client_secret FROM stash_oidc_configurations WHERE organization_id=$1",[organizationId])).rows[0];
    return row?{organizationId:row.organization_id,issuer:row.issuer,clientId:row.client_id,clientSecret:this.secrets.decrypt(row.client_secret)}:undefined;
  }

  async saveOidcConfiguration(configuration:OidcOrganizationConfiguration):Promise<void>{await this.prepareOidc();await this.kernel.query(`
    INSERT INTO stash_oidc_configurations(organization_id,issuer,client_id,client_secret) VALUES($1,$2,$3,$4)
    ON CONFLICT(organization_id) DO UPDATE SET issuer=EXCLUDED.issuer,client_id=EXCLUDED.client_id,client_secret=EXCLUDED.client_secret`,
  [configuration.organizationId,configuration.issuer,configuration.clientId,this.secrets.encrypt(configuration.clientSecret)]);}

  async linkOidcIdentity(key:OidcIdentityKey,accountId:string):Promise<boolean>{await this.prepareOidc();const result=await this.kernel.query(`
    INSERT INTO stash_oidc_identities(organization_id,issuer,subject_lookup,subject_secret,account_id)
    SELECT $1,$3,$4,$5,account_id FROM stash_organization_memberships WHERE organization_id=$1 AND account_id=$2
    ON CONFLICT(organization_id,issuer,account_id) DO UPDATE SET subject_lookup=EXCLUDED.subject_lookup,subject_secret=EXCLUDED.subject_secret`,
  [key.organizationId,accountId,key.issuer,this.oidcIdentityLookup(key),this.secrets.encrypt(key.subject)]);return result.rowCount===1;}

  async prepareOidc(client:PostgresQueryable=this.kernel):Promise<void>{await this.dependencies.prepareRegistration(client);await client.query(`
    CREATE TABLE IF NOT EXISTS stash_oidc_configurations(organization_id UUID PRIMARY KEY REFERENCES stash_organizations(id) ON DELETE CASCADE,
      issuer TEXT NOT NULL,client_id TEXT NOT NULL,client_secret TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS stash_oidc_identities(organization_id UUID NOT NULL REFERENCES stash_organizations(id) ON DELETE CASCADE,
      issuer TEXT NOT NULL,subject_lookup TEXT NOT NULL,subject_secret TEXT NOT NULL,account_id UUID NOT NULL REFERENCES stash_accounts(id) ON DELETE CASCADE,
      PRIMARY KEY(organization_id,issuer,subject_lookup),UNIQUE(organization_id,issuer,account_id))`);}

  private oidcIdentityLookup(key:OidcIdentityKey):string{return this.secrets.blindIndex(
    `oidc-identity-v1:${JSON.stringify([key.organizationId,key.issuer,key.subject])}`);}

  async prepareWorkspaceProjects(client:PostgresQueryable):Promise<void>{await this.dependencies.prepareRegistration(client);}
  async prepareLocalization(client:PostgresQueryable):Promise<void>{await this.prepareWorkspaceProjects(client);await client.query(`CREATE TABLE IF NOT EXISTS stash_member_localization_preferences
    (account_id UUID PRIMARY KEY REFERENCES stash_accounts(id) ON DELETE CASCADE,locale TEXT NOT NULL,time_zone TEXT NOT NULL,date_format TEXT NOT NULL CHECK(date_format IN ('short','medium','long')),
    week_starts_on TEXT NOT NULL CHECK(week_starts_on IN ('sunday','monday','saturday')),updated_at TIMESTAMPTZ NOT NULL)`);}

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

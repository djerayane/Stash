import type { DevelopmentArtifact, GitHubArtifactRepository } from "../github-artifacts.js";
import type { GitHubSignalRepository } from "../github-signals.js";
import type { RepositoryConnectionRecord, RepositoryConnectionRepository } from "../repository-connections.js";
import type { BuiltInOrganizationRole } from "../organization-roles.js";
import type { PostgresKernel, PostgresQueryable } from "../instance-operations/storage/postgres-kernel.js";

export type DevelopmentIntegrationPostgresRepositories = RepositoryConnectionRepository
  & GitHubArtifactRepository & GitHubSignalRepository;

export class PostgresDevelopmentIntegrationRepositories implements DevelopmentIntegrationPostgresRepositories {
  constructor(
    private readonly kernel: PostgresKernel,
    private readonly dependencies: {
      organizationRole(organizationId: string, accountId: string): Promise<BuiltInOrganizationRole | undefined>;
      prepareConnections(client?: PostgresQueryable): Promise<void>;
      lockedMemberships(client: PostgresQueryable, organizationId: string): Promise<ReadonlyArray<{ account_id: string; role: string }>>;
      recordConnectionProjection(client: PostgresQueryable, record: import("../repository-connections.js").RepositoryConnectionRecord,
        revision: number): Promise<void>;
      prepareSignals(client?: PostgresQueryable): Promise<void>;
      resolveTask(memberId: string, projectId: string, taskKey: string): Promise<{
        status: string;
        task?: { id: string; key: string; title: string; developmentLinks?: Array<{ url: string }> };
      }>;
      linkArtifact(memberId: string, projectId: string, taskKey: string, artifact: DevelopmentArtifact): Promise<"linked" | "forbidden">;
      linkSignalArtifact(client: PostgresQueryable, taskId: string, signal: import("../github-signals.js").GitHubSignal,
        confirmingMemberId?: string, organizationId?: string): Promise<void>;
    },
  ) {}

  organizationRole(...args: Parameters<RepositoryConnectionRepository["organizationRole"]>) { return this.dependencies.organizationRole(...args); }
  async createRepositoryConnection(actorId: string, record: import("../repository-connections.js").RepositoryConnectionRecord) {
    await this.dependencies.prepareConnections();
    return this.kernel.transaction(async (client) => {
      const memberships = await this.dependencies.lockedMemberships(client, record.organizationId);
      if (!memberships.some((entry) => entry.account_id === actorId && (entry.role === "Owner" || entry.role === "Admin")))
        return { status: "forbidden" as const };
      const existing = await client.query<any>(`${repositoryConnectionSelect} WHERE organization_id=$1 AND repository_id=$2 FOR UPDATE`,
        [record.organizationId,record.repositoryId]);
      if (existing.rows[0]) return { status:"existing" as const, record:connectionFromRow(existing.rows[0]) };
      await client.query(`INSERT INTO stash_repository_connections
        (id,organization_id,provider,installation_id,repository_id,repository_url,created_by_account_id,created_by_attribution,ownership,state)
        VALUES($1,$2,$3,$4,$5,$6,$7,'recorded',$8,'active')`, [record.id,record.organizationId,record.provider,record.installationId,
        record.repositoryId,record.repositoryUrl,actorId,record.ownership ?? "organization"]);
      await this.dependencies.recordConnectionProjection(client,record,1);
      return { status:"created" as const, record };
    });
  }
  async findRepositoryConnectionById(organizationId: string, connectionId: string) {
    await this.dependencies.prepareConnections();
    const result = await this.kernel.query<any>(`${repositoryConnectionSelect} WHERE organization_id=$1 AND connection.id=$2`, [organizationId, connectionId]);
    return result.rows[0] ? connectionFromRow(result.rows[0]) : undefined;
  }
  async listRepositoryConnections(organizationId: string) {
    await this.dependencies.prepareConnections();
    const result = await this.kernel.query<any>(`${repositoryConnectionSelect} WHERE organization_id=$1 ORDER BY repository_url,id`, [organizationId]);
    return result.rows.map(connectionFromRow);
  }
  async attachRepositoryConnectionToProject(actorId: string, organizationId: string, connectionId: string, projectId: string) {
    await this.dependencies.prepareConnections();
    return this.kernel.transaction(async (client) => {
      const memberships = await this.dependencies.lockedMemberships(client, organizationId);
      if (!canManageConnections(memberships, actorId)) return "forbidden" as const;
      const inserted = await client.query(`INSERT INTO stash_repository_connection_projects(connection_id,project_id)
        SELECT connection.id,project.id FROM stash_repository_connections connection JOIN stash_projects project ON project.id=$3
        JOIN stash_workspaces workspace ON workspace.id=project.workspace_id WHERE connection.id=$2 AND connection.organization_id=$1
        AND connection.state='active' AND workspace.owner_type='organization' AND workspace.organization_owner_id=$1 ON CONFLICT DO NOTHING`,
      [organizationId,connectionId,projectId]);
      if (!inserted.rowCount) { const existing=await client.query(`SELECT 1 FROM stash_repository_connection_projects link
        JOIN stash_repository_connections connection ON connection.id=link.connection_id WHERE connection.organization_id=$1
        AND connection.state='active' AND link.connection_id=$2 AND link.project_id=$3`,[organizationId,connectionId,projectId]);
        if (!existing.rowCount) return "not_found" as const; }
      const refreshed=await client.query<any>(`${repositoryConnectionSelect} WHERE connection.organization_id=$1 AND connection.id=$2`,[organizationId,connectionId]);
      await this.dependencies.recordConnectionProjection(client,connectionFromRow(refreshed.rows[0]),await nextConnectionRevision(client,connectionId));
      return "attached" as const;
    });
  }
  async replaceDegradedRepositoryConnection(actorId: string, organizationId: string, connectionId: string,
    replacement: import("../repository-connections.js").GitHubRepositoryIdentity) {
    await this.dependencies.prepareConnections();
    return this.kernel.transaction(async (client) => {
      const memberships=await this.dependencies.lockedMemberships(client,organizationId);
      if(!canManageConnections(memberships,actorId)) return "forbidden" as const;
      const repaired=await client.query<any>(`${repositoryConnectionSelect} WHERE connection.organization_id=$1 AND connection.id=$2 AND connection.state='degraded' FOR UPDATE`,[organizationId,connectionId]);
      if(!repaired.rows[0]) return "not_found" as const;
      await client.query(`UPDATE stash_repository_connections SET installation_id=$2,repository_id=$3,repository_url=$4,
        created_by_account_id=$5,created_by_attribution='recorded',ownership='organization',state='active' WHERE id=$1`,
      [connectionId,replacement.installationId,replacement.repositoryId,replacement.repositoryUrl,actorId]);
      const refreshed={...connectionFromRow(repaired.rows[0]),...replacement,createdByMemberId:actorId,createdByAttribution:"recorded" as const,ownership:"organization" as const,state:"active" as const};
      await this.dependencies.recordConnectionProjection(client,refreshed,await nextConnectionRevision(client,connectionId));
      return "repaired" as const;
    });
  }

  async listConnections(memberId: string, projectId: string) {
    await this.dependencies.prepareConnections();
    const result=await this.kernel.query<any>(`SELECT connection.id,connection.repository_url FROM stash_repository_connections connection
      JOIN stash_repository_connection_projects selected ON selected.connection_id=connection.id AND selected.project_id=$1
      JOIN stash_projects project ON project.id=selected.project_id JOIN stash_workspaces workspace ON workspace.id=project.workspace_id
      WHERE connection.state='active' AND ((workspace.owner_type='personal' AND workspace.personal_owner_id=$2) OR
      (workspace.owner_type='organization' AND EXISTS(SELECT 1 FROM stash_organization_memberships membership
      WHERE membership.organization_id=workspace.organization_owner_id AND membership.account_id=$2))) ORDER BY connection.repository_url`,[projectId,memberId]);
    return result.rows.map((row:any)=>({id:row.id,repositoryUrl:row.repository_url}));
  }
  async resolveTask(memberId: string, projectId: string, taskKey: string) { const result=await this.dependencies.resolveTask(memberId,projectId,taskKey);
    return result.status==="found"&&result.task?{id:result.task.id,key:result.task.key,title:result.task.title}:undefined; }
  async resolveConnection(memberId: string, projectId: string, connectionId: string) {
    await this.dependencies.prepareConnections();
    const result=await this.kernel.query<any>(`${repositoryConnectionSelect} JOIN stash_repository_connection_projects selected
      ON selected.connection_id=connection.id AND selected.project_id=$2 JOIN stash_projects project ON project.id=selected.project_id
      JOIN stash_workspaces workspace ON workspace.id=project.workspace_id WHERE connection.id=$1 AND connection.state='active' AND
      ((workspace.owner_type='personal' AND workspace.personal_owner_id=$3) OR (workspace.owner_type='organization' AND EXISTS
      (SELECT 1 FROM stash_organization_memberships membership WHERE membership.organization_id=workspace.organization_owner_id AND membership.account_id=$3)))`,[connectionId,projectId,memberId]);
    const row=result.rows[0]; return row?{installationId:Number(row.installation_id),repositoryId:row.repository_id,repositoryUrl:row.repository_url}:undefined;
  }
  async canLinkArtifact(memberId: string, projectId: string, taskKey: string) { return (await this.dependencies.resolveTask(memberId,projectId,taskKey)).status==="found"; }
  linkArtifact(...args: Parameters<GitHubArtifactRepository["linkArtifact"]>) { return this.dependencies.linkArtifact(...args); }
  async listArtifacts(memberId: string, projectId: string, taskKey: string) { const result=await this.dependencies.resolveTask(memberId,projectId,taskKey);
    if(result.status!=="found"||!result.task) return undefined; return (result.task.developmentLinks??[]).flatMap(({url})=>developmentArtifactFromUrl(url)); }

  async matchingTasks(installationId: number, repositoryId: string, keys: string[]) {
    await this.dependencies.prepareSignals();
    if (!keys.length) return [];
    const result = await this.kernel.query<any>(`SELECT DISTINCT task.id AS task_id, link.project_id, connection.organization_id,
      identity.task_key, task.title, identity.matched_key FROM stash_repository_connections connection
      JOIN stash_repository_connection_projects link ON link.connection_id=connection.id
      JOIN LATERAL (SELECT association.task_id,association.task_key,association.task_key matched_key FROM stash_task_projects association
        WHERE association.project_id=link.project_id AND association.task_key=ANY($3::text[])
        UNION SELECT alias.task_id,alias.task_key,alias.task_key FROM stash_task_key_aliases alias
        WHERE alias.project_id=link.project_id AND alias.task_key=ANY($3::text[])) identity ON TRUE
      JOIN stash_tasks task ON task.id=identity.task_id WHERE connection.provider='github' AND connection.state='active'
        AND connection.installation_id=$1 AND connection.repository_id=$2`, [installationId, repositoryId, keys]);
    return result.rows.map((row: any) => ({ taskId: row.task_id, projectId: row.project_id, organizationId: row.organization_id,
      taskKey: row.task_key, title: row.title, matchedKey: row.matched_key }));
  }

  async receive(signal: import("../github-signals.js").GitHubSignal, candidates: import("../github-signals.js").SignalCandidate[]) {
    await this.dependencies.prepareSignals();
    await this.kernel.transaction(async (client) => {
      const inserted = await client.query(`INSERT INTO stash_github_signals
        (id,delivery_id,installation_id,repository_id,kind,provider_id,url,label,occurred_at,automation_trigger)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(delivery_id) DO NOTHING`,
      [signal.id,signal.deliveryId,signal.installationId,signal.repositoryId,signal.kind,signal.providerId,signal.url,signal.label,signal.occurredAt,signal.trigger ?? null]);
      if (!inserted.rowCount) return;
      for (const candidate of candidates) {
        await client.query(`INSERT INTO stash_github_signal_suggestions
          (id,signal_id,task_id,project_id,organization_id,task_key,task_title,matched_key,status)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [candidate.id,signal.id,candidate.taskId,candidate.projectId,candidate.organizationId,candidate.taskKey,candidate.taskTitle,candidate.matchedKey,candidate.status]);
        if (candidate.status === "confirmed") await this.dependencies.linkSignalArtifact(client,candidate.taskId,signal,undefined,candidate.organizationId);
      }
    });
  }

  async list(memberId: string, projectId: string, taskKey: string) {
    await this.dependencies.prepareSignals();
    const visible = await this.dependencies.resolveTask(memberId, projectId, taskKey);
    if (visible.status !== "found" || !visible.task) return undefined;
    const result = await this.kernel.query<any>(`SELECT signal.*,suggestion.id suggestion_id,suggestion.task_id,suggestion.project_id,
      suggestion.organization_id,suggestion.task_key,suggestion.task_title,suggestion.matched_key,suggestion.status
      FROM stash_github_signal_suggestions suggestion JOIN stash_github_signals signal ON signal.id=suggestion.signal_id
      WHERE suggestion.task_id=$1 ORDER BY signal.occurred_at DESC,suggestion.id`, [visible.task.id]);
    const grouped = new Map<string,{signal: import("../github-signals.js").GitHubSignal;suggestions: import("../github-signals.js").SignalCandidate[]}>();
    for (const row of result.rows) { const entry = grouped.get(row.id) ?? { signal: signalFromRow(row), suggestions: [] };
      entry.suggestions.push({ id:row.suggestion_id,signalId:row.id,taskId:row.task_id,projectId:row.project_id,organizationId:row.organization_id,taskKey:row.task_key,taskTitle:row.task_title,matchedKey:row.matched_key,status:row.status }); grouped.set(row.id,entry); }
    return [...grouped.values()];
  }

  async confirm(memberId: string, projectId: string, taskKey: string, suggestionId: string) {
    await this.dependencies.prepareSignals();
    if ((await this.dependencies.resolveTask(memberId,projectId,taskKey)).status !== "found") return "forbidden" as const;
    return this.kernel.transaction(async (client) => { const result = await client.query<any>(`SELECT suggestion.*,signal.kind,signal.provider_id,
      signal.url,signal.label,signal.delivery_id,signal.repository_id,signal.occurred_at,signal.automation_trigger
      FROM stash_github_signal_suggestions suggestion JOIN stash_github_signals signal ON signal.id=suggestion.signal_id
      JOIN stash_tasks task ON task.id=suggestion.task_id WHERE suggestion.id=$1 AND suggestion.project_id=$2 AND (suggestion.task_key=$3
        OR EXISTS(SELECT 1 FROM stash_task_projects a WHERE a.task_id=task.id AND a.project_id=$2 AND a.task_key=$3)
        OR EXISTS(SELECT 1 FROM stash_task_key_aliases a WHERE a.task_id=task.id AND a.project_id=$2 AND a.task_key=$3)) FOR UPDATE OF suggestion`, [suggestionId,projectId,taskKey]);
      const row=result.rows[0]; if(!row) return "not_found" as const;
      await client.query("UPDATE stash_github_signal_suggestions SET status='confirmed',confirmed_by_account_id=$2,confirmed_at=NOW() WHERE id=$1",[suggestionId,memberId]);
      await this.dependencies.linkSignalArtifact(client,row.task_id,signalFromRow(row),memberId); return "confirmed" as const; });
  }
}

function signalFromRow(row: any): import("../github-signals.js").GitHubSignal { return { id:row.id,deliveryId:row.delivery_id,
  installationId:Number(row.installation_id),repositoryId:row.repository_id,kind:row.kind,providerId:row.provider_id,url:row.url,
  label:row.label,occurredAt:new Date(row.occurred_at).toISOString(),...(row.automation_trigger?{trigger:row.automation_trigger}:{}) }; }

const repositoryConnectionSelect = `SELECT connection.id,connection.organization_id,connection.provider,connection.installation_id,
  connection.repository_id,connection.repository_url,connection.created_by_account_id,connection.created_by_attribution,connection.ownership,connection.state,
  ARRAY(SELECT project_id FROM stash_repository_connection_projects link WHERE link.connection_id=connection.id ORDER BY project_id) project_ids
  FROM stash_repository_connections connection`;
function connectionFromRow(row:any): import("../repository-connections.js").RepositoryConnectionRecord { return { id:row.id,
  organizationId:row.organization_id,provider:row.provider,installationId:Number(row.installation_id),repositoryId:row.repository_id,
  repositoryUrl:row.repository_url,createdByMemberId:row.created_by_account_id,createdByAttribution:row.created_by_attribution,
  projectIds:row.project_ids,ownership:row.ownership,state:row.state }; }
function canManageConnections(memberships: ReadonlyArray<{account_id:string;role:string}>, actorId:string) {
  return memberships.some((entry)=>entry.account_id===actorId&&(entry.role==="Owner"||entry.role==="Admin"));
}
async function nextConnectionRevision(client:PostgresQueryable,connectionId:string) { const result=await client.query<{revision:number}>(
  "SELECT COALESCE(MAX(revision),0)+1 AS revision FROM stash_portable_projection_outbox WHERE object_kind='RepositoryConnection' AND object_id=$1",[connectionId]);
  return Number(result.rows[0]!.revision); }
function developmentArtifactFromUrl(value:string):DevelopmentArtifact[] { try { const url=new URL(value);
  if(url.protocol!=="https:"||url.hostname!=="github.com") return []; const match=url.pathname.match(/^\/[^/]+\/[^/]+\/(tree|commit|pull)\/(.+)$/);
  if(!match)return[]; const kind=match[1]==="tree"?"branch":match[1]==="commit"?"commit":"pull_request";
  const label=decodeURIComponent(match[2]!); return [{kind,providerId:label,url:value,label}]; } catch { return []; } }

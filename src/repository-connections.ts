import { randomUUID } from "node:crypto";
import type { BuiltInOrganizationRole } from "./organization-roles.js";

export interface RepositoryConnectionRecord { id: string; organizationId: string; provider: "github"; installationId: number; repositoryId: string; repositoryUrl: string; createdByMemberId: string; createdByAttribution: "recorded" | "inferred-during-upgrade"; projectIds: string[]; ownership?: "organization" | "personal"; state?: "active" | "degraded" }
export interface PortableRepositoryConnectionProjection { schema: "stash.repository-connection.v1"; id: string; provider: "github"; repositoryUrl: string; organization: { localOrganizationId: string; displayName: string }; createdBy: { localAccountId: string; displayName: string; attribution: "recorded" | "inferred-during-upgrade" }; projectIds: string[]; ownership?: "organization" | "personal"; state?: "active" | "degraded" }
type WriteResult = { status: "created" | "existing"; record: RepositoryConnectionRecord } | { status: "forbidden" };
export interface RepositoryConnectionRepository {
  organizationRole(organizationId: string, accountId: string): Promise<BuiltInOrganizationRole | undefined>;
  createRepositoryConnection(actorId: string, record: RepositoryConnectionRecord): Promise<WriteResult>;
  findRepositoryConnectionById(organizationId: string, connectionId: string): Promise<RepositoryConnectionRecord | undefined>;
  listRepositoryConnections(organizationId: string): Promise<RepositoryConnectionRecord[]>;
  attachRepositoryConnectionToProject(actorId: string, organizationId: string, connectionId: string, projectId: string): Promise<"attached" | "not_found" | "forbidden">;
  replaceDegradedRepositoryConnection?(actorId: string, organizationId: string, connectionId: string,
    replacement: GitHubRepositoryIdentity): Promise<"repaired" | "not_found" | "forbidden">;
}
export interface GitHubRepositorySelection { installationId: number; owner: string; name: string }
export interface GitHubRepositoryIdentity { installationId: number; repositoryId: string; repositoryUrl: string }
export interface GitHubApp { inspectRepository(input: GitHubRepositorySelection): Promise<GitHubRepositoryIdentity>; verifyRepository(input: GitHubRepositoryIdentity): Promise<void> }
export interface RepositoryConnectionProjection { id: string; organizationId: string; provider: "github"; repositoryId: string; repositoryUrl: string; projectIds: string[] }
export class InvalidRepositoryConnectionInput extends Error {}
export class GitHubRepositoryUnavailable extends Error {}
export class RepositoryConnectionWriteForbidden extends Error {}

export class RepositoryConnectionService {
  constructor(readonly repository: RepositoryConnectionRepository, readonly github: GitHubApp) {}
  async authorize(organizationId: string, accountId: string): Promise<boolean> { if (!isUuid(organizationId)) throw new InvalidRepositoryConnectionInput(); const role = await this.repository.organizationRole(organizationId, accountId); return role === "Owner" || role === "Admin"; }
  async connect(actorId: string, organizationId: string, value: unknown): Promise<{ created: boolean; connection: RepositoryConnectionProjection }> {
    if (!isInput(value)) throw new InvalidRepositoryConnectionInput();
    let inspected: GitHubRepositoryIdentity;
    try { inspected = await this.github.inspectRepository(value); } catch { throw new GitHubRepositoryUnavailable(); }
    if (!inspected.repositoryId || !isSafeGitHubUrl(inspected.repositoryUrl) || inspected.installationId !== value.installationId) throw new GitHubRepositoryUnavailable();
    const result = await this.repository.createRepositoryConnection(actorId, { id: randomUUID(), organizationId, provider: "github", ...inspected, createdByMemberId: actorId, createdByAttribution: "recorded", projectIds: [], ownership: value.ownership ?? "organization", state: "active" });
    if (result.status === "forbidden") throw new RepositoryConnectionWriteForbidden();
    return { created: result.status === "created", connection: project(result.record) };
  }
  async list(organizationId: string) { return (await this.repository.listRepositoryConnections(organizationId)).map(project); }
  async attachToProject(actorId: string, organizationId: string, connectionId: string, projectId: string) { if (!isUuid(connectionId) || !isUuid(projectId)) throw new InvalidRepositoryConnectionInput(); return this.repository.attachRepositoryConnectionToProject(actorId, organizationId, connectionId, projectId); }
  async repair(actorId: string, organizationId: string, connectionId: string, value: unknown) {
    if (!isUuid(connectionId) || !this.repository.replaceDegradedRepositoryConnection || !isReplacementInput(value))
      throw new InvalidRepositoryConnectionInput();
    const current = await this.repository.findRepositoryConnectionById(organizationId, connectionId);
    if (!current || current.state !== "degraded") return "not_found" as const;
    let replacement: GitHubRepositoryIdentity;
    try {
      replacement = await this.github.inspectRepository(value);
      if (!replacement.repositoryId || !isSafeGitHubUrl(replacement.repositoryUrl)
        || replacement.installationId !== value.installationId) throw new GitHubRepositoryUnavailable();
      if (replacement.repositoryId !== current.repositoryId || replacement.repositoryUrl !== current.repositoryUrl)
        throw new InvalidRepositoryConnectionInput();
      await this.github.verifyRepository(replacement);
    } catch (error) {
      if (error instanceof GitHubRepositoryUnavailable || error instanceof InvalidRepositoryConnectionInput) throw error;
      throw new GitHubRepositoryUnavailable();
    }
    return this.repository.replaceDegradedRepositoryConnection(actorId, organizationId, connectionId, replacement);
  }
  async verify(organizationId: string, connectionId: string): Promise<void> { if (!isUuid(connectionId)) throw new InvalidRepositoryConnectionInput(); const record = await this.repository.findRepositoryConnectionById(organizationId, connectionId); if (!record || record.state === "degraded") throw new InvalidRepositoryConnectionInput(); try { await this.github.verifyRepository(record); } catch { throw new GitHubRepositoryUnavailable(); } }
}
function project(record: RepositoryConnectionRecord): RepositoryConnectionProjection & { ownership: "organization" | "personal"; state: "active" | "degraded" } { return { id: record.id, organizationId: record.organizationId, provider: record.provider, repositoryId: record.repositoryId, repositoryUrl: record.repositoryUrl, projectIds: [...record.projectIds], ownership: record.ownership ?? "organization", state: record.state ?? "active" }; }
function isInput(value: unknown): value is GitHubRepositorySelection & { ownership?: "organization" | "personal" } { if (!value || typeof value !== "object" || Array.isArray(value)) return false; const input = value as Record<string, unknown>; return Object.keys(input).every((key) => ["installationId","owner","name","ownership"].includes(key)) && Object.keys(input).length >= 3 && Number.isSafeInteger(input.installationId) && (input.installationId as number) > 0 && typeof input.owner === "string" && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(input.owner) && typeof input.name === "string" && input.name.length > 0 && input.name.length <= 100 && !/[\s/]/.test(input.name) && (input.ownership === undefined || input.ownership === "organization" || input.ownership === "personal"); }
function isReplacementInput(value: unknown): value is GitHubRepositorySelection {
  return isInput(value) && Object.keys(value).length === 3 && !("ownership" in value);
}
function isUuid(value: string) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function isSafeGitHubUrl(value: string) { try { const url = new URL(value); return url.protocol === "https:" && url.hostname === "github.com" && !url.username && !url.password; } catch { return false; } }

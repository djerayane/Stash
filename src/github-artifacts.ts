export type DevelopmentArtifactKind = "branch" | "commit" | "pull_request";
export interface DevelopmentArtifact { kind: DevelopmentArtifactKind; providerId: string; url: string; label: string }
export interface GitHubArtifactRepositoryIdentity { installationId: number; repositoryId: string; repositoryUrl: string }
export interface GitHubArtifactRepository {
  listConnections?(memberId: string, projectId: string): Promise<Array<{ id: string; repositoryUrl: string }>>;
  resolveTask(memberId: string, projectId: string, taskKey: string): Promise<{ id: string; key: string; title: string } | undefined>;
  resolveConnection(memberId: string, projectId: string, connectionId: string): Promise<GitHubArtifactRepositoryIdentity | undefined>;
  canLinkArtifact(memberId: string, projectId: string, taskKey: string): Promise<boolean>;
  linkArtifact(memberId: string, projectId: string, taskKey: string, artifact: DevelopmentArtifact): Promise<"linked" | "forbidden">;
  listArtifacts(memberId: string, projectId: string, taskKey: string): Promise<DevelopmentArtifact[] | undefined>;
}
export interface GitHubArtifactProvider {
  createBranch(repository: GitHubArtifactRepositoryIdentity, name: string): Promise<DevelopmentArtifact>;
  inspectArtifact(repository: GitHubArtifactRepositoryIdentity, kind: DevelopmentArtifactKind, reference: string): Promise<DevelopmentArtifact>;
}
export class InvalidGitHubArtifactInput extends Error {}
export class GitHubArtifactUnavailable extends Error {}
export class GitHubArtifactNotFound extends Error {}
export class GitHubArtifactWriteForbidden extends Error {}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const taskKeyPattern = /^[A-Z][A-Z0-9]{0,15}-[1-9][0-9]*$/;

export class GitHubArtifactService {
  constructor(private readonly repository: GitHubArtifactRepository, private readonly github: GitHubArtifactProvider) {}
  async createBranch(memberId: string, projectId: string, taskKey: string, value: unknown) {
    const input = parseCreate(value); const context = await this.context(memberId, projectId, taskKey, input.connectionId);
    await this.requireWrite(memberId, projectId, taskKey);
    const branchName = input.branchName ?? `${context.task.key.toLowerCase()}-${slug(context.task.title)}`.slice(0, 120).replace(/-+$/g, "");
    let artifact: DevelopmentArtifact;
    try { artifact = await this.github.createBranch(context.connection, branchName); } catch { throw new GitHubArtifactUnavailable(); }
    validateArtifact(artifact, "branch");
    await this.persist(memberId, projectId, taskKey.toUpperCase(), artifact);
    return artifact;
  }
  async link(memberId: string, projectId: string, taskKey: string, value: unknown) {
    const input = parseLink(value); const context = await this.context(memberId, projectId, taskKey, input.connectionId);
    await this.requireWrite(memberId, projectId, taskKey);
    let artifact: DevelopmentArtifact;
    try { artifact = await this.github.inspectArtifact(context.connection, input.kind, input.reference); } catch { throw new GitHubArtifactUnavailable(); }
    validateArtifact(artifact, input.kind);
    await this.persist(memberId, projectId, taskKey.toUpperCase(), artifact);
    return artifact;
  }
  async list(memberId: string, projectId: string, taskKey: string) {
    validatePath(projectId, taskKey); const task = await this.repository.resolveTask(memberId, projectId, taskKey.toUpperCase());
    if (!task) throw new GitHubArtifactNotFound();
    const artifacts = await this.repository.listArtifacts(memberId, projectId, taskKey.toUpperCase());
    if (!artifacts) throw new GitHubArtifactNotFound();
    return artifacts;
  }
  async listConnections(memberId: string, projectId: string) {
    if (!uuid.test(projectId)) throw new InvalidGitHubArtifactInput();
    return this.repository.listConnections?.(memberId, projectId) ?? [];
  }
  private async context(memberId: string, projectId: string, taskKey: string, connectionId: string) {
    validatePath(projectId, taskKey); if (!uuid.test(connectionId)) throw new InvalidGitHubArtifactInput();
    const [task, connection] = await Promise.all([this.repository.resolveTask(memberId, projectId, taskKey.toUpperCase()), this.repository.resolveConnection(memberId, projectId, connectionId)]);
    if (!task || !connection) throw new GitHubArtifactNotFound();
    return { task, connection };
  }
  private async persist(memberId: string, projectId: string, taskKey: string, artifact: DevelopmentArtifact) {
    if (await this.repository.linkArtifact(memberId, projectId, taskKey, artifact) === "forbidden") throw new GitHubArtifactWriteForbidden();
  }
  private async requireWrite(memberId: string, projectId: string, taskKey: string) {
    if (!await this.repository.canLinkArtifact(memberId, projectId, taskKey.toUpperCase())) throw new GitHubArtifactWriteForbidden();
  }
}
function validatePath(projectId: string, taskKey: string) { if (!uuid.test(projectId) || !taskKeyPattern.test(taskKey.toUpperCase())) throw new InvalidGitHubArtifactInput(); }
function parseCreate(value: unknown): { action: "create_branch"; connectionId: string; branchName?: string } {
  if (!record(value) || value.action !== "create_branch" || typeof value.connectionId !== "string") throw new InvalidGitHubArtifactInput();
  if (value.branchName !== undefined && (typeof value.branchName !== "string" || !validBranch(value.branchName))) throw new InvalidGitHubArtifactInput();
  return { action: "create_branch", connectionId: value.connectionId, ...(typeof value.branchName === "string" ? { branchName: value.branchName } : {}) };
}
function parseLink(value: unknown): { action: "link"; connectionId: string; kind: DevelopmentArtifactKind; reference: string } {
  if (!record(value) || value.action !== "link" || typeof value.connectionId !== "string" || !["branch", "commit", "pull_request"].includes(String(value.kind)) || typeof value.reference !== "string") throw new InvalidGitHubArtifactInput();
  const kind = value.kind as DevelopmentArtifactKind;
  if (kind === "branch" ? !validBranch(value.reference) : kind === "commit" ? !/^[0-9a-f]{7,64}$/i.test(value.reference) : !/^[1-9][0-9]*$/.test(value.reference)) throw new InvalidGitHubArtifactInput();
  return { action: "link", connectionId: value.connectionId, kind, reference: value.reference };
}
function record(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function validBranch(value: string) { return value.length > 0 && value.length <= 240 && !value.startsWith("/") && !value.endsWith("/") && !value.endsWith(".") && !/\.\.|[~^:?*\\\s]|@\{|\/\//.test(value); }
function slug(value: string) { return value.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "task"; }
function validateArtifact(artifact: DevelopmentArtifact, kind: DevelopmentArtifactKind) {
  let url: URL; try { url = new URL(artifact.url); } catch { throw new GitHubArtifactUnavailable(); }
  if (artifact.kind !== kind || !artifact.providerId || !artifact.label || url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password) throw new GitHubArtifactUnavailable();
}

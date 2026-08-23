import { createSign } from "node:crypto";
import type { GitHubApp, GitHubRepositoryIdentity, GitHubRepositorySelection } from "./repository-connections.js";
import type { DevelopmentArtifactKind, GitHubArtifactProvider, GitHubArtifactRepositoryIdentity } from "./github-artifacts.js";

export class GitHubAppClient implements GitHubApp, GitHubArtifactProvider {
  constructor(readonly appId: string, readonly privateKey: string, readonly request: typeof fetch = fetch) {
    if (!/^[1-9][0-9]*$/.test(appId) || !privateKey.includes("BEGIN") || !privateKey.includes("PRIVATE KEY")) {
      throw new Error("GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY must identify this Instance's GitHub App");
    }
  }
  async inspectRepository(input: GitHubRepositorySelection) {
    const token = await this.installationToken(input.installationId);
    const repository = await this.repository(`repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.name)}`, token);
    return { installationId: input.installationId, repositoryId: repository.id, repositoryUrl: repository.url };
  }
  async verifyRepository(input: GitHubRepositoryIdentity): Promise<void> {
    const token = await this.installationToken(input.installationId);
    const repository = await this.repository(`repositories/${encodeURIComponent(input.repositoryId)}`, token);
    if (repository.id !== input.repositoryId || repository.url !== input.repositoryUrl) throw new Error("GitHub repository identity changed");
  }
  async createBranch(repository: GitHubArtifactRepositoryIdentity, name: string) {
    const token = await this.installationToken(repository.installationId);
    const metadata = await this.githubJson(`repositories/${encodeURIComponent(repository.repositoryId)}`, token) as { default_branch?: unknown };
    if (typeof metadata.default_branch !== "string") throw new Error("GitHub returned no default branch");
    const source = await this.githubJson(`repositories/${encodeURIComponent(repository.repositoryId)}/git/ref/heads/${encodeURIComponent(metadata.default_branch)}`, token) as { object?: { sha?: unknown } };
    if (typeof source.object?.sha !== "string") throw new Error("GitHub returned an invalid branch reference");
    await this.githubJson(`repositories/${encodeURIComponent(repository.repositoryId)}/git/refs`, token, "POST", { ref: `refs/heads/${name}`, sha: source.object.sha });
    return { kind: "branch" as const, providerId: name, label: name, url: `${repository.repositoryUrl}/tree/${encodeURIComponent(name)}` };
  }
  async inspectArtifact(repository: GitHubArtifactRepositoryIdentity, kind: DevelopmentArtifactKind, reference: string) {
    const token = await this.installationToken(repository.installationId);
    const path = kind === "branch" ? `git/ref/heads/${encodeURIComponent(reference)}` : kind === "commit" ? `commits/${encodeURIComponent(reference)}` : `pulls/${encodeURIComponent(reference)}`;
    const artifact = await this.githubJson(`repositories/${encodeURIComponent(repository.repositoryId)}/${path}`, token) as { sha?: unknown; number?: unknown };
    const providerId = kind === "commit" && typeof artifact.sha === "string" ? artifact.sha : kind === "pull_request" && Number.isSafeInteger(artifact.number) ? String(artifact.number) : reference;
    const urlPath = kind === "branch" ? `tree/${encodeURIComponent(reference)}` : kind === "commit" ? `commit/${providerId}` : `pull/${providerId}`;
    return { kind, providerId, label: reference, url: `${repository.repositoryUrl}/${urlPath}` };
  }
  private async installationToken(installationId: number): Promise<string> {
    const tokenResponse = await this.request(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${this.jwt()}`, "user-agent": "Stash", "x-github-api-version": "2022-11-28" },
    });
    if (!tokenResponse.ok) throw new Error("GitHub installation authorization failed");
    const tokenBody = await tokenResponse.json() as { token?: unknown };
    if (typeof tokenBody.token !== "string" || !tokenBody.token) throw new Error("GitHub returned an invalid installation credential");
    return tokenBody.token;
  }
  private async repository(path: string, token: string): Promise<{ id: string; url: string }> {
    const repositoryResponse = await this.request(`https://api.github.com/${path}`, { headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": "Stash", "x-github-api-version": "2022-11-28" } });
    if (!repositoryResponse.ok) throw new Error("GitHub repository authorization failed");
    const repository = await repositoryResponse.json() as { id?: unknown; html_url?: unknown };
    if ((typeof repository.id !== "number" && typeof repository.id !== "string") || typeof repository.html_url !== "string") throw new Error("GitHub returned an invalid repository");
    return { id: String(repository.id), url: repository.html_url };
  }
  private async githubJson(path: string, token: string, method = "GET", body?: object): Promise<unknown> {
    const response = await this.request(`https://api.github.com/${path}`, { method, headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "content-type": "application/json", "user-agent": "Stash", "x-github-api-version": "2022-11-28" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw new Error("GitHub development artifact operation failed");
    return response.status === 204 ? {} : response.json();
  }
  private jwt(): string {
    const now = Math.floor(Date.now() / 1_000);
    const encoded = `${base64url({ alg: "RS256", typ: "JWT" })}.${base64url({ iat: now - 60, exp: now + 540, iss: this.appId })}`;
    const signer = createSign("RSA-SHA256");
    signer.update(encoded);
    return `${encoded}.${signer.sign(this.privateKey, "base64url")}`;
  }
}
function base64url(value: object): string { return Buffer.from(JSON.stringify(value)).toString("base64url"); }

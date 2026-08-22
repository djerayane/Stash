import { createSign } from "node:crypto";
import type { GitHubApp, GitHubRepositoryIdentity, GitHubRepositorySelection } from "./repository-connections.js";

export class GitHubAppClient implements GitHubApp {
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
  private jwt(): string {
    const now = Math.floor(Date.now() / 1_000);
    const encoded = `${base64url({ alg: "RS256", typ: "JWT" })}.${base64url({ iat: now - 60, exp: now + 540, iss: this.appId })}`;
    const signer = createSign("RSA-SHA256");
    signer.update(encoded);
    return `${encoded}.${signer.sign(this.privateKey, "base64url")}`;
  }
}
function base64url(value: object): string { return Buffer.from(JSON.stringify(value)).toString("base64url"); }

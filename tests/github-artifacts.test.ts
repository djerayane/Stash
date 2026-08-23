import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { GitHubArtifactService, type GitHubArtifactProvider, type GitHubArtifactRepository, type DevelopmentArtifact } from "../src/github-artifacts.js";
import { startInstance, type RunningInstance } from "../src/instance.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const connectionId = "22222222-2222-4222-8222-222222222222";

class RepositoryFake implements GitHubArtifactRepository {
  readonly links = new Map<string, DevelopmentArtifact[]>();
  allow = true;
  async resolveTask(memberId: string, project: string, key: string) {
    return this.allow && memberId === "member" && project === projectId && ["STASH-35", "STASH-36"].includes(key)
      ? { id: key === "STASH-35" ? "task-35" : "task-36", key, title: key === "STASH-35" ? "Create and manually link GitHub artifacts" : "Another task" }
      : undefined;
  }
  async resolveConnection(memberId: string, project: string, id: string) {
    return this.allow && memberId === "member" && project === projectId && id === connectionId
      ? { installationId: 42, repositoryId: "987", repositoryUrl: "https://github.com/acme/stash" }
      : undefined;
  }
  async linkArtifact(memberId: string, project: string, taskId: string, artifact: DevelopmentArtifact) {
    if (!this.allow || memberId !== "member" || project !== projectId) return "forbidden" as const;
    const current = this.links.get(taskId) ?? [];
    if (!current.some((candidate) => candidate.url === artifact.url)) current.push(artifact);
    this.links.set(taskId, current);
    return "linked" as const;
  }
  async listArtifacts(memberId: string, project: string, taskId: string) {
    return this.allow && memberId === "member" && project === projectId ? this.links.get(taskId) ?? [] : undefined;
  }
}

class GitHubFake implements GitHubArtifactProvider {
  unavailable = false;
  created: string[] = [];
  async createBranch(_repository: { installationId: number; repositoryId: string; repositoryUrl: string }, name: string) {
    if (this.unavailable) throw new Error("github unavailable");
    this.created.push(name);
    return { kind: "branch" as const, providerId: name, url: `https://github.com/acme/stash/tree/${encodeURIComponent(name)}`, label: name };
  }
  async inspectArtifact(_repository: { installationId: number; repositoryId: string; repositoryUrl: string }, kind: "branch" | "commit" | "pull_request", reference: string) {
    if (this.unavailable) throw new Error("github unavailable");
    const path = kind === "branch" ? `tree/${encodeURIComponent(reference)}` : kind === "commit" ? `commit/${reference}` : `pull/${reference}`;
    return { kind, providerId: reference, url: `https://github.com/acme/stash/${path}`, label: reference };
  }
}

describe("GitHub development artifacts", () => {
  let instance: RunningInstance | undefined;
  afterEach(async () => { await instance?.close(); instance = undefined; });
  async function run() {
    const repository = new RepositoryFake(); const github = new GitHubFake();
    instance = await startInstance({ database: { async verifyConnection() {}, async close() {} }, host: "127.0.0.1", port: 0,
      instanceAdminToken: "admin", memberAccess: { async authenticateBearer(value) { return value === "Bearer member" ? { accountId: "member", sessionId: "session" } : undefined; } },
      githubArtifacts: new GitHubArtifactService(repository, github) });
    return { repository, github, baseUrl: instance.url };
  }
  const endpoint = (baseUrl: string, key = "STASH-35") => `${baseUrl}/api/projects/${projectId}/tasks/${key}/development-artifacts`;
  const post = (url: string, body: unknown, token = "member") => fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });

  it("creates a Task-keyed branch and leaves Task status human-controlled", async () => {
    const { baseUrl, github } = await run();
    const response = await post(endpoint(baseUrl), { action: "create_branch", connectionId });
    assert.equal(response.status, 201);
    const body = await response.json() as { artifact: DevelopmentArtifact };
    assert.equal(body.artifact.kind, "branch");
    assert.equal(body.artifact.label, "stash-35-create-and-manually-link-github-artifacts");
    assert.deepEqual(github.created, [body.artifact.label]);
    assert.equal("status" in body, false);
  });

  it("manually links branches, commits, and pull requests many-to-many without duplicates", async () => {
    const { baseUrl } = await run();
    for (const [kind, reference] of [["branch", "feature/shared"], ["commit", "a".repeat(40)], ["pull_request", "42"]] as const) {
      const response = await post(endpoint(baseUrl), { action: "link", connectionId, kind, reference });
      assert.equal(response.status, 201);
    }
    await post(endpoint(baseUrl, "STASH-36"), { action: "link", connectionId, kind: "pull_request", reference: "42" });
    await post(endpoint(baseUrl), { action: "link", connectionId, kind: "pull_request", reference: "42" });
    const listed = await fetch(endpoint(baseUrl), { headers: { authorization: "Bearer member" } });
    assert.equal(listed.status, 200);
    const body = await listed.json() as { artifacts: DevelopmentArtifact[] };
    assert.deepEqual(body.artifacts.map(({ kind }) => kind), ["branch", "commit", "pull_request"]);
  });

  it("makes authentication, permissions, invalid input, and recoverable GitHub failure visible", async () => {
    const { baseUrl, github, repository } = await run();
    assert.equal((await post(endpoint(baseUrl), { action: "create_branch", connectionId }, "bad")).status, 401);
    assert.equal((await post(endpoint(baseUrl), { action: "link", connectionId, kind: "commit", reference: "nope" })).status, 422);
    repository.allow = false;
    assert.equal((await post(endpoint(baseUrl), { action: "create_branch", connectionId })).status, 404);
    repository.allow = true; github.unavailable = true;
    const failed = await post(endpoint(baseUrl), { action: "create_branch", connectionId });
    assert.equal(failed.status, 502);
    assert.deepEqual(repository.links.size, 0);
  });
});

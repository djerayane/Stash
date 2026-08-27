import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, it } from "node:test";

import { GitHubArtifactService, type GitHubArtifactProvider, type GitHubArtifactRepository, type DevelopmentArtifact } from "../src/github-artifacts.js";
import { startInstance, type RunningInstance } from "./support/start-test-instance.js";
import { GitHubAppClient } from "../src/github-app.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const connectionId = "22222222-2222-4222-8222-222222222222";

class RepositoryFake implements GitHubArtifactRepository {
  readonly links = new Map<string, DevelopmentArtifact[]>();
  allow = true;
  writeAllowed = true;
  failNextLink = false;
  async listConnections(memberId: string, project: string) { return this.allow && memberId === "member" && project === projectId ? [{ id: connectionId, repositoryUrl: "https://github.com/acme/stash" }] : []; }
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
  async canLinkArtifact(memberId: string, project: string, taskKey: string) { return this.writeAllowed && Boolean(await this.resolveTask(memberId, project, taskKey)); }
  async linkArtifact(memberId: string, project: string, taskId: string, artifact: DevelopmentArtifact) {
    if (this.failNextLink) { this.failNextLink = false; throw new Error("projection unavailable"); }
    if (!this.writeAllowed || !this.allow || memberId !== "member" || project !== projectId) return "forbidden" as const;
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
  readonly branches = new Set<string>();
  async createBranch(_repository: { installationId: number; repositoryId: string; repositoryUrl: string }, name: string) {
    if (this.unavailable) throw new Error("github unavailable");
    this.created.push(name);
    this.branches.add(name);
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

  it("discovers only the active Repository Connections attached to the Project", async () => {
    const { baseUrl } = await run();
    const response = await fetch(`${baseUrl}/api/projects/${projectId}/repository-connections`, { headers: { authorization: "Bearer member" } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { repositoryConnections: [{ id: connectionId, repositoryUrl: "https://github.com/acme/stash" }] });
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

  it("atomically preserves concurrent artifact appends", async () => {
    const { baseUrl } = await run();
    const responses = await Promise.all([
      post(endpoint(baseUrl), { action: "link", connectionId, kind: "branch", reference: "feature/one" }),
      post(endpoint(baseUrl), { action: "link", connectionId, kind: "commit", reference: "b".repeat(40) }),
    ]);
    assert.deepEqual(responses.map(({ status }) => status), [201, 201]);
    const body = await (await fetch(endpoint(baseUrl), { headers: { authorization: "Bearer member" } })).json() as { artifacts: DevelopmentArtifact[] };
    assert.deepEqual(body.artifacts.map(({ kind }) => kind).sort(), ["branch", "commit"]);
  });

  it("authorizes Task writes before provider reads or branch side effects", async () => {
    const { baseUrl, repository, github } = await run(); repository.writeAllowed = false;
    assert.equal((await post(endpoint(baseUrl), { action: "create_branch", connectionId })).status, 403);
    assert.equal((await post(endpoint(baseUrl), { action: "link", connectionId, kind: "pull_request", reference: "42" })).status, 403);
    assert.deepEqual(github.created, []);
  });

  it("converges when branch creation succeeded before link persistence failed", async () => {
    const { baseUrl, repository, github } = await run(); repository.failNextLink = true;
    assert.equal((await post(endpoint(baseUrl), { action: "create_branch", connectionId })).status, 503);
    assert.equal((await post(endpoint(baseUrl), { action: "create_branch", connectionId })).status, 201);
    assert.equal(github.branches.size, 1);
    const body = await (await fetch(endpoint(baseUrl), { headers: { authorization: "Bearer member" } })).json() as { artifacts: DevelopmentArtifact[] };
    assert.equal(body.artifacts.length, 1);
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

describe("GitHub App branch idempotency", () => {
  const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const repository = { installationId: 42, repositoryId: "987", repositoryUrl: "https://github.com/acme/stash" };
  function client(existingSha: string) {
    const calls: string[] = [];
    const request: typeof fetch = async (input, init) => {
      const url = String(input); calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.endsWith("/repositories/987")) return Response.json({ default_branch: "main" });
      if (url.includes("/git/ref/heads/main")) return Response.json({ object: { sha: "source-sha" } });
      if (url.endsWith("/git/refs")) return Response.json({ message: "Reference already exists" }, { status: 422 });
      if (url.includes("/git/ref/heads/stash-35-work")) return Response.json({ object: { sha: existingSha } });
      return Response.json({}, { status: 500 });
    };
    return { app: new GitHubAppClient("1", privateKey, request), calls };
  }
  it("accepts an existing intended branch after a lost create response", async () => {
    const { app } = client("source-sha");
    assert.equal((await app.createBranch(repository, "stash-35-work")).label, "stash-35-work");
  });
  it("rejects a same-name branch that points somewhere else", async () => {
    const { app } = client("unrelated-sha");
    await assert.rejects(app.createBranch(repository, "stash-35-work"));
  });
});

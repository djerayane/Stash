import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { afterEach, describe, it } from "node:test";

import {
  GitHubSignalService,
  type GitHubSignal,
  type GitHubSignalRepository,
  type SignalCandidate,
} from "../src/github-signals.js";
import { startInstance, type RunningInstance } from "../src/instance.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const secret = "github-webhook-secret";

class RepositoryFake implements GitHubSignalRepository {
  signals = new Map<string, GitHubSignal>();
  candidates = new Map<string, SignalCandidate[]>();
  readable = true;
  writable = true;
  fail = false;
  async matchingTasks(repositoryId: string, keys: string[]) {
    if (repositoryId !== "987") return [];
    return keys.flatMap((key) => key === "STASH-36"
      ? [{ taskId: "task-36", projectId, taskKey: key, title: "Receive GitHub development Signals", matchedKey: key }]
      : key === "OLD-1"
        ? [
          { taskId: "task-36", projectId, taskKey: "STASH-36", title: "Receive GitHub development Signals", matchedKey: key },
          { taskId: "task-other", projectId, taskKey: "STASH-99", title: "Another matching Task", matchedKey: key },
        ]
        : []);
  }
  async receive(signal: GitHubSignal, candidates: SignalCandidate[]) {
    if (this.fail) throw new Error("database unavailable");
    if (!this.signals.has(signal.id)) {
      this.signals.set(signal.id, signal);
      this.candidates.set(signal.id, candidates);
    }
  }
  async list(memberId: string, project: string, key: string) {
    if (!this.readable || memberId !== "member" || project !== projectId || key !== "STASH-36") return undefined;
    return [...this.signals.values()].flatMap((signal) => {
      const matches = (this.candidates.get(signal.id) ?? []).filter((candidate) => candidate.taskId === "task-36");
      return matches.length ? [{ signal, suggestions: matches }] : [];
    });
  }
  async confirm(memberId: string, project: string, key: string, suggestionId: string) {
    if (!this.writable) return "forbidden" as const;
    const candidate = [...this.candidates.values()].flat().find((value) => value.id === suggestionId && value.taskId === "task-36");
    if (memberId !== "member" || project !== projectId || key !== "STASH-36" || !candidate) return "not_found" as const;
    candidate.status = "confirmed";
    return "confirmed" as const;
  }
}

function signature(body: string) {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

describe("GitHub development Signals", () => {
  let instance: RunningInstance | undefined;
  afterEach(async () => { await instance?.close(); instance = undefined; });

  async function run() {
    const repository = new RepositoryFake();
    instance = await startInstance({
      database: { async verifyConnection() {}, async close() {} }, host: "127.0.0.1", port: 0, instanceAdminToken: "admin",
      memberAccess: { async authenticateBearer(value) { return value === "Bearer member" ? { accountId: "member", sessionId: "session" } : undefined; } },
      githubSignals: new GitHubSignalService(repository, secret),
    });
    return { repository, baseUrl: instance.url };
  }

  it("receives verified duplicate-safe activity and exposes a unique Task-key relation", async () => {
    const { repository, baseUrl } = await run();
    const body = JSON.stringify({ ref: "refs/heads/STASH-36-signals", repository: { id: 987, html_url: "https://github.com/acme/stash" }, after: "a".repeat(40), head_commit: { message: "Ship STASH-36" } });
    for (const _ of [1, 2]) {
      const response = await fetch(`${baseUrl}/api/github/webhooks`, { method: "POST", headers: { "content-type": "application/json", "x-github-event": "push", "x-github-delivery": "delivery-1", "x-hub-signature-256": signature(body) }, body });
      assert.equal(response.status, 202);
    }
    assert.equal(repository.signals.size, 1);
    const response = await fetch(`${baseUrl}/api/projects/${projectId}/tasks/STASH-36/development-signals`, { headers: { authorization: "Bearer member" } });
    assert.equal(response.status, 200);
    const result = await response.json() as { signals: Array<{ signal: GitHubSignal; suggestions: SignalCandidate[] }> };
    assert.equal(result.signals[0]?.signal.kind, "commit");
    assert.equal(result.signals[0]?.suggestions[0]?.status, "confirmed");

    const branchBody = JSON.stringify({ ref_type: "branch", ref: "STASH-36-signals", repository: { id: 987, html_url: "https://github.com/acme/stash" } });
    assert.equal((await fetch(`${baseUrl}/api/github/webhooks`, { method: "POST", headers: { "x-github-event": "create", "x-github-delivery": "delivery-branch", "x-hub-signature-256": signature(branchBody) }, body: branchBody })).status, 202);
    const refreshed = await (await fetch(`${baseUrl}/api/projects/${projectId}/tasks/STASH-36/development-signals`, { headers: { authorization: "Bearer member" } })).json() as { signals: Array<{ signal: GitHubSignal }> };
    assert.deepEqual(refreshed.signals.map(({ signal }) => signal.kind).sort(), ["branch", "commit"]);
  });

  it("requires explicit confirmation when one textual key can identify multiple Tasks", async () => {
    const { baseUrl } = await run();
    const body = JSON.stringify({ action: "opened", repository: { id: 987, html_url: "https://github.com/acme/stash" }, pull_request: { id: 42, number: 42, html_url: "https://github.com/acme/stash/pull/42", title: "OLD-1 shared work", body: "Touches both surfaces", merged: false } });
    assert.equal((await fetch(`${baseUrl}/api/github/webhooks`, { method: "POST", headers: { "content-type": "application/json", "x-github-event": "pull_request", "x-github-delivery": "delivery-2", "x-hub-signature-256": signature(body) }, body })).status, 202);
    const list = await fetch(`${baseUrl}/api/projects/${projectId}/tasks/STASH-36/development-signals`, { headers: { authorization: "Bearer member" } });
    const result = await list.json() as { signals: Array<{ suggestions: SignalCandidate[] }> };
    const suggestion = result.signals[0]!.suggestions[0]!;
    assert.equal(suggestion.status, "pending_confirmation");
    const confirm = await fetch(`${baseUrl}/api/projects/${projectId}/tasks/STASH-36/development-signals/suggestions/${suggestion.id}/confirm`, { method: "POST", headers: { authorization: "Bearer member" } });
    assert.equal(confirm.status, 200);
    assert.equal(((await confirm.json()) as { suggestion: SignalCandidate }).suggestion.status, "confirmed");
  });

  it("rejects forged or invalid payloads and makes permissions and recoverable storage failures visible", async () => {
    const { repository, baseUrl } = await run();
    const body = JSON.stringify({ ref: "refs/heads/STASH-36", repository: { id: 987 }, after: "a".repeat(40) });
    assert.equal((await fetch(`${baseUrl}/api/github/webhooks`, { method: "POST", headers: { "x-github-event": "push", "x-github-delivery": "delivery-3", "x-hub-signature-256": "sha256=forged" }, body })).status, 401);
    assert.equal((await fetch(`${baseUrl}/api/github/webhooks`, { method: "POST", headers: { "x-github-event": "push", "x-github-delivery": "delivery-3", "x-hub-signature-256": signature("{") }, body: "{" })).status, 400);
    assert.equal((await fetch(`${baseUrl}/api/projects/${projectId}/tasks/STASH-36/development-signals`)).status, 401);
    repository.writable = false;
    assert.equal((await fetch(`${baseUrl}/api/projects/${projectId}/tasks/STASH-36/development-signals/suggestions/00000000-0000-4000-8000-000000000001/confirm`, { method: "POST", headers: { authorization: "Bearer member" } })).status, 403);
    repository.fail = true;
    const valid = JSON.stringify({ ref: "refs/heads/STASH-36", repository: { id: 987 }, after: "a".repeat(40), head_commit: { message: "STASH-36" } });
    assert.equal((await fetch(`${baseUrl}/api/github/webhooks`, { method: "POST", headers: { "x-github-event": "push", "x-github-delivery": "delivery-4", "x-hub-signature-256": signature(valid) }, body: valid })).status, 503);
  });
});

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
import { AutomationService, type AutomationRepository, type AutomationState } from "../src/automations.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const organizationId = "33333333-3333-4333-8333-333333333333";
const secret = "github-webhook-secret";

class RepositoryFake implements GitHubSignalRepository {
  signals = new Map<string, GitHubSignal>();
  candidates = new Map<string, SignalCandidate[]>();
  readable = true;
  writable = true;
  fail = false;
  async matchingTasks(installationId: number, repositoryId: string, keys: string[]) {
    if (installationId !== 42 || repositoryId !== "987") return [];
    return keys.flatMap((key) => key === "STASH-36"
      ? [{ taskId: "task-36", projectId, organizationId, taskKey: key, title: "Receive GitHub development Signals", matchedKey: key }]
      : key === "OLD-1"
        ? [
          { taskId: "task-36", projectId, organizationId, taskKey: "STASH-36", title: "Receive GitHub development Signals", matchedKey: key },
          { taskId: "task-other", projectId, organizationId, taskKey: "STASH-99", title: "Another matching Task", matchedKey: key },
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

class AutomationFake implements AutomationRepository {
  state: AutomationState = { recipes: [], transitions: [], availableStatuses: [{ id: "22222222-2222-4222-8222-222222222222", name: "In progress" }] };
  async listAutomationState() { return structuredClone(this.state); }
  async enableAutomation(_memberId: string, _projectId: string, trigger: "branch_created" | "pull_request_completed", targetStatusId: string) {
    const recipe = this.state.recipes.find((value) => value.trigger === trigger) ?? { id: "33333333-3333-4333-8333-333333333333", trigger, targetStatus: { id: targetStatusId, name: "In progress" }, enabled: true };
    if (!this.state.recipes.includes(recipe)) this.state.recipes.push(recipe);
    return { status: "enabled" as const, recipe };
  }
  async reverseAutomation(_memberId: string, _projectId: string, _taskKey: string, transitionId: string) {
    const transition = this.state.transitions.find((value) => value.id === transitionId); if (!transition) return "not_found" as const;
    transition.reversedAt ??= new Date().toISOString(); return { status: "reversed" as const, transition };
  }
  async applySignalAutomations(signal: { id: string; trigger?: "branch_created" | "pull_request_completed" }, candidates: ReadonlyArray<{ status: "confirmed" | "pending_confirmation" }>) {
    const recipe = this.state.recipes.find((value) => value.trigger === signal.trigger);
    if (!recipe || !candidates.some(({ status }) => status === "confirmed") || this.state.transitions.some((value) => value.signalId === signal.id)) return;
    this.state.transitions.push({ id: "44444444-4444-4444-8444-444444444444", automationId: recipe.id, signalId: signal.id,
      before: { id: "66666666-6666-4666-8666-666666666666", name: "Ready" }, after: recipe.targetStatus, occurredAt: new Date().toISOString() });
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
    const automationRepository = new AutomationFake(); const automations = new AutomationService(automationRepository);
    instance = await startInstance({
      database: { async verifyConnection() {}, async close() {} }, host: "127.0.0.1", port: 0, instanceAdminToken: "admin",
      memberAccess: { async authenticateBearer(value) { return value === "Bearer member" ? { accountId: "member", sessionId: "session" } : undefined; } },
      githubSignals: new GitHubSignalService(repository, secret, automations), automations,
    });
    return { repository, automationRepository, baseUrl: instance.url };
  }

  it("receives verified duplicate-safe activity and exposes a unique Task-key relation", async () => {
    const { repository, automationRepository, baseUrl } = await run();
    await fetch(`${baseUrl}/api/projects/${projectId}/automations`, { method: "POST", headers: { authorization: "Bearer member", "content-type": "application/json" }, body: JSON.stringify({ trigger: "branch_created", targetStatusId: "22222222-2222-4222-8222-222222222222" }) });
    const body = JSON.stringify({ ref: "refs/heads/STASH-36-signals", installation: { id: 42 }, repository: { id: 987, html_url: "https://github.com/acme/stash" }, after: "a".repeat(40), head_commit: { message: "Ship STASH-36" } });
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

    const branchBody = JSON.stringify({ ref_type: "branch", ref: "STASH-36-signals", installation: { id: 42 }, repository: { id: 987, html_url: "https://github.com/acme/stash" } });
    assert.equal((await fetch(`${baseUrl}/api/github/webhooks`, { method: "POST", headers: { "x-github-event": "create", "x-github-delivery": "delivery-branch", "x-hub-signature-256": signature(branchBody) }, body: branchBody })).status, 202);
    assert.equal((await fetch(`${baseUrl}/api/github/webhooks`, { method: "POST", headers: { "x-github-event": "create", "x-github-delivery": "delivery-branch", "x-hub-signature-256": signature(branchBody) }, body: branchBody })).status, 202);
    const refreshed = await (await fetch(`${baseUrl}/api/projects/${projectId}/tasks/STASH-36/development-signals`, { headers: { authorization: "Bearer member" } })).json() as { signals: Array<{ signal: GitHubSignal }> };
    assert.deepEqual(refreshed.signals.map(({ signal }) => signal.kind).sort(), ["branch", "commit"]);
    assert.equal(automationRepository.state.transitions.length, 1);
    const automation = await (await fetch(`${baseUrl}/api/projects/${projectId}/tasks/STASH-36/automations`, { headers: { authorization: "Bearer member" } })).json() as { automation: AutomationState };
    assert.equal(automation.automation.transitions[0]?.signalId, refreshed.signals.find(({ signal }) => signal.kind === "branch")?.signal.id);
    const transitionId = automation.automation.transitions[0]!.id;
    assert.equal((await fetch(`${baseUrl}/api/projects/${projectId}/tasks/STASH-36/automations/${transitionId}/reverse`, { method: "POST", headers: { authorization: "Bearer member" } })).status, 200);
    assert.ok(automationRepository.state.transitions[0]?.reversedAt);
  });

  it("requires explicit confirmation when one textual key can identify multiple Tasks", async () => {
    const { baseUrl, automationRepository } = await run();
    await fetch(`${baseUrl}/api/projects/${projectId}/automations`, { method: "POST", headers: { authorization: "Bearer member", "content-type": "application/json" }, body: JSON.stringify({ trigger: "pull_request_completed", targetStatusId: "22222222-2222-4222-8222-222222222222" }) });
    const body = JSON.stringify({ action: "closed", installation: { id: 42 }, repository: { id: 987, html_url: "https://github.com/acme/stash" }, pull_request: { id: 42, number: 42, html_url: "https://github.com/acme/stash/pull/42", title: "OLD-1 shared work", body: "Touches both surfaces", merged: true } });
    assert.equal((await fetch(`${baseUrl}/api/github/webhooks`, { method: "POST", headers: { "content-type": "application/json", "x-github-event": "pull_request", "x-github-delivery": "delivery-2", "x-hub-signature-256": signature(body) }, body })).status, 202);
    const list = await fetch(`${baseUrl}/api/projects/${projectId}/tasks/STASH-36/development-signals`, { headers: { authorization: "Bearer member" } });
    const result = await list.json() as { signals: Array<{ suggestions: SignalCandidate[] }> };
    const suggestion = result.signals[0]!.suggestions[0]!;
    assert.equal(suggestion.status, "pending_confirmation");
    const confirm = await fetch(`${baseUrl}/api/projects/${projectId}/tasks/STASH-36/development-signals/suggestions/${suggestion.id}/confirm`, { method: "POST", headers: { authorization: "Bearer member" } });
    assert.equal(confirm.status, 200);
    assert.equal(((await confirm.json()) as { suggestion: SignalCandidate }).suggestion.status, "confirmed");
    assert.equal(automationRepository.state.transitions.length, 1);
  });

  it("rejects forged or invalid payloads and makes permissions and recoverable storage failures visible", async () => {
    const { repository, baseUrl } = await run();
    const body = JSON.stringify({ ref: "refs/heads/STASH-36", installation: { id: 42 }, repository: { id: 987 }, after: "a".repeat(40) });
    assert.equal((await fetch(`${baseUrl}/api/github/webhooks`, { method: "POST", headers: { "x-github-event": "push", "x-github-delivery": "delivery-3", "x-hub-signature-256": "sha256=forged" }, body })).status, 401);
    assert.equal((await fetch(`${baseUrl}/api/github/webhooks`, { method: "POST", headers: { "x-github-event": "push", "x-github-delivery": "delivery-3", "x-hub-signature-256": signature("{") }, body: "{" })).status, 400);
    const invalidUrl = JSON.stringify({ installation: { id: 42 }, repository: { id: 987 }, pull_request: { number: 42, title: "STASH-36", html_url: "not a URL" } });
    assert.equal((await fetch(`${baseUrl}/api/github/webhooks`, { method: "POST", headers: { "x-github-event": "pull_request", "x-github-delivery": "delivery-invalid-url", "x-hub-signature-256": signature(invalidUrl) }, body: invalidUrl })).status, 400);
    assert.equal((await fetch(`${baseUrl}/api/projects/${projectId}/tasks/STASH-36/development-signals`)).status, 401);
    repository.writable = false;
    assert.equal((await fetch(`${baseUrl}/api/projects/${projectId}/tasks/STASH-36/development-signals/suggestions/00000000-0000-4000-8000-000000000001/confirm`, { method: "POST", headers: { authorization: "Bearer member" } })).status, 403);
    repository.fail = true;
    const valid = JSON.stringify({ ref: "refs/heads/STASH-36", installation: { id: 42 }, repository: { id: 987 }, after: "a".repeat(40), head_commit: { message: "STASH-36" } });
    assert.equal((await fetch(`${baseUrl}/api/github/webhooks`, { method: "POST", headers: { "x-github-event": "push", "x-github-delivery": "delivery-4", "x-hub-signature-256": signature(valid) }, body: valid })).status, 503);
  });
});

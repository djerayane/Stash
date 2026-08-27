import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { afterEach, describe, it } from "node:test";

import { AutomationService, type AutomationRepository, type AutomationState } from "../src/automations.js";
import { startInstance, type RunningInstance } from "./support/start-test-instance.js";
import { NotificationService, type NotificationDelivery, type NotificationPreferences, type NotificationRepository } from "../src/notifications.js";
import type { ActivityRecord } from "../src/activity.js";
import { GitHubSignalService, type GitHubSignal, type GitHubSignalRepository, type SignalCandidate } from "../src/github-signals.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const taskKey = "STASH-37";
const startedId = "22222222-2222-4222-8222-222222222222";
const memberId = "77777777-7777-4777-8777-777777777777";
const workspaceId = "88888888-8888-4888-8888-888888888888";

class AutomationFake implements AutomationRepository, NotificationRepository {
  state: AutomationState = { recipes: [], transitions: [], availableStatuses: [{ id: startedId, name: "In progress" }] };
  deliveries: NotificationDelivery[] = [];
  recipientHasAccess = true;
  failExecutions = false;
  writable = true;
  async listAutomationState(memberId: string, requestedProjectId: string, requestedTaskKey: string) {
    return memberId === "member" && requestedProjectId === projectId && requestedTaskKey === taskKey ? structuredClone(this.state) : undefined;
  }
  async enableAutomation(memberId: string, requestedProjectId: string, recipe: "branch_created", targetStatusId: string) {
    if (!this.writable) return "forbidden" as const;
    if (memberId !== "member" || requestedProjectId !== projectId || targetStatusId !== startedId) return "invalid_status" as const;
    const existing = this.state.recipes.find((entry) => entry.trigger === recipe);
    if (!existing) this.state.recipes.push({ id: "33333333-3333-4333-8333-333333333333", trigger: recipe, targetStatus: { id: startedId, name: "In progress" }, enabled: true });
    return { status: "enabled" as const, recipe: this.state.recipes[0]! };
  }
  async reverseAutomation(memberId: string, requestedProjectId: string, requestedTaskKey: string, transitionId: string) {
    if (!this.writable) return "forbidden" as const;
    const transition = this.state.transitions.find((entry) => entry.id === transitionId);
    if (memberId !== "member" || requestedProjectId !== projectId || requestedTaskKey !== taskKey || !transition) return "not_found" as const;
    if (!transition.reversedAt) transition.reversedAt = "2026-08-23T10:00:00.000Z";
    return { status: "reversed" as const, transition };
  }
  async applySignalAutomations(signal: { id: string; trigger?: "branch_created" | "pull_request_completed" }, candidates: ReadonlyArray<{ taskId: string; projectId: string; status: "confirmed" | "pending_confirmation" }>) {
    if (this.failExecutions) {
      if (!candidates.some(({ projectId: candidateProjectId, status }) => candidateProjectId === projectId && status === "confirmed")) return { failed: false, notifications: [] };
      const activity: ActivityRecord = { schema: "stash.activity.v1", id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", workspaceId,
        object: { kind: "Task", id: "task-37" }, action: "automation_execution_failed",
        actor: { localAccountId: memberId, displayName: "Automation Owner" },
        cause: { kind: "automation", automationId: "33333333-3333-4333-8333-333333333333", signalId: signal.id },
        occurredAt: "2026-08-23T09:30:00.000Z", before: { status: "running" }, after: { status: "failed" } };
      return { failed: true, notifications: this.recipientHasAccess
        ? [{ activity, projectId, memberId, summary: "Automation failed for STASH-37: Automate status" }] : [] };
    }
    const recipe = this.state.recipes.find((entry) => entry.trigger === signal.trigger);
    if (!recipe || !candidates.some((candidate) => candidate.projectId === projectId && candidate.status === "confirmed")
      || this.state.transitions.some((transition) => transition.signalId === signal.id)) return { failed: false, notifications: [] };
    this.state.transitions.push({ id: "44444444-4444-4444-8444-444444444444", automationId: recipe.id, signalId: signal.id,
      before: { id: "66666666-6666-4666-8666-666666666666", name: "Ready" }, after: recipe.targetStatus, occurredAt: "2026-08-23T09:00:00.000Z" });
    return { failed: false, notifications: [] };
  }
  async saveNotification(delivery: NotificationDelivery) {
    const existing = this.deliveries.find((entry) => entry.memberId === delivery.memberId && entry.activity.id === delivery.activity.id && entry.trigger === delivery.trigger);
    if (existing) return structuredClone(existing);
    this.deliveries.push(structuredClone(delivery)); return delivery;
  }
  async listNotifications(requestedMemberId: string) { return this.deliveries.filter(({ memberId: recipient }) => recipient === requestedMemberId); }
  async markNotificationRead() { return undefined; }
  async getNotificationPreferences(requestedMemberId: string, requestedProjectId: string): Promise<NotificationPreferences | undefined> {
    return requestedMemberId === memberId && requestedProjectId === projectId ? { activity: "followed", digest: "off" } : undefined;
  }
  async saveNotificationPreferences() { return undefined; }
  async claimDigestNotifications() { return []; }
}

class SignalFake implements GitHubSignalRepository {
  async matchingTasks() { return [{ taskId: "task-37", projectId, organizationId: "99999999-9999-4999-8999-999999999999",
    taskKey: "STASH-37", title: "Automate status", matchedKey: "STASH-37" }]; }
  async receive(_signal: GitHubSignal, _candidates: SignalCandidate[]) {}
  async list() { return []; }
  async confirm() { return "not_found" as const; }
}

describe("visible Task status Automations", () => {
  let instance: RunningInstance | undefined;
  afterEach(async () => { await instance?.close(); instance = undefined; });

  async function run() {
    const repository = new AutomationFake();
    const service = new AutomationService(repository);
    instance = await startInstance({ database: { async verifyConnection() {}, async close() {} }, host: "127.0.0.1", port: 0,
      instanceAdminToken: "admin", memberAccess: { async authenticateBearer(value) { return value === "Bearer member" ? { accountId: "member", sessionId: "session" } : undefined; } },
      automations: service });
    return { repository, service, baseUrl: instance.url };
  }

  it("configures a contextual When/If/Then recipe idempotently", async () => {
    const { repository, baseUrl } = await run();
    for (const _ of [1, 2]) {
      const response = await fetch(`${baseUrl}/api/projects/${projectId}/automations`, { method: "POST", headers: { authorization: "Bearer member", "content-type": "application/json" }, body: JSON.stringify({ trigger: "branch_created", targetStatusId: startedId }) });
      assert.equal(response.status, 200);
    }
    assert.equal(repository.state.recipes.length, 1);
    assert.equal((await (await fetch(`${baseUrl}/api/projects/${projectId}/tasks/${taskKey}/automations`, { headers: { authorization: "Bearer member" } })).json() as { automation: AutomationState }).automation.recipes[0]?.trigger, "branch_created");
  });

  it("applies one visible transition for duplicate delivery of a confirmed Signal", async () => {
    const { repository, service, baseUrl } = await run();
    await service.enable("member", projectId, { trigger: "branch_created", targetStatusId: startedId });
    const signal = { id: "55555555-5555-4555-8555-555555555555", trigger: "branch_created" as const };
    for (const _ of [1, 2]) await service.applySignal(signal, [{ taskId: "task-37", projectId, status: "confirmed" }]);
    const response = await fetch(`${baseUrl}/api/projects/${projectId}/tasks/${taskKey}/automations`, { headers: { authorization: "Bearer member" } });
    assert.equal(response.status, 200);
    const result = await response.json() as { automation: AutomationState };
    assert.equal(result.automation.transitions.length, 1);
    assert.equal(result.automation.transitions[0]?.signalId, signal.id);
    assert.deepEqual(result.automation.transitions[0]?.after, { id: startedId, name: "In progress" });
  });

  it("shows an attributable transition and reverses it idempotently", async () => {
    const { repository, baseUrl } = await run();
    repository.state.transitions.push({ id: "44444444-4444-4444-8444-444444444444", automationId: "33333333-3333-4333-8333-333333333333", signalId: "55555555-5555-4555-8555-555555555555",
      before: { id: "66666666-6666-4666-8666-666666666666", name: "Ready" }, after: { id: startedId, name: "In progress" }, occurredAt: "2026-08-23T09:00:00.000Z" });
    for (const _ of [1, 2]) {
      const response = await fetch(`${baseUrl}/api/projects/${projectId}/tasks/${taskKey}/automations/44444444-4444-4444-8444-444444444444/reverse`, { method: "POST", headers: { authorization: "Bearer member" } });
      assert.equal(response.status, 200);
    }
    assert.equal(repository.state.transitions[0]?.reversedAt, "2026-08-23T10:00:00.000Z");
  });

  it("makes authentication, permission, invalid input, and recoverable failures visible", async () => {
    const { repository, baseUrl } = await run();
    assert.equal((await fetch(`${baseUrl}/api/projects/${projectId}/tasks/${taskKey}/automations`)).status, 401);
    assert.equal((await fetch(`${baseUrl}/api/projects/${projectId}/automations`, { method: "POST", headers: { authorization: "Bearer member", "content-type": "application/json" }, body: "{}" })).status, 422);
    repository.writable = false;
    assert.equal((await fetch(`${baseUrl}/api/projects/${projectId}/automations`, { method: "POST", headers: { authorization: "Bearer member", "content-type": "application/json" }, body: JSON.stringify({ trigger: "branch_created", targetStatusId: startedId }) })).status, 403);
  });

  it("notifies the server-derived Automation owner once when canonical execution fails", async () => {
    const repository = new AutomationFake();
    repository.failExecutions = true;
    const service = new AutomationService(repository, new NotificationService(repository, () => new Date("2026-08-23T09:30:00.000Z")));
    const webhookSecret = "automation-failure-secret";
    instance = await startInstance({ database: { async verifyConnection() {}, async close() {} }, host: "127.0.0.1", port: 0,
      instanceAdminToken: "admin", memberAccess: { async authenticateBearer(value) { return value === "Bearer owner" ? { accountId: memberId, sessionId: "session" } : undefined; } },
      githubSignals: new GitHubSignalService(new SignalFake(), webhookSecret, service), automations: service, notifications: new NotificationService(repository) });
    const webhookBody = JSON.stringify({ ref_type: "branch", ref: "STASH-37-failure", installation: { id: 42 },
      repository: { id: 987, html_url: "https://github.com/acme/stash" } });
    const signature = `sha256=${createHmac("sha256", webhookSecret).update(webhookBody).digest("hex")}`;
    for (const _ of [1, 2]) {
      const failedResponse: Response = await fetch(`${instance.url}/api/github/webhooks`, { method: "POST", headers: { "x-github-event": "create",
        "x-github-delivery": "automation-failure-delivery", "x-hub-signature-256": signature }, body: webhookBody });
      assert.equal(failedResponse.status, 503);
    }
    const response = await fetch(`${instance.url}/api/notifications`, { headers: { authorization: "Bearer owner" } });
    assert.equal(response.status, 200);
    const body = await response.json() as { notifications: NotificationDelivery[] };
    assert.equal(body.notifications.length, 1, "a retried failed Signal must preserve one failure delivery");
    assert.deepEqual(body.notifications[0], { schema: "stash.notification.v1", id: body.notifications[0]!.id, memberId, workspaceId, projectId,
      trigger: "automation_failure", summary: "Automation failed for STASH-37: Automate status",
      activity: { schema: "stash.activity.v1", id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", workspaceId,
        object: { kind: "Task", id: "task-37" }, action: "automation_execution_failed",
        actor: { localAccountId: memberId, displayName: "Automation Owner" },
        cause: { kind: "automation", automationId: "33333333-3333-4333-8333-333333333333", signalId: body.notifications[0]!.activity.cause.kind === "automation" ? body.notifications[0]!.activity.cause.signalId : undefined },
        occurredAt: "2026-08-23T09:30:00.000Z", before: { status: "running" }, after: { status: "failed" } },
      createdAt: "2026-08-23T09:30:00.000Z", delivery: "immediate" });
    repository.recipientHasAccess = false;
    const departed = await fetch(`${instance.url}/api/github/webhooks`, { method: "POST", headers: { "x-github-event": "create",
      "x-github-delivery": "departed-owner-delivery", "x-hub-signature-256": `sha256=${createHmac("sha256", webhookSecret).update(webhookBody).digest("hex")}` }, body: webhookBody });
    assert.equal(departed.status, 503);
    assert.equal(repository.deliveries.length, 1, "a departed Automation owner must not receive another Project notification");
  });
});

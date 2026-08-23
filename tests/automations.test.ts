import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { AutomationService, type AutomationRepository, type AutomationState } from "../src/automations.js";
import { startInstance, type RunningInstance } from "../src/instance.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const taskKey = "STASH-37";
const startedId = "22222222-2222-4222-8222-222222222222";

class AutomationFake implements AutomationRepository {
  state: AutomationState = { recipes: [], transitions: [], availableStatuses: [{ id: startedId, name: "In progress" }] };
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
    const recipe = this.state.recipes.find((entry) => entry.trigger === signal.trigger);
    if (!recipe || !candidates.some((candidate) => candidate.projectId === projectId && candidate.status === "confirmed")
      || this.state.transitions.some((transition) => transition.signalId === signal.id)) return;
    this.state.transitions.push({ id: "44444444-4444-4444-8444-444444444444", automationId: recipe.id, signalId: signal.id,
      before: { id: "66666666-6666-4666-8666-666666666666", name: "Ready" }, after: recipe.targetStatus, occurredAt: "2026-08-23T09:00:00.000Z" });
  }
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
});

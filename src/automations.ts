import type { AutomationRecipe, AutomationState, AutomationTransition, AutomationTrigger } from "@stash/domain-types";
import type { ActivityRecord } from "./activity.js";
import type { NotificationService } from "./notifications.js";

export type { AutomationRecipe, AutomationState, AutomationTransition, AutomationTrigger } from "@stash/domain-types";

export interface AutomationRepository {
  listAutomationState(memberId: string, projectId: string, taskKey: string): Promise<AutomationState | undefined>;
  enableAutomation(memberId: string, projectId: string, trigger: AutomationTrigger, targetStatusId: string): Promise<
    { status: "enabled"; recipe: AutomationRecipe } | "forbidden" | "not_found" | "invalid_status"
  >;
  reverseAutomation(memberId: string, projectId: string, taskKey: string, transitionId: string): Promise<
    { status: "reversed"; transition: AutomationTransition } | "forbidden" | "not_found" | "conflict"
  >;
  applySignalAutomations?(signal: { id: string; trigger?: AutomationTrigger }, candidates: ReadonlyArray<AutomationCandidate>): Promise<
    { failed: boolean; notifications: AutomationFailureNotification[] } | void
  >;
}

export interface AutomationCandidate { taskId: string; projectId: string; taskKey?: string; matchedKey?: string; status: "confirmed" | "pending_confirmation" }
export interface AutomationFailureNotification {
  activity: ActivityRecord;
  projectId: string;
  memberId: string;
  summary: string;
}

export class InvalidAutomationInput extends Error {}
export class AutomationForbidden extends Error {}
export class AutomationNotFound extends Error {}
export class AutomationConflict extends Error {}
export class AutomationExecutionFailed extends Error {}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const key = /^[A-Z][A-Z0-9]{0,15}-[1-9][0-9]*$/i;

export class AutomationService {
  constructor(private readonly repository: AutomationRepository, private readonly notifications?: NotificationService) {}

  async list(memberId: string, projectId: string, taskKey: string) {
    validateProjectAndKey(projectId, taskKey);
    const state = await this.repository.listAutomationState(memberId, projectId, taskKey.toUpperCase());
    if (!state) throw new AutomationNotFound();
    return state;
  }

  async enable(memberId: string, projectId: string, value: unknown) {
    if (!uuid.test(projectId) || !record(value) || Object.keys(value).length !== 2
      || (value.trigger !== "branch_created" && value.trigger !== "pull_request_completed")
      || typeof value.targetStatusId !== "string" || !uuid.test(value.targetStatusId)) throw new InvalidAutomationInput();
    const result = await this.repository.enableAutomation(memberId, projectId, value.trigger, value.targetStatusId);
    if (result === "forbidden") throw new AutomationForbidden();
    if (result === "not_found") throw new AutomationNotFound();
    if (result === "invalid_status") throw new InvalidAutomationInput();
    return result.recipe;
  }

  async reverse(memberId: string, projectId: string, taskKey: string, transitionId: string) {
    validateProjectAndKey(projectId, taskKey);
    if (!uuid.test(transitionId)) throw new InvalidAutomationInput();
    const result = await this.repository.reverseAutomation(memberId, projectId, taskKey.toUpperCase(), transitionId);
    if (result === "forbidden") throw new AutomationForbidden();
    if (result === "not_found") throw new AutomationNotFound();
    if (result === "conflict") throw new AutomationConflict();
    return result.transition;
  }

  async applySignal(signal: { id: string; trigger?: AutomationTrigger }, candidates: ReadonlyArray<AutomationCandidate>) {
    if (!signal.trigger) return;
    const result = await this.repository.applySignalAutomations?.(signal, candidates);
    for (const failure of result?.notifications ?? []) {
      await this.notifications?.notify({ ...failure, trigger: "automation_failure" });
    }
    if (result?.failed) throw new AutomationExecutionFailed("One or more Automation executions failed");
  }
}

function validateProjectAndKey(projectId: string, taskKey: string) {
  if (!uuid.test(projectId) || !key.test(taskKey)) throw new InvalidAutomationInput();
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }

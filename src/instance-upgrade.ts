import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { InstanceBackupService } from "./instance-backup.js";

export interface UpgradeCheck { id: string; status: "pass" | "fail"; message: string }
export interface InstanceUpgradeTarget {
  inspect(): Promise<{ currentVersion: string; checks: UpgradeCheck[] }>;
  apply(fromVersion: string, targetVersion: string): Promise<void>;
  rollback(backupPath: string): Promise<void>;
}
export type InstanceUpgradePlan = { status: "ready" | "blocked" | "current"; currentVersion: string; targetVersion: string; checks: UpgradeCheck[] };

export class InstanceUpgradeService {
  #operation: "idle" | "upgrading" | "restart_required" = "idle";
  #unavailableBarrier: () => Promise<void> = async () => undefined;
  readonly #now: () => Date;
  constructor(private readonly options: { target: InstanceUpgradeTarget; backups: InstanceBackupService; backupRoot: string; targetVersion: string; now?: () => Date }) {
    this.#now = options.now ?? (() => new Date());
  }
  availability(): "available" | "upgrade_in_progress" | "upgrade_restart_required" {
    return this.#operation === "upgrading" ? "upgrade_in_progress" : this.#operation === "restart_required" ? "upgrade_restart_required" : "available";
  }
  setUnavailableBarrier(barrier: () => Promise<void>): void { this.#unavailableBarrier = barrier; }
  async plan(): Promise<InstanceUpgradePlan> {
    const inspected = await this.options.target.inspect();
    const checks = [...inspected.checks];
    try { await mkdir(this.options.backupRoot, { recursive: true, mode: 0o700 }); checks.push({ id: "backup", status: "pass", message: "Rollback storage is writable." }); }
    catch { checks.push({ id: "backup", status: "fail", message: "Rollback storage is not writable." }); }
    const status = inspected.currentVersion === this.options.targetVersion ? "current" : checks.some((check) => check.status === "fail") ? "blocked" : "ready";
    return { status, currentVersion: inspected.currentVersion, targetVersion: this.options.targetVersion, checks };
  }
  async upgrade(): Promise<{ status: "upgraded"; fromVersion: string; targetVersion: string; restartRequired: true }> {
    if (this.#operation !== "idle") throw new Error("an Instance upgrade is already running");
    const plan = await this.plan();
    if (plan.status !== "ready") throw new Error(plan.status === "current" ? "Instance is already current" : "upgrade preflight failed");
    this.#operation = "upgrading";
    const name = `pre-upgrade-${plan.currentVersion}-to-${plan.targetVersion}-${this.#now().toISOString().replaceAll(":", "-")}`;
    const backupPath = join(this.options.backupRoot, name);
    try {
      await this.#unavailableBarrier();
      await this.options.backups.create(backupPath);
      try { await this.options.target.apply(plan.currentVersion, plan.targetVersion); }
      catch (error) {
        try { await this.options.target.rollback(backupPath); }
        catch (rollbackError) { this.#operation = "restart_required"; throw new AggregateError([error, rollbackError], "upgrade failed and rollback failed"); }
        this.#operation = "idle"; throw new Error("upgrade failed and was rolled back", { cause: error });
      }
      this.#operation = "restart_required";
      return { status: "upgraded", fromVersion: plan.currentVersion, targetVersion: plan.targetVersion, restartRequired: true };
    } catch (error) { if (this.#operation === "upgrading") this.#operation = "idle"; throw error; }
  }
}

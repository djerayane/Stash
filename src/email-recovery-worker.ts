import { randomUUID } from "node:crypto";
import type { AuthenticationSecretCodec } from "./authentication-secrets.js";
import { deriveEmailRecoveryLookup, type AccountRecoveryRepository, type RecoveryEmailSender } from "./account-recovery.js";

type DeliveryRepository = Pick<AccountRecoveryRepository, "claimEmailRecoveryDelivery" | "renewEmailRecoveryDelivery" | "completeEmailRecoveryDelivery" | "retryEmailRecoveryDelivery">;

export class EmailRecoveryWorker {
  readonly #owner = randomUUID();
  constructor(
    readonly repository: DeliveryRepository,
    readonly secrets: AuthenticationSecretCodec,
    readonly sender: RecoveryEmailSender,
    readonly leaseMilliseconds = 30_000,
    readonly now: () => number = Date.now,
  ) {}

  async processNext(): Promise<"idle" | "dummy_completed" | "delivered" | "retry_scheduled" | "stale_claim"> {
    const job = await this.repository.claimEmailRecoveryDelivery(this.#owner, this.#leaseUntil());
    if (!job || job.claimVersion === undefined) return "idle";
    let claimCurrent = true;
    const heartbeat = setInterval(() => {
      void this.repository.renewEmailRecoveryDelivery(job.id, this.#owner, job.claimVersion!, this.#leaseUntil())
        .then((renewed) => { if (!renewed) claimCurrent = false; })
        .catch(() => { claimCurrent = false; });
    }, Math.max(10, Math.floor(this.leaseMilliseconds / 3)));
    heartbeat.unref();
    try {
      const delivery = JSON.parse(this.secrets.decrypt(job.protectedDelivery)) as { accountId?: unknown; address?: unknown; token?: unknown; dummy?: unknown };
      if (delivery.dummy === true) {
        clearInterval(heartbeat);
        return await this.repository.completeEmailRecoveryDelivery(job.id, this.#owner, job.claimVersion) ? "dummy_completed" : "stale_claim";
      }
      if (typeof delivery.accountId !== "string" || typeof delivery.address !== "string" || typeof delivery.token !== "string") throw new Error("invalid protected email recovery delivery");
      await this.sender.deliver(delivery.address, delivery.token);
      clearInterval(heartbeat);
      if (!claimCurrent) return "stale_claim";
      const completedAt = this.now();
      const activated = await this.repository.completeEmailRecoveryDelivery(job.id, this.#owner, job.claimVersion, {
        accountId: delivery.accountId,
        tokenLookup: deriveEmailRecoveryLookup(delivery.token),
        protectedSecret: this.secrets.encrypt(delivery.token),
        expiresAt: new Date(completedAt + 15 * 60_000).toISOString(),
      });
      return activated ? "delivered" : "stale_claim";
    } catch (error) {
      clearInterval(heartbeat);
      if (!claimCurrent) return "stale_claim";
      const reason = error instanceof Error ? error.message : "unknown email recovery delivery failure";
      return await this.repository.retryEmailRecoveryDelivery(job.id, this.#owner, job.claimVersion, reason) ? "retry_scheduled" : "stale_claim";
    }
  }

  #leaseUntil() { return new Date(this.now() + this.leaseMilliseconds).toISOString(); }
}

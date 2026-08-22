import type { AuthenticationSecretCodec } from "./authentication-secrets.js";
import type { AccountRecoveryRepository, RecoveryEmailSender } from "./account-recovery.js";

export class EmailRecoveryWorker {
  constructor(
    readonly repository: Pick<AccountRecoveryRepository, "nextEmailRecoveryDelivery" | "completeEmailRecoveryDelivery" | "retryEmailRecoveryDelivery">,
    readonly secrets: AuthenticationSecretCodec,
    readonly sender: RecoveryEmailSender,
  ) {}

  async processNext(): Promise<"idle" | "dummy_completed" | "delivered" | "retry_scheduled"> {
    const job = await this.repository.nextEmailRecoveryDelivery();
    if (!job) return "idle";
    try {
      const delivery = JSON.parse(this.secrets.decrypt(job.protectedDelivery)) as { address?: unknown; token?: unknown; dummy?: unknown };
      if (delivery.dummy === true) {
        await this.repository.completeEmailRecoveryDelivery(job.id);
        return "dummy_completed";
      }
      if (typeof delivery.address !== "string" || typeof delivery.token !== "string") throw new Error("invalid protected email recovery delivery");
      await this.sender.deliver(delivery.address, delivery.token);
      await this.repository.completeEmailRecoveryDelivery(job.id);
      return "delivered";
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown email recovery delivery failure";
      await this.repository.retryEmailRecoveryDelivery(job.id, reason);
      return "retry_scheduled";
    }
  }
}

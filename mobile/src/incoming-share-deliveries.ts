export interface IncomingShareValue {
  value: string;
  shareType: string;
  mimeType?: string;
}

export interface IncomingShareDelivery<T extends IncomingShareValue = IncomingShareValue> {
  id: string;
  payload: T;
}

export function incomingShareFingerprint(payloads: IncomingShareValue[]): string {
  return JSON.stringify(payloads.map(({ value, shareType, mimeType }) => [value, shareType, mimeType ?? ""]));
}

export function isTerminalIncomingShareError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return /invalid|empty|not supported|larger than the 10 MB limit|filename/i.test(message);
}

export async function drainIncomingShares(
  store: EncryptedMobileCaptureStore,
  consume: (delivery: DurableIncomingShareDelivery) => Promise<void>,
): Promise<void> {
  for (const delivery of await store.listIncomingShares()) {
    if (delivery.status === "quarantined") continue;
    try {
      await consume(delivery);
      await store.removeIncomingShare(delivery.id);
    } catch (error) {
      await store.saveIncomingShare({ ...delivery, status: isTerminalIncomingShareError(error) ? "quarantined" : "retry_pending",
        lastError: error instanceof Error ? error.message : "Shared content could not be saved." });
    }
  }
}

export class SerializedIncomingShareDrain {
  #active: Promise<void> | undefined;
  #rerun = false;
  constructor(readonly drain: () => Promise<void>, readonly onError: (error: unknown) => void) {}
  request(): Promise<void> {
    this.#rerun = true;
    if (this.#active) return this.#active;
    const active = (async () => {
      try {
        while (this.#rerun) {
          this.#rerun = false;
          try { await this.drain(); } catch (error) { this.onError(error); }
        }
      } finally { this.#active = undefined; }
    })();
    this.#active = active;
    return active;
  }
}

/** Stages OS invocation batches so the native slot can be acknowledged immediately. */
export class IncomingShareDeliveryBatch<T extends IncomingShareValue = IncomingShareValue> {
  readonly #createId: () => string;
  #deliveries: IncomingShareDelivery<T>[] = [];

  constructor(createId: () => string = () => crypto.randomUUID()) { this.#createId = createId; }

  receiveInvocation(payloads: T[]): IncomingShareDelivery<T>[] {
    this.#deliveries.push(...payloads.map((payload) => ({ id: this.#createId(), payload })));
    return this.pending();
  }

  acknowledge(id: string): boolean {
    this.#deliveries = this.#deliveries.filter((delivery) => delivery.id !== id);
    return this.#deliveries.length === 0;
  }

  pending(): IncomingShareDelivery<T>[] { return [...this.#deliveries]; }
}
import type { EncryptedMobileCaptureStore, IncomingShareDelivery as DurableIncomingShareDelivery } from "../../src/mobile-capture-client";

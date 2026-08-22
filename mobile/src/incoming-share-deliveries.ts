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

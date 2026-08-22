export interface IncomingShareValue {
  value: string;
  shareType: string;
  mimeType?: string;
}

export interface IncomingShareDelivery<T extends IncomingShareValue = IncomingShareValue> {
  id: string;
  payload: T;
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

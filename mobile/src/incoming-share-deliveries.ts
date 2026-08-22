export interface IncomingShareValue {
  value: string;
  shareType: string;
  mimeType?: string;
}

export interface IncomingShareDelivery<T extends IncomingShareValue = IncomingShareValue> {
  id: string;
  payload: T;
}

/** Keeps one OS delivery batch stable until every item has been acknowledged. */
export class IncomingShareDeliveryBatch<T extends IncomingShareValue = IncomingShareValue> {
  readonly #createId: () => string;
  #deliveries: IncomingShareDelivery<T>[] = [];

  constructor(createId: () => string = () => crypto.randomUUID()) { this.#createId = createId; }

  receive(payloads: T[]): IncomingShareDelivery<T>[] {
    if (!this.#deliveries.length && payloads.length) {
      this.#deliveries = payloads.map((payload) => ({ id: this.#createId(), payload }));
    }
    return this.pending();
  }

  acknowledge(id: string): boolean {
    this.#deliveries = this.#deliveries.filter((delivery) => delivery.id !== id);
    return this.#deliveries.length === 0;
  }

  pending(): IncomingShareDelivery<T>[] { return [...this.#deliveries]; }
  reset(): void { this.#deliveries = []; }
}

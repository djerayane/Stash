import type { EncryptedMobileCaptureStore, IncomingShareDelivery, MobileCapture, MobileCaptureOptions, MobileCapturePairing } from "../../src/mobile-capture-client";

export interface MobileCipher { encrypt(plaintext: string): Promise<string>; decrypt(ciphertext: string): Promise<string> }
export interface CiphertextStateRepository { read(key: string): Promise<string | undefined>; write(key: string, ciphertext: string): Promise<void> }
const pairingKey = "pairing"; const outboxKey = "outbox"; const optionsKey = "options";
const incomingSharesKey = "incoming-shares";
type IncomingShareState = { pending: IncomingShareDelivery[]; native?: { fingerprint: string; ids: string[] } };

export class EncryptedStateMobileCaptureStore implements EncryptedMobileCaptureStore {
  #writeBarrier: Promise<void> = Promise.resolve();
  constructor(readonly repository: CiphertextStateRepository, readonly cipher: MobileCipher) {}
  loadPairing() { return this.#read<MobileCapturePairing | undefined>(pairingKey, undefined); }
  savePairing(pairing: MobileCapturePairing) { return this.#write(pairingKey, pairing); }
  async listCaptures() { await this.#writeBarrier; return this.#read<MobileCapture[]>(outboxKey, []); }
  async saveCapture(capture: MobileCapture) { await this.#mutate((items) => [...items.filter(({ id }) => id !== capture.id), capture]); }
  async removeCapture(id: string) { await this.#mutate((items) => items.filter((capture) => capture.id !== id)); }
  async loadOptions(scope: string) {
    await this.#writeBarrier;
    return (await this.#read<Record<string, MobileCaptureOptions>>(optionsKey, {}))[scope]
      ?? { projects: [], tags: [], reminders: [] };
  }
  async saveOptions(scope: string, options: MobileCaptureOptions) {
    const write = this.#writeBarrier.then(async () => {
      const scoped = await this.#read<Record<string, MobileCaptureOptions>>(optionsKey, {});
      await this.#write(optionsKey, { ...scoped, [scope]: options });
    });
    this.#writeBarrier = write.catch(() => undefined); await write;
  }
  async stageIncomingShares(fingerprint: string, deliveries: IncomingShareDelivery[]) {
    return this.#mutateIncoming((state) => {
      if (state.native?.fingerprint === fingerprint) return state;
      return { pending: [...state.pending, ...deliveries], native: { fingerprint, ids: deliveries.map(({ id }) => id) } };
    }).then((state) => state.native?.fingerprint === fingerprint
      ? state.pending.filter(({ id }) => state.native!.ids.includes(id)) : deliveries);
  }
  async acknowledgeNativeShares(fingerprint?: string) {
    await this.#mutateIncoming((state) => !fingerprint || state.native?.fingerprint === fingerprint ? { pending: state.pending } : state);
  }
  async listIncomingShares() { await this.#writeBarrier; return (await this.#read<IncomingShareState>(incomingSharesKey, { pending: [] })).pending; }
  async removeIncomingShare(id: string) { await this.#mutateIncoming((state) => ({ ...state, pending: state.pending.filter((item) => item.id !== id) })); }
  async #read<T>(key: string, fallback: T): Promise<T> {
    const ciphertext = await this.repository.read(key);
    return ciphertext ? JSON.parse(await this.cipher.decrypt(ciphertext)) as T : fallback;
  }
  async #write(key: string, value: unknown) { await this.repository.write(key, await this.cipher.encrypt(JSON.stringify(value))); }
  async #mutate(change: (captures: MobileCapture[]) => MobileCapture[]) {
    const write = this.#writeBarrier.then(async () => this.#write(outboxKey, change(await this.#read(outboxKey, []))));
    this.#writeBarrier = write.catch(() => undefined); await write;
  }
  async #mutateIncoming(change: (state: IncomingShareState) => IncomingShareState) {
    let result: IncomingShareState = { pending: [] };
    const write = this.#writeBarrier.then(async () => {
      result = change(await this.#read(incomingSharesKey, { pending: [] }));
      await this.#write(incomingSharesKey, result);
    });
    this.#writeBarrier = write.catch(() => undefined); await write; return result;
  }
}

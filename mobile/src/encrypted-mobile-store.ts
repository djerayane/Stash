import type { EncryptedMobileCaptureStore, MobileCapture, MobileCaptureOptions, MobileCapturePairing } from "../../src/mobile-capture-client";

export interface MobileCipher { encrypt(plaintext: string): Promise<string>; decrypt(ciphertext: string): Promise<string> }
export interface CiphertextStateRepository { read(key: string): Promise<string | undefined>; write(key: string, ciphertext: string): Promise<void> }
const pairingKey = "pairing"; const outboxKey = "outbox"; const optionsKey = "options";

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
  async #read<T>(key: string, fallback: T): Promise<T> {
    const ciphertext = await this.repository.read(key);
    return ciphertext ? JSON.parse(await this.cipher.decrypt(ciphertext)) as T : fallback;
  }
  async #write(key: string, value: unknown) { await this.repository.write(key, await this.cipher.encrypt(JSON.stringify(value))); }
  async #mutate(change: (captures: MobileCapture[]) => MobileCapture[]) {
    const write = this.#writeBarrier.then(async () => this.#write(outboxKey, change(await this.#read(outboxKey, []))));
    this.#writeBarrier = write.catch(() => undefined); await write;
  }
}

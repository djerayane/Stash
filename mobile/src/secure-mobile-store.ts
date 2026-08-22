import "expo-sqlite/localStorage/install";
import * as SecureStore from "expo-secure-store";

import type {
  EncryptedMobileCaptureStore,
  MobileCapture,
  MobileCaptureOptions,
  MobileCapturePairing,
} from "../../src/mobile-capture-client";

const pairingKey = "stash.mobile.pairing.v1";
const outboxKey = "stash.mobile.outbox.v1";
const optionsKey = "stash.mobile.options.v1";

export class SecureMobileCaptureStore implements EncryptedMobileCaptureStore {
  #writeBarrier: Promise<void> = Promise.resolve();
  async loadPairing() {
    const value = await SecureStore.getItemAsync(pairingKey);
    return value ? JSON.parse(value) as MobileCapturePairing : undefined;
  }
  async savePairing(pairing: MobileCapturePairing) {
    await SecureStore.setItemAsync(pairingKey, JSON.stringify(pairing), { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
  }
  async listCaptures() {
    await this.#writeBarrier;
    return this.#readOutbox();
  }
  async saveCapture(capture: MobileCapture) {
    await this.#mutateOutbox((captures) => [...captures.filter(({ id }) => id !== capture.id), capture]);
  }
  async removeCapture(id: string) {
    await this.#mutateOutbox((captures) => captures.filter((capture) => capture.id !== id));
  }
  async loadOptions() {
    return JSON.parse(localStorage.getItem(optionsKey) ?? '{"projects":[],"tags":[],"reminders":[]}') as MobileCaptureOptions;
  }
  async saveOptions(options: MobileCaptureOptions) { localStorage.setItem(optionsKey, JSON.stringify(options)); }

  async #readOutbox(): Promise<MobileCapture[]> {
    return JSON.parse((await SecureStore.getItemAsync(outboxKey)) ?? "[]") as MobileCapture[];
  }

  async #mutateOutbox(change: (captures: MobileCapture[]) => MobileCapture[]) {
    const write = this.#writeBarrier.then(async () => {
      const captures = await this.#readOutbox();
      await SecureStore.setItemAsync(outboxKey, JSON.stringify(change(captures)), {
        keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      });
    });
    this.#writeBarrier = write.catch(() => undefined);
    await write;
  }
}

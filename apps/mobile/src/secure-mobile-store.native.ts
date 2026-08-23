import { AESEncryptionKey, AESSealedData, aesDecryptAsync, aesEncryptAsync } from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import * as SQLite from "expo-sqlite";
import { EncryptedStateMobileCaptureStore, type CiphertextStateRepository, type MobileCipher } from "./encrypted-mobile-store";

const encryptionKeyName = "stash.mobile.encryption-key.v1";
let platformEncryptionKey: Promise<AESEncryptionKey> | undefined;
class SQLiteCiphertextRepository implements CiphertextStateRepository {
  readonly database = SQLite.openDatabaseAsync("stash-mobile-capture.db");
  async #ready() { const db = await this.database; await db.execAsync("CREATE TABLE IF NOT EXISTS encrypted_mobile_state (state_key TEXT PRIMARY KEY, ciphertext TEXT NOT NULL)"); return db; }
  async read(key: string) { return (await (await this.#ready()).getFirstAsync<{ ciphertext: string }>("SELECT ciphertext FROM encrypted_mobile_state WHERE state_key = ?", key))?.ciphertext; }
  async write(key: string, ciphertext: string) { await (await this.#ready()).runAsync("INSERT INTO encrypted_mobile_state (state_key, ciphertext) VALUES (?, ?) ON CONFLICT(state_key) DO UPDATE SET ciphertext = excluded.ciphertext", key, ciphertext); }
}
class PlatformBackedAesCipher implements MobileCipher {
  async #loadKey() { return platformEncryptionKey ??= (async () => { const existing = await SecureStore.getItemAsync(encryptionKeyName); if (existing) return AESEncryptionKey.import(existing, "base64"); const key = await AESEncryptionKey.generate(); await SecureStore.setItemAsync(encryptionKeyName, await key.encoded("base64"), { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }); return key; })(); }
  async encrypt(value: string) { return (await aesEncryptAsync(new TextEncoder().encode(value), await this.#loadKey())).combined("base64") as Promise<string>; }
  async decrypt(value: string) { return new TextDecoder().decode(await aesDecryptAsync(AESSealedData.fromCombined(value), await this.#loadKey()) as Uint8Array); }
}
export class SecureMobileCaptureStore extends EncryptedStateMobileCaptureStore { constructor() { super(new SQLiteCiphertextRepository(), new PlatformBackedAesCipher()); } }

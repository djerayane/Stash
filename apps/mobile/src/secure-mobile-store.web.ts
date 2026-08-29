import { AESEncryptionKey, AESSealedData, aesDecryptAsync, aesEncryptAsync } from "expo-crypto";
import { EncryptedStateMobileCaptureStore, type CiphertextStateRepository, type MobileCipher } from "./encrypted-mobile-store";

// Deliberately tab-memory-only: neither key nor ciphertext enters browser storage.
const sessionKey = AESEncryptionKey.generate();
const sessionCiphertext = new Map<string, string>();
class SessionRepository implements CiphertextStateRepository {
  async read(key: string) { return sessionCiphertext.get(key); }
  async write(key: string, value: string) { sessionCiphertext.set(key, value); }
}
class SessionCipher implements MobileCipher {
  async encrypt(value: string) { return (await aesEncryptAsync(new TextEncoder().encode(value), await sessionKey)).combined("base64") as Promise<string>; }
  async decrypt(value: string) { return new TextDecoder().decode(await aesDecryptAsync(AESSealedData.fromCombined(value), await sessionKey) as Uint8Array); }
}
const processRepository = new SessionRepository();
const processCipher = new SessionCipher();
export class SecureMobileCaptureStore extends EncryptedStateMobileCaptureStore { constructor() { super(processRepository, processCipher); } }

import { createPublicKey, verify } from "node:crypto";
import type { PasskeyRecord, PasskeyVerifier } from "./account-recovery.js";

export class PublicKeyPasskeyVerifier implements PasskeyVerifier {
  async register(challenge: string, input: Record<string, unknown>) {
    if (typeof input.credentialId !== "string" || input.credentialId.length < 1 || input.credentialId.length > 1024
      || typeof input.publicKey !== "string" || input.publicKey.length > 16_384
      || input.challenge !== challenge) throw new Error("invalid passkey registration");
    createPublicKey(input.publicKey);
    return { credentialId: input.credentialId, publicKey: input.publicKey };
  }

  async authenticate(challenge: string, input: Record<string, unknown>, passkey: PasskeyRecord) {
    if (typeof input.signature !== "string" || input.challenge !== challenge) return false;
    try {
      return verify(null, Buffer.from(challenge), createPublicKey(passkey.publicKey), Buffer.from(input.signature, "base64url"));
    } catch { return false; }
  }
}

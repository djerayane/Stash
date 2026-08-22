import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

export interface AuthenticationSecretCodec {
  encrypt(value: string): string;
  decrypt(value: string): string;
  blindIndex(value: string): string;
}

const authenticationKeyCheckValue = "stash-instance-authentication-key-v1";

export function createAuthenticationKeyCheck(codec: AuthenticationSecretCodec): string {
  return codec.encrypt(authenticationKeyCheckValue);
}

export function verifyAuthenticationKeyCheck(
  codec: AuthenticationSecretCodec,
  encryptedKeyCheck: string,
): void {
  try {
    if (codec.decrypt(encryptedKeyCheck) !== authenticationKeyCheckValue) throw new Error();
  } catch {
    throw new Error("INSTANCE_MASTER_KEY does not match this Instance's authentication state");
  }
}

export function createAuthenticationSecretCodec(encodedMasterKey: string): AuthenticationSecretCodec {
  let masterKey: Buffer;
  try {
    masterKey = Buffer.from(encodedMasterKey, "base64");
  } catch {
    throw new Error("INSTANCE_MASTER_KEY must be a base64-encoded 32-byte key");
  }
  if (masterKey.length !== 32 || masterKey.toString("base64") !== encodedMasterKey) {
    throw new Error("INSTANCE_MASTER_KEY must be a base64-encoded 32-byte key");
  }
  return {
    encrypt(value) {
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", masterKey, nonce);
      const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return `v1.${nonce.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${ciphertext.toString("base64url")}`;
    },
    decrypt(value) {
      const [version, nonceValue, tagValue, ciphertextValue] = value.split(".");
      if (version !== "v1" || !nonceValue || !tagValue || !ciphertextValue) throw new Error("invalid encrypted authentication material");
      const decipher = createDecipheriv("aes-256-gcm", masterKey, Buffer.from(nonceValue, "base64url"));
      decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
      return Buffer.concat([decipher.update(Buffer.from(ciphertextValue, "base64url")), decipher.final()]).toString("utf8");
    },
    blindIndex(value) {
      return createHmac("sha256", masterKey).update(`stash-session-v1:${value}`).digest("base64");
    },
  };
}

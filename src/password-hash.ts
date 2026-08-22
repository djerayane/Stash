import { randomBytes, scrypt as nodeScrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(nodeScrypt);

export interface PasswordHashCodec {
  hash(password: string): Promise<string>;
  matches(password: string, encoded: string): Promise<boolean>;
}

export const passwordHashCodec: PasswordHashCodec = {
  async hash(password) {
    const salt = randomBytes(16);
    const derivedKey = (await scrypt(password, salt, 64)) as Buffer;
    return `scrypt$${salt.toString("base64")}$${derivedKey.toString("base64")}`;
  },
  async matches(password, encoded) {
    const [algorithm, saltValue, keyValue] = encoded.split("$");
    if (algorithm !== "scrypt" || !saltValue || !keyValue) return false;
    try {
      const expected = Buffer.from(keyValue, "base64");
      const actual = (await scrypt(password, Buffer.from(saltValue, "base64"), expected.length)) as Buffer;
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    } catch {
      return false;
    }
  },
};

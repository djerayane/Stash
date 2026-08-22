import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createAuthenticationSecretCodec } from "../src/authentication-secrets.js";

describe("Instance authentication secret boundary", () => {
  it("encrypts authentication material and produces a keyed session lookup value", () => {
    const codec = createAuthenticationSecretCodec(Buffer.alloc(32, 7).toString("base64"));
    const passwordHash = "scrypt$salt$derived-secret";
    const encrypted = codec.encrypt(passwordHash);

    assert.notEqual(encrypted, passwordHash);
    assert.equal(codec.decrypt(encrypted), passwordHash);
    assert.equal(codec.blindIndex("session-token-hash"), codec.blindIndex("session-token-hash"));
    assert.doesNotMatch(codec.blindIndex("session-token-hash"), /session-token-hash/);
  });

  it("fails safely when the externally stored Instance master key is invalid", () => {
    assert.throws(
      () => createAuthenticationSecretCodec("development-secret"),
      /INSTANCE_MASTER_KEY must be a base64-encoded 32-byte key/,
    );
  });

  it("rejects authentication material encrypted under another Instance key", () => {
    const first = createAuthenticationSecretCodec(Buffer.alloc(32, 1).toString("base64"));
    const second = createAuthenticationSecretCodec(Buffer.alloc(32, 2).toString("base64"));
    assert.throws(() => second.decrypt(first.encrypt("password-hash")));
  });
});

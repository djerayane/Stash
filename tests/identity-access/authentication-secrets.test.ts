import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createAuthenticationKeyCheck,
  createAuthenticationSecretCodec,
  verifyAuthenticationKeyCheck,
} from "../../src/authentication-secrets.js";

describe("Instance authentication secret boundary", () => {
  it("binds protected authentication envelopes and blind lookups to their purpose", () => {
    const codec = createAuthenticationSecretCodec(Buffer.alloc(32, 9).toString("base64"));
    const protectedInvitation = codec.encrypt("one-time-token", "invitation-v1");
    assert.equal(codec.decrypt(protectedInvitation, "invitation-v1"), "one-time-token");
    assert.throws(() => codec.decrypt(protectedInvitation, "session-v1"));
    assert.notEqual(codec.blindIndex("same-value", "invitation-v1"), codec.blindIndex("same-value", "session-v1"));
  });
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

  it("validates a persisted key-check independently of whether accounts exist", () => {
    const configured = createAuthenticationSecretCodec(Buffer.alloc(32, 3).toString("base64"));
    const wrong = createAuthenticationSecretCodec(Buffer.alloc(32, 4).toString("base64"));
    const persistedKeyCheck = createAuthenticationKeyCheck(configured);

    assert.doesNotThrow(() => verifyAuthenticationKeyCheck(configured, persistedKeyCheck));
    assert.throws(
      () => verifyAuthenticationKeyCheck(wrong, persistedKeyCheck),
      /INSTANCE_MASTER_KEY does not match this Instance's authentication state/,
    );
  });
});

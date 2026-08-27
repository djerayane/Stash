import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveWebAuthnConfiguration } from "../../src/passkey-verifier.js";

describe("production WebAuthn relying-party configuration", () => {
  it("derives the RP ID from PUBLIC_ORIGIN when Compose supplies no override", () => {
    assert.deepEqual(resolveWebAuthnConfiguration("https://stash.example.com", { rpId: "" }), {
      rpId: "stash.example.com",
      rpName: "Stash",
      expectedOrigin: "https://stash.example.com",
    });
  });

  it("honors an explicit operator RP ID override", () => {
    assert.equal(
      resolveWebAuthnConfiguration("https://app.example.com", { rpId: "example.com" }).rpId,
      "example.com",
    );
  });
});

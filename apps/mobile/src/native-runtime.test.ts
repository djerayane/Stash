import { describe, expect, it } from "vitest";

import { ensureCryptoRandomUuid, ensureDomException } from "./native-runtime";

describe("native runtime compatibility", () => {
  it("installs an Error-compatible DOMException fallback with the requested name", () => {
    const runtime: { DOMException?: new (message?: string, name?: string) => Error } = {};

    ensureDomException(runtime);

    const error = new runtime.DOMException!("Request cancelled", "AbortError");
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("Request cancelled");
    expect(error.name).toBe("AbortError");
  });

  it("installs the native secure UUID source when Hermes has no global crypto", () => {
    const runtime: { crypto?: { randomUUID?: () => string } } = {};

    ensureCryptoRandomUuid(runtime, () => "11111111-1111-4111-8111-111111111111");

    expect(runtime.crypto?.randomUUID?.()).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("preserves a runtime UUID source that is already available", () => {
    const existing = () => "22222222-2222-4222-8222-222222222222";
    const runtime = { crypto: { randomUUID: existing } };

    ensureCryptoRandomUuid(runtime, () => "11111111-1111-4111-8111-111111111111");

    expect(runtime.crypto.randomUUID).toBe(existing);
  });
});

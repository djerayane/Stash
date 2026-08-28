import { describe, expect, it } from "vitest";

import { ensureDomException } from "./native-runtime";

describe("native runtime compatibility", () => {
  it("installs an Error-compatible DOMException fallback with the requested name", () => {
    const runtime: { DOMException?: new (message?: string, name?: string) => Error } = {};

    ensureDomException(runtime);

    const error = new runtime.DOMException!("Request cancelled", "AbortError");
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("Request cancelled");
    expect(error.name).toBe("AbortError");
  });
});

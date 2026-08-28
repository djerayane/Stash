import { describe, expect, it } from "vitest";

import { stashTheme } from "./theme";

describe("Stash mobile theme", () => {
  it("uses the shared Stash semantics instead of platform blue", () => {
    expect(stashTheme.colors.canvas).toBe("#f4f1e9");
    expect(stashTheme.colors.surface).toBe("#fffdf8");
    expect(stashTheme.colors.ink).toBe("#181a18");
    expect(stashTheme.colors.accent).toBe("#bf381f");
    expect(stashTheme.colors.accent).not.toBe("#2463eb");
  });

  it("keeps interactive controls large enough to target", () => {
    expect(stashTheme.controlHeight).toBeGreaterThanOrEqual(44);
  });
});

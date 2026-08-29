import type { MobileSyncResult } from "@stash/domain-types";
import { describe, expect, it } from "vitest";

import { presentMobileSyncResult } from "./sync-status";

describe("presentMobileSyncResult", () => {
  it.each<[string, MobileSyncResult, "waiting" | "synchronized" | "attention"]>([
    ["offline", { status: "offline", count: 0 }, "waiting"],
    ["retry", { status: "retry_pending", count: 0 }, "waiting"],
    ["synchronized", { status: "synced", count: 1 }, "synchronized"],
    ["preserved conflict", { status: "attention_required", count: 1, error: "conflicts_preserved" }, "attention"],
  ])("returns a typed %s presentation", (_name, result, variant) => {
    expect(presentMobileSyncResult(result, []).variant).toBe(variant);
  });
});

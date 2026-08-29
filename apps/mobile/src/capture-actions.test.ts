import { describe, expect, it } from "vitest";

import { discardQuarantinedIncomingShares } from "./capture-actions";

describe("discardQuarantinedIncomingShares", () => {
  it("removes only blocked deliveries and returns a settled saved presentation", async () => {
    const deliveries = [
      { id: "blocked", status: "quarantined" as const },
      { id: "waiting", status: "retry_pending" as const },
    ];
    const removed: string[] = [];

    const result = await discardQuarantinedIncomingShares({
      async listIncomingShares() { return deliveries; },
      async removeIncomingShare(id: string) { removed.push(id); },
    });

    expect(removed).toEqual(["blocked"]);
    expect(result).toEqual({ variant: "saved", message: "Blocked shared items discarded." });
  });
});

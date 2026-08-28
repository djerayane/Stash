import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { MobileStatusNotice, mobileStatusVariantForMessage } from "./mobile-status-notice";

afterEach(cleanup);

describe("MobileStatusNotice", () => {
  it("names the saved-on-device state without implying synchronization", () => {
    render(<MobileStatusNotice variant="saved" />);
    expect(screen.getByRole("status").textContent).toContain("Saved on this device");
  });

  it("maps synchronization messages to distinct semantic states", () => {
    expect(mobileStatusVariantForMessage("Workspace synchronized.")).toBe("synchronized");
    expect(mobileStatusVariantForMessage("Saved securely. Synchronization will retry.")).toBe("waiting");
    expect(mobileStatusVariantForMessage("One shared item needs attention.")).toBe("attention");
    expect(mobileStatusVariantForMessage("The capture could not be saved.")).toBe("error");
  });
});

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { MobileStatusNotice } from "./mobile-status-notice";

afterEach(cleanup);

describe("MobileStatusNotice", () => {
  it("names the saved-on-device state without implying synchronization", () => {
    render(<MobileStatusNotice variant="saved" />);
    expect(screen.getByRole("status").textContent).toContain("Saved on this device");
  });

  it("uses Sage only for settled synchronization and a neutral marker while waiting", () => {
    const { rerender } = render(<MobileStatusNotice variant="synchronized" />);
    expect(getComputedStyle(screen.getByTestId("mobile-status-marker")).backgroundColor).toBe("rgb(146, 155, 136)");

    rerender(<MobileStatusNotice variant="waiting" />);
    expect(getComputedStyle(screen.getByTestId("mobile-status-marker")).backgroundColor).toBe("rgb(98, 100, 95)");
  });
});

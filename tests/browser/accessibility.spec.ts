import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("the primary shell has no automatically detectable accessibility violations @a11y", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("stash.member-session", JSON.stringify({
    token: "browser-acceptance-member-token",
    member: { name: "Browser Member", email: "member@stash.test" },
    workspace: { name: "Acceptance Workspace" },
  })));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/app");
  await expect(page.getByRole("heading", { name: "Good morning." })).toBeVisible();
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

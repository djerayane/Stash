import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("the primary shell has no automatically detectable accessibility violations @a11y", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.getByRole("status")).toHaveText("Instance ready");
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

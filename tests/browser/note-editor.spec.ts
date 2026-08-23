import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const noteId = "99999999-9999-4999-8999-999999999999";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("stash.memberToken", "browser-acceptance-member-token"));
});

test("edits a stable linked Block with the collaborative React editor", async ({ page }) => {
  await page.goto(`/notes/${noteId}`);
  await expect(page.getByRole("heading", { name: "Release collaboration plan" })).toBeVisible();
  const editor = page.getByRole("textbox", { name: "Note content" });
  await expect(editor.locator("[data-block-id='66666666-6666-4666-8666-666666666666']")).toHaveText("Preserve this linked Block");
  await editor.locator("p").click(); await page.keyboard.press("End"); await page.keyboard.type(" after review");
  await expect(page.getByRole("status")).toHaveText("All changes saved");
  await expect(editor.locator("[data-block-id='66666666-6666-4666-8666-666666666666']")).toContainText("after review");
});

test("the collaborative editor is keyboard operable and axe-clean @a11y", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" }); await page.goto(`/notes/${noteId}`);
  await page.getByRole("button", { name: "Bold" }).focus(); await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Bold" })).toHaveAttribute("aria-pressed", "true");
  const results = await new AxeBuilder({ page }).analyze(); expect(results.violations).toEqual([]);
});

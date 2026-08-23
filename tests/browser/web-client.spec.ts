import { expect, test } from "@playwright/test";

test("navigates the built client through the running Instance", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("status")).toHaveText("Instance ready");
  await page.getByRole("link", { name: "Notes" }).click();
  await expect(page).toHaveURL(/\/notes$/);
  await expect(page.getByRole("link", { name: "Notes" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("link", { name: "Administration" })).toHaveCount(0);
});

test("supports keyboard navigation", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Tasks" }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/tasks$/);
  await expect(page.getByRole("link", { name: "Tasks" })).toBeFocused();
});

test("derives allowed and denied navigation from authenticated Instance permissions", async ({ browser }) => {
  const administrator = await browser.newContext({ extraHTTPHeaders: { authorization: "Bearer browser-acceptance-admin-token" } });
  const administratorPage = await administrator.newPage();
  await administratorPage.goto("/");
  await expect(administratorPage.getByRole("link", { name: "Administration" })).toBeVisible();
  await administrator.close();

  const member = await browser.newContext({ extraHTTPHeaders: { authorization: "Bearer browser-acceptance-member-token" } });
  const memberPage = await member.newPage();
  await memberPage.goto("/");
  await expect(memberPage.getByRole("link", { name: "Administration" })).toHaveCount(0);
  await member.close();
});

test("removes motion under the Member's reduced-motion preference", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");
  const notes = page.getByRole("link", { name: "Notes" });
  await expect(notes).toHaveCSS("transition-duration", "0.16s, 0.16s");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(notes).toHaveCSS("transition-duration", "0s");
});

test("announces an error, focuses it, and recovers without a page reload", async ({ page }) => {
  await page.route("**/health/ready", (route) => route.fulfill({ status: 503, contentType: "application/json", body: '{"status":"unavailable"}' }));
  await page.goto("/");
  const error = page.getByRole("alert");
  await expect(error).toBeFocused();
  await page.unroute("**/health/ready");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("status")).toHaveText("Instance ready");
});

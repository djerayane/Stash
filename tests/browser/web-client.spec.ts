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

test("announces an error, focuses it, and recovers without a page reload", async ({ page }) => {
  await page.route("**/health/ready", (route) => route.fulfill({ status: 503, contentType: "application/json", body: '{"status":"unavailable"}' }));
  await page.goto("/");
  const error = page.getByRole("alert");
  await expect(error).toBeFocused();
  await page.unroute("**/health/ready");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("status")).toHaveText("Instance ready");
});

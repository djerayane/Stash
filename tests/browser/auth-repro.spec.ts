import { expect, test } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";

test("a signed-out visitor can reach built-in account creation", async ({ page }) => {
  await page.goto("/sign-in");

  await expect(page.getByRole("link", { name: "Create an account" })).toBeVisible({ timeout: 2_000 });
});

test("a built-in password account can sign in", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByRole("textbox", { name: "Email" }).fill("member@stash.test");
  await page.getByLabel("Password", { exact: true }).fill("correct horse battery staple");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page).toHaveURL(/\/app$/, { timeout: 2_000 });
});

test("distinguishes invalid credentials from authentication infrastructure failures", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByRole("textbox", { name: "Email" }).fill("member@stash.test");
  await page.getByLabel("Password", { exact: true }).fill("incorrect password value");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toHaveText("The email or password is incorrect.");

  await page.route("**/api/auth/sessions", (route) => route.fulfill({ status: 503, contentType: "application/json",
    body: JSON.stringify({ error: "authentication_unavailable", message: "Authentication is temporarily unavailable. Try again." }) }));
  await page.getByLabel("Password", { exact: true }).fill("correct horse battery staple");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toHaveText("Authentication is temporarily unavailable. Try again.");
});

test("a newly registered account can sign in", async ({ page }) => {
  await page.goto("/sign-up");
  await page.getByRole("textbox", { name: "Name" }).fill("New Member");
  await page.getByRole("textbox", { name: "Email" }).fill("new-member@stash.test");
  await page.getByLabel("Password", { exact: true }).fill("correct horse battery staple");
  await page.getByLabel("Confirm password").fill("correct horse battery staple");
  await page.getByRole("button", { name: "Create account" }).click();

  await expect(page).toHaveURL(/\/app$/);
  await page.evaluate(() => localStorage.removeItem("stash.member-session"));
  await page.goto("/sign-in");
  await page.getByRole("textbox", { name: "Email" }).fill("new-member@stash.test");
  await page.getByLabel("Password", { exact: true }).fill("correct horse battery staple");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page).toHaveURL(/\/app$/);
});

test("signup is accessible by keyboard and assistive technology @a11y", async ({ page }) => {
  await page.goto("/sign-up");
  await expect(page.getByRole("heading", { name: "Create an account" })).toBeVisible();
  await page.getByRole("textbox", { name: "Name" }).focus();
  await expect(page.getByRole("textbox", { name: "Name" })).toBeFocused();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

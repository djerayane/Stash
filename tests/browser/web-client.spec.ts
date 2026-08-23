import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const memberSession = JSON.stringify({
  token: "browser-acceptance-member-token",
  member: { name: "Browser Member", email: "member@stash.test" },
  workspace: { name: "Acceptance Workspace" },
});

async function installMemberSession(page: Page) {
  await page.addInitScript((session) => localStorage.setItem("stash.member-session", session), memberSession);
}

test("restores an anonymous deep link after authentication", async ({ page }) => {
  await page.goto("/app/tasks?assigned=me");
  await expect(page.getByRole("heading", { name: "Sign in to Stash" })).toBeVisible();
  await expect(page).toHaveURL(/\/sign-in\?returnTo=%2Fapp%2Ftasks%3Fassigned%3Dme$/);

  await page.evaluate((session) => localStorage.setItem("stash.member-session", session), memberSession);
  await page.reload();

  await expect(page).toHaveURL(/\/app\/tasks\?assigned=me$/);
  await expect(page.getByRole("heading", { name: "Tasks", exact: true })).toBeVisible();
});

test("supports keyboard navigation and focuses changed route content", async ({ page }) => {
  await installMemberSession(page);
  await page.goto("/app");
  const activity = page.getByRole("link", { name: "Activity" });
  await activity.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/app\/activity$/);
  await expect(page.getByRole("heading", { name: "Activity", exact: true })).toBeVisible();
  await expect(page.getByRole("main")).toBeFocused();
});

test("keeps unavailable actions non-interactive and navigates every available shell action", async ({ page }) => {
  await installMemberSession(page);
  await page.goto("/app/tasks");
  await expect(page.getByRole("button")).toHaveCount(0);
  await expect(page.getByText("New task")).toBeVisible();
  await page.getByRole("link", { name: "New note" }).click();
  await expect(page).toHaveURL(/\/app\/notes\/new$/);
  await page.goto("/app/missing");
  await page.getByRole("link", { name: "Go home" }).click();
  await expect(page).toHaveURL(/\/app$/);
});

test("uses the responsive bottom navigation at a true narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installMemberSession(page);
  await page.goto("/app");

  const navigation = page.getByRole("navigation", { name: "Workspace" });
  await expect(navigation).toBeVisible();
  await expect(page.getByRole("link", { name: "Stash home" })).toBeHidden();
  const sidebar = navigation.locator("xpath=ancestor::aside");
  await expect(sidebar).toHaveCSS("position", "fixed");
  const box = await sidebar.boundingBox();
  expect(box).not.toBeNull();
  expect(Math.abs((box!.y + box!.height) - 844)).toBeLessThanOrEqual(1);
  await expect(page.getByRole("link", { name: "Tasks" })).toBeVisible();
});

test("removes functional motion under the Member's reduced-motion preference", async ({ page }) => {
  await installMemberSession(page);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/app");
  const notes = page.getByRole("link", { name: "Notes" });
  const normalDuration = await notes.evaluate((element) => getComputedStyle(element).transitionDuration);
  expect(Number.parseFloat(normalDuration)).toBeGreaterThan(0.1);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const reducedDuration = await notes.evaluate((element) => getComputedStyle(element).transitionDuration);
  expect(Number.parseFloat(reducedDuration)).toBeLessThan(0.01);
  const pageContent = page.locator("main > div").first();
  await expect(pageContent).toHaveCSS("transform", "none");
  await expect(pageContent).toHaveCSS("opacity", "1");
});

test("announces and focuses a session failure, then retries by keyboard without reloading", async ({ page }) => {
  await installMemberSession(page);
  let sessionAttempts = 0;
  let documentNavigations = 0;
  page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) documentNavigations += 1; });
  await page.route("**/api/client-session", async (route) => {
    sessionAttempts += 1;
    await route.fulfill({ status: sessionAttempts === 1 ? 503 : 200, contentType: "application/json", body: "{}" });
  });
  await page.goto("/app");

  const alert = page.getByRole("alert");
  await expect(alert).toBeVisible();
  await expect(alert).toBeFocused();
  await expect(page.getByRole("main")).toBeVisible();
  await expect(alert).toContainText("The Instance could not be reached.");
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
  documentNavigations = 0;
  await page.getByRole("button", { name: "Try again" }).focus();
  await page.keyboard.press("Enter");

  await expect(page.getByRole("heading", { name: "Good morning." })).toBeVisible();
  expect(sessionAttempts).toBe(2);
  expect(documentNavigations).toBe(0);
});

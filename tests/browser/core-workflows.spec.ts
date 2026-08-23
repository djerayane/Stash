import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const session = JSON.stringify({ token: "browser-acceptance-member-token" });
async function authenticate(page: Page) { await page.addInitScript((value) => localStorage.setItem("stash.member-session", value), session); }

test("captures and triages a Note from the React Inbox without document navigation", async ({ page }) => {
  await authenticate(page); let navigations = 0;
  page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) navigations += 1; });
  await page.goto("/app/inbox"); navigations = 0;
  await page.getByRole("button", { name: "Capture Note" }).focus(); await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Capture a Note" }); await expect(dialog).toBeVisible();
  await dialog.getByRole("textbox", { name: "Note content" }).fill("Release planning notes");
  await dialog.getByRole("button", { name: "Capture", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Release planning notes" })).toBeVisible();
  await page.getByRole("button", { name: "Triage" }).click();
  await page.getByRole("button", { name: "Archive" }).click();
  await expect(page.getByText("Your Inbox is clear")).toBeVisible();
  expect(navigations).toBe(0);
});

test("@a11y exposes accessible core views and keyboard recovery at a narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.emulateMedia({ reducedMotion: "reduce" }); await authenticate(page); let attempts = 0;
  await page.route("**/api/notifications", async (route) => { attempts += 1; await route.fulfill({ status: attempts === 1 ? 503 : 200, json: attempts === 1 ? { message: "Notifications are resting." } : { notifications: [] } }); });
  await page.goto("/app/notifications");
  const alert = page.getByRole("alert"); await expect(alert).toBeFocused();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await alert.getByRole("button", { name: "Try again" }).focus(); await page.keyboard.press("Enter");
  await expect(page.getByText("You are caught up")).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

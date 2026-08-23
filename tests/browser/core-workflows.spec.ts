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

test("keeps topbar actions visible and keyboard focus distinct at a narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await authenticate(page);
  await page.goto("/app/tasks");
  const notifications = page.getByRole("link", { name: "Notifications" });
  await expect(notifications).toBeVisible();
  const search = page.getByRole("searchbox", { name: "Search Workspace" });
  await search.focus();
  const focusRing = await search.locator("..").evaluate((element) => {
    const style = getComputedStyle(element);
    return { style: style.outlineStyle, width: style.outlineWidth };
  });
  expect(focusRing).toEqual({ style: "solid", width: "3px" });
});

test("navigates Notes, Boards, Discussions, notifications, and Activity through the running Instance", async ({ page }) => {
  await authenticate(page);
  await page.goto("/app/notes");
  await expect(page.getByRole("button", { name: /Decision/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /Release collaboration plan/ })).toBeVisible();

  await page.goto("/app/projects/22222222-2222-4222-8222-222222222222/boards/abababab-abab-4bab-8bab-abababababa1");
  const move = page.getByRole("combobox", { name: /Move Task/ }); await move.focus();
  await move.selectOption("done"); await expect(page.getByText("STASH-32 moved.")).toBeAttached();

  await page.goto("/app/notes/99999999-9999-4999-8999-999999999999/discussions");
  await expect(page.getByText("Keep this release context")).toBeVisible();
  await page.getByRole("textbox", { name: "Reply" }).fill("Ship with the rollback note");
  await page.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(page.getByText("Ship with the rollback note")).toBeVisible();
  await page.getByRole("button", { name: "Resolve Discussion" }).click(); await expect(page.getByText("Resolved")).toBeVisible();

  await page.goto("/app/notifications"); await page.getByRole("button", { name: "Mark read" }).click(); await expect(page.getByText("Read", { exact: true })).toBeVisible();
  await page.goto("/app/activity"); await expect(page.getByText("Release plan updated")).toBeVisible();
  const search = page.getByRole("searchbox", { name: "Search Workspace" }); await search.fill("release"); await search.press("Enter");
  await expect(page).toHaveURL(/\/app\/search\?q=release/); await expect(page.getByRole("link", { name: /Release collaboration plan/ })).toBeVisible();
});

test("@a11y keeps every migrated core route free of detectable accessibility violations", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" }); await authenticate(page);
  for (const path of ["/app/inbox", "/app/notes", "/app/tasks", `/app/projects/22222222-2222-4222-8222-222222222222/boards/${"abababab-abab-4bab-8bab-abababababa1"}`, "/app/notes/99999999-9999-4999-8999-999999999999/discussions", "/app/search?q=release", "/app/notifications", "/app/activity"]) {
    await page.goto(path); await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations, path).toEqual([]);
  }
});

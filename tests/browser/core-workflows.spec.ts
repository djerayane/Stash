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
  await page.goto("/app/tasks"); const workspace = page.getByRole("combobox", { name: "Workspace" }); await workspace.focus(); await workspace.selectOption({ label: "Shared Workspace" }); await page.getByRole("button", { name: /Shared roadmap/ }).press("Enter"); await expect(page).toHaveURL(/\/app\/projects\/66666666-6666-4666-8666-666666666665\/boards$/);
  await page.goto("/app/notes");
  await expect(page.getByRole("button", { name: /Decision/ })).toBeVisible();
  const ordinary = page.getByRole("link", { name: /Authoritative second Note/ }); await expect(ordinary).toBeVisible(); await ordinary.click();
  await expect(page).toHaveURL(/\/app\/notes\/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa$/); await expect(page.getByRole("textbox", { name: "Note content" })).toContainText("Authoritative second Note");
  await page.goto("/app/notes");
  await expect(page.getByRole("heading", { name: "All Notes" }).locator("..").getByRole("link", { name: /Release collaboration plan/ })).toBeVisible();

  await page.goto("/app/projects/22222222-2222-4222-8222-222222222222/boards/abababab-abab-4bab-8bab-abababababa1");
  const move = page.getByRole("combobox", { name: /Move Task/ }); await move.focus();
  await move.selectOption("done"); await expect(page.getByText("STASH-32 moved.")).toBeAttached();

  await page.goto("/app/notes/99999999-9999-4999-8999-999999999999/discussions");
  const releaseDiscussion = page.getByText("Keep this release context").locator("xpath=ancestor::article"); await expect(releaseDiscussion).toBeVisible();
  await releaseDiscussion.getByRole("textbox", { name: "Reply" }).fill("Ship with the rollback note");
  await releaseDiscussion.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(releaseDiscussion.getByText("Ship with the rollback note")).toBeVisible();
  await releaseDiscussion.getByRole("button", { name: "Resolve Discussion" }).click(); await expect(releaseDiscussion.getByText("Resolved")).toBeVisible();

  await page.goto("/app/notifications"); await expect(page.getByRole("heading", { name: "Release plan updated" })).toBeVisible(); await expect(page.getByText("followed change · note updated")).toBeVisible(); await page.getByRole("button", { name: "Mark read" }).click(); await expect(page.getByText("Read", { exact: true })).toBeVisible();
  await page.goto("/app/activity"); await expect(page.getByText("note updated")).toBeVisible(); await expect(page.getByText(/Before:.*Draft release plan.*After:.*Release plan/)).toBeVisible();
  const search = page.getByRole("searchbox", { name: "Search Workspace" }); await search.fill("release"); await search.press("Enter");
  await expect(page).toHaveURL(/\/app\/search\?q=release/); await expect(page.getByRole("link", { name: /Release collaboration plan/ })).toBeVisible();
  await search.fill("discussion"); await search.press("Enter"); const discussionResult = page.getByRole("link", { name: /Keep this release context/ }); await expect(discussionResult).toHaveAttribute("href", `/app/notes/99999999-9999-4999-8999-999999999999/discussions`);
});

test("reviews and restores authoritative Note history with keyboard error recovery", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" }); await authenticate(page); let restoreAttempts = 0;
  await page.route("**/api/notes/99999999-9999-4999-8999-999999999999/history/1/restore", async (route) => { restoreAttempts += 1; if (restoreAttempts === 1) await route.fulfill({ status: 503, json: { message: "Restore temporarily unavailable" } }); else await route.continue(); });
  await page.goto("/app/notes"); const historyLink = page.getByRole("link", { name: "View history" }).last(); await historyLink.focus(); await page.keyboard.press("Enter"); await expect(page).toHaveURL(/\/app\/notes\/99999999-9999-4999-8999-999999999999\/history$/);
  await page.getByRole("button", { name: "Review revision" }).first().focus(); await page.keyboard.press("Enter"); const dialog = page.getByRole("dialog", { name: "Restore revision 1" }); await expect(dialog.getByText("Original release plan")).toBeVisible(); expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await dialog.getByRole("button", { name: "Confirm restore" }).click(); const alert = dialog.getByRole("alert"); await expect(alert).toBeFocused(); await dialog.getByRole("button", { name: "Try restore again" }).focus(); await page.keyboard.press("Enter"); await expect(page.getByRole("status")).toHaveText("Revision 1 restored."); expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test("isolates selected messages and exact Block Discussion actions", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" }); await authenticate(page);
  await page.goto("/app/notes/99999999-9999-4999-8999-999999999999/discussions");
  const first = page.getByText("Keep this release context").locator("xpath=ancestor::article");
  const second = page.getByText("Unrelated migration thread").locator("xpath=ancestor::article");
  await first.getByRole("checkbox", { name: /Keep this release context/ }).check(); await second.getByRole("checkbox", { name: /Unrelated migration thread/ }).check();
  const [workRequest] = await Promise.all([page.waitForRequest((request) => request.url().endsWith("/api/discussions/abababab-abab-4bab-8bab-abababababa2/work")), first.getByRole("button", { name: "Create Note from selection" }).click()]);
  expect((workRequest.postDataJSON() as { messageIds: string[] }).messageIds).toEqual(["abababab-abab-4bab-8bab-abababababa3"]);
  await page.goto("/app/notes/99999999-9999-4999-8999-999999999999/blocks/77777777-7777-4777-8777-777777777777/discussions");
  await expect(page.getByText("Exact Block thread")).toBeVisible(); await expect(page.getByText("Keep this release context")).toHaveCount(0); await expect(page.getByText("Unrelated Block thread")).toHaveCount(0);
  const blockDiscussion = page.getByText("Exact Block thread").locator("xpath=ancestor::article"); await blockDiscussion.getByRole("textbox", { name: "Reply" }).fill("Exact Block reply"); await blockDiscussion.getByRole("button", { name: "Reply", exact: true }).click(); await expect(blockDiscussion.getByText("Exact Block reply")).toBeVisible();
  await blockDiscussion.getByRole("button", { name: "Resolve Discussion" }).click(); await expect(blockDiscussion.getByText("Resolved")).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test("@a11y keeps every migrated core route free of detectable accessibility violations", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" }); await authenticate(page);
  for (const path of ["/app/inbox", "/app/notes", "/app/notes/99999999-9999-4999-8999-999999999999/history", "/app/tasks", `/app/projects/22222222-2222-4222-8222-222222222222/boards/${"abababab-abab-4bab-8bab-abababababa1"}`, "/app/notes/99999999-9999-4999-8999-999999999999/discussions", "/app/search?q=release", "/app/notifications", "/app/activity"]) {
    await page.goto(path); await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations, path).toEqual([]);
  }
});

test("signs in with a passkey and a recovery code through accessible React flows", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, "credentials", { configurable: true, value: { get: async () => ({ toJSON: () => ({ id: "acceptance-passkey", rawId: "acceptance-passkey", type: "public-key", response: { clientDataJSON: "proof", authenticatorData: "proof", signature: "proof" } }) }) } }));
  await page.goto("/sign-in"); await page.getByRole("button", { name: "Passkey" }).click(); await page.getByRole("textbox", { name: "Email" }).fill("member@stash.test"); await page.getByRole("button", { name: "Sign in" }).click(); await expect(page).toHaveURL(/\/app$/);
  await page.evaluate(() => localStorage.removeItem("stash.member-session")); await page.goto("/sign-in");
  await page.getByRole("button", { name: "Recovery code" }).click(); await page.getByRole("textbox", { name: "Email" }).fill("member@stash.test"); await page.getByRole("textbox", { name: "Recovery code" }).fill("12345678-12345678"); await page.getByRole("button", { name: "Sign in" }).click(); await expect(page).toHaveURL(/\/app$/);
});

test("@a11y exposes email recovery and OpenID Connect errors without losing input", async ({ page }) => {
  await page.goto("/sign-in"); await page.getByRole("button", { name: "Email recovery" }).click(); await page.getByRole("textbox", { name: "Email" }).fill("member@stash.test");
  await page.getByRole("button", { name: "Send recovery email" }).click(); await expect(page.getByRole("alert")).toContainText("not configured"); await expect(page.getByRole("textbox", { name: "Email" })).toHaveValue("member@stash.test");
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByRole("button", { name: "OpenID Connect" }).click(); await page.getByRole("textbox", { name: "Organization ID" }).fill("not-configured");
  await page.getByRole("button", { name: "Continue with OpenID Connect" }).click(); await expect(page.getByRole("alert")).toContainText("invalid or expired");
});

test("creates a Task from a Note Block and preserves the durable relationship while planning", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await authenticate(page); await page.goto("/app/notes/99999999-9999-4999-8999-999999999999");
  await page.evaluate(() => window.addEventListener("beforeunload", () => sessionStorage.setItem("stash.acceptance-unloaded", "yes")));
  const editor = page.getByRole("textbox", { name: "Note content" }); await editor.getByText("Preserve this linked Block").click();
  await page.getByRole("button", { name: "Create Task from current Block" }).press("Enter");
  await page.getByRole("combobox", { name: "Project" }).selectOption("22222222-2222-4222-8222-222222222222");
  await page.getByRole("textbox", { name: "Task title" }).fill("Ship linked release plan"); await page.getByRole("button", { name: "Create linked Task" }).click();
  const relationship = page.getByRole("link", { name: /STASH-32 · Ship linked release plan/ }); await expect(relationship).toBeVisible(); await expect(page.getByText("Ready · linked")).toBeVisible(); await relationship.click();
  await expect(page.getByRole("heading", { name: "Ship linked release plan" })).toBeVisible(); await expect(page.getByRole("link", { name: /Note 99999999/ })).toBeVisible();
  await page.getByRole("link", { name: /Note 99999999/ }).click(); await expect(page.getByRole("textbox", { name: "Note content" })).toBeVisible(); await expect.poll(() => page.evaluate(() => sessionStorage.getItem("stash.acceptance-unloaded"))).toBeNull();
  await relationship.click(); await expect(page.getByRole("heading", { name: "Ship linked release plan" })).toBeVisible();
  let planningAttempts = 0;
  await page.route("**/api/projects/22222222-2222-4222-8222-222222222222/tasks/STASH-32", async (route) => {
    if (route.request().method() === "PATCH" && planningAttempts++ === 0) {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "Planning is temporarily unavailable." }) });
      return;
    }
    await route.continue();
  });
  const plannedTitle = page.getByRole("textbox", { name: "Title" });
  await plannedTitle.fill("Ship the durable plan"); await page.getByRole("button", { name: "Save Task plan" }).press("Enter");
  await expect(page.getByRole("alert")).toContainText("temporarily unavailable"); await expect(plannedTitle).toHaveValue("Ship the durable plan");
  await page.getByRole("button", { name: "Save Task plan" }).press("Enter"); await expect(page.getByRole("heading", { name: "Ship the durable plan" })).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await plannedTitle.fill("Restore release ownership"); await page.getByRole("button", { name: "Save Task plan" }).press("Enter");
});

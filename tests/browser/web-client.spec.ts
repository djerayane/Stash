import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const memberSession = JSON.stringify({
  token: "browser-acceptance-member-token",
  member: { name: "Forged Member", email: "forged@evil.test" },
  workspace: { name: "Forged Workspace" },
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
  await expect(page.getByText("Acceptance Workspace").first()).toBeVisible();
  await expect(page.getByText("Forged Workspace")).toHaveCount(0);
});

test("rejects the Instance Administrator credential from the Member shell", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("stash.member-session", JSON.stringify({ token: "browser-acceptance-admin-token",
    member: { name: "Forged administrator", email: "admin@evil.test" }, workspace: { name: "Forged Workspace" } })));
  await page.goto("/app");
  await expect(page.getByRole("heading", { name: "Sign in to Stash" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Workspace" })).toHaveCount(0);
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

test("configures followed Project notifications by keyboard without accessibility violations", async ({ page }) => {
  await installMemberSession(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const projectId = "11111111-1111-4111-8111-111111111111";
  let activity = "followed"; let digest = "off"; let followed = false; let loadFailures = 1;
  await page.route(`**/api/projects/${projectId}/notification-settings`, async (route) => {
    if (route.request().method() === "GET" && loadFailures-- > 0) { await route.fulfill({ status: 503, json: { message: "Temporarily unavailable" } }); return; }
    if (route.request().method() === "PUT") { const body = await route.request().postDataJSON(); activity = body.activity; digest = body.digest; }
    await route.fulfill({ json: { settings: { activity, digest } } });
  });
  await page.route(`**/api/projects/${projectId}/follow`, async (route) => {
    if (route.request().method() === "PUT") followed = (await route.request().postDataJSON()).followed;
    await route.fulfill({ json: { followed } });
  });
  await page.goto(`/app/projects/${projectId}/notifications`);
  const alert = page.getByRole("alert"); await expect(alert).toBeFocused();
  await page.getByRole("button", { name: "Try again" }).focus(); await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Choose what reaches you." })).toBeVisible();
  await expect(page.locator("form")).toHaveCSS("transform", "none");
  const all = page.getByRole("radio", { name: /All Project Activity/ });
  await all.focus(); await page.keyboard.press("Space");
  await expect(all).toBeChecked();
  const follow = page.getByRole("checkbox", { name: /Follow this Project/ });
  await follow.focus(); await page.keyboard.press("Space");
  await expect(follow).toBeChecked();
  await page.getByRole("combobox", { name: /Digest cadence/ }).selectOption("weekly");
  await page.getByRole("checkbox", { name: /Quiet hours/ }).check();
  await page.getByRole("button", { name: "Save preferences" }).focus(); await page.keyboard.press("Enter");
  await expect(page.getByText("Preferences saved.")).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
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
  expect(await sidebar.evaluate((element) => getComputedStyle(element).transform)).toBe("none");
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

test("removes a Member, revokes authority, and keeps former assignment repair accessible", async ({ page }) => {
  await installMemberSession(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/app/settings/members");

  const organization = page.getByRole("combobox", { name: "Organization" });
  await expect(organization).toHaveValue("44444444-4444-4444-8444-444444444444");
  await organization.selectOption("33333333-3333-4333-8333-333333333333");
  await expect(page.getByText("Other Organization").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Review departure" })).toHaveCount(0);
  await organization.selectOption("44444444-4444-4444-8444-444444444444");

  const adminCannotManageRoles = await page.evaluate(async () => fetch("/api/organizations/44444444-4444-4444-8444-444444444444/roles", {
    headers: { authorization: "Bearer browser-acceptance-member-token" },
  }).then((response) => response.status));
  expect(adminCannotManageRoles).toBe(403);

  const departingSessionBefore = await page.evaluate(async () => fetch("/api/organizations/44444444-4444-4444-8444-444444444444/roles", {
    headers: { authorization: "Bearer departed-member-token" },
  }).then((response) => response.status));
  expect(departingSessionBefore).toBe(403);
  await expect(page.getByRole("heading", { name: "Member access" })).toBeVisible();
  await page.getByRole("button", { name: "Review departure" }).click();
  const confirmation = page.getByRole("region", { name: /Remove Departing Member/ });
  await expect(confirmation).toBeVisible();
  await expect(confirmation).toBeFocused();
  await expect(confirmation).toHaveCSS("transform", "none");
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByRole("button", { name: "Remove Member" }).click();
  await expect(page.getByRole("heading", { name: "Departing Member no longer has access" })).toBeVisible();
  await page.getByRole("link", { name: "Home" }).click();
  await page.getByRole("link", { name: "Members" }).click();
  await expect(page.getByRole("heading", { name: "Member access" })).toBeVisible();
  await expect(page.getByText("Departing Member", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Review departure" })).toHaveCount(0);
  const departedAuthority = await page.evaluate(async () => fetch("/api/organizations/44444444-4444-4444-8444-444444444444/roles", {
    headers: { authorization: "Bearer departed-member-token" },
  }).then((response) => response.status));
  expect(departedAuthority).toBe(401);

  await page.goto("/app/projects/22222222-2222-4222-8222-222222222222/tasks/STASH-32");

  await expect(page.getByRole("heading", { name: "Restore release ownership" })).toBeVisible();
  const marker = page.getByRole("status");
  await expect(marker).toBeVisible();
  await expect(marker).toContainText("Departed Member — assignment needs attention");
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  await page.getByRole("button", { name: "Assign to me" }).click();
  await expect(page.getByText("Assigned to you", { exact: true })).toBeVisible();
  await expect(page.getByText("Departed Member — assignment needs attention", { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByText("Departed Member — assignment needs attention", { exact: true })).toHaveCount(0);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test("announces and focuses a session failure, then retries by keyboard without reloading", async ({ page }) => {
  await installMemberSession(page);
  let sessionAttempts = 0;
  let documentNavigations = 0;
  page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) documentNavigations += 1; });
  await page.route("**/api/client-session", async (route) => {
    sessionAttempts += 1;
    await route.fulfill({ status: sessionAttempts === 1 ? 503 : 200, contentType: "application/json", body: JSON.stringify({
      authenticated: true, member: { id: "browser-member", name: "Browser Member", email: "member@stash.test" },
      workspace: { id: "browser-workspace", name: "Acceptance Workspace" }, capabilities: [],
    }) });
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

test("reviews and confirms an ambiguous GitHub Signal by keyboard without reloading", async ({ page }) => {
  await installMemberSession(page);
  const projectId = "11111111-1111-4111-8111-111111111111";
  const suggestion = { id: "22222222-2222-4222-8222-222222222222", signalId: "signal-1", taskId: "task-36", projectId, taskKey: "STASH-36", taskTitle: "Receive GitHub development Signals", matchedKey: "OLD-1", status: "pending_confirmation" };
  let confirmed = false; let documentNavigations = 0;
  page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) documentNavigations += 1; });
  await page.route("**/automations", (route) => route.fulfill({ json: { automation: { recipes: [], transitions: [], availableStatuses: [] } } }));
  await page.route("**/development-signals**", async (route) => {
    if (route.request().method() === "POST") { confirmed = true; await route.fulfill({ json: { suggestion: { ...suggestion, status: "confirmed" } } }); return; }
    await route.fulfill({ json: { signals: [{ signal: { id: "signal-1", kind: "pull_request", url: "https://github.com/acme/stash/pull/42", label: "#42 Shared work", occurredAt: "2026-08-23T08:00:00.000Z" }, suggestions: [{ ...suggestion, status: confirmed ? "confirmed" : "pending_confirmation" }] }] } });
  });
  await page.goto(`/app/projects/${projectId}/tasks/STASH-36/development`);
  await expect(page.getByText("#42 Shared work")).toBeVisible();
  documentNavigations = 0;
  await page.getByRole("button", { name: "Review match" }).focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Confirm Task relationship" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Confirm relationship" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Relationship confirmed")).toBeVisible();
  expect(documentNavigations).toBe(0);
});

test("focuses a development Signal load failure and retries by keyboard without reloading", async ({ page }) => {
  await installMemberSession(page);
  const projectId = "11111111-1111-4111-8111-111111111111"; let attempts = 0; let documentNavigations = 0;
  page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) documentNavigations += 1; });
  await page.route("**/automations", (route) => route.fulfill({ json: { automation: { recipes: [], transitions: [], availableStatuses: [] } } }));
  await page.route("**/development-signals", async (route) => { attempts += 1; await route.fulfill({ status: attempts === 1 ? 503 : 200, json: attempts === 1 ? { message: "Signals are temporarily unavailable." } : { signals: [] } }); });
  await page.goto(`/app/projects/${projectId}/tasks/STASH-36/development`);
  const alert = page.getByRole("alert"); await expect(alert).toBeVisible(); await expect(alert).toBeFocused();
  documentNavigations = 0; await alert.getByRole("button", { name: "Try again" }).focus(); await page.keyboard.press("Enter");
  await expect(page.getByText("No development activity yet")).toBeVisible();
  expect(attempts).toBe(2); expect(documentNavigations).toBe(0);
});

test("configures and reverses a visible Task status Automation by keyboard without reloading", async ({ page }) => {
  await installMemberSession(page);
  const projectId = "11111111-1111-4111-8111-111111111111"; let configured = false; let reversed = false; let reverseAttempts = 0; let navigations = 0;
  page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) navigations += 1; });
  await page.route("**/development-signals", (route) => route.fulfill({ json: { signals: [] } }));
  await page.route("**/automations**", async (route) => {
    if (route.request().method() === "POST" && route.request().url().endsWith("/automations")) { configured = true; await route.fulfill({ json: { recipe: {} } }); return; }
    if (route.request().method() === "POST") { reverseAttempts += 1; if (reverseAttempts === 1) { await route.fulfill({ status: 503, json: { message: "The status could not be restored." } }); return; } reversed = true; await route.fulfill({ json: { transition: {} } }); return; }
    await route.fulfill({ json: { automation: { availableStatuses: [{ id: "progress", name: "In progress" }],
      recipes: configured ? [{ id: "recipe", trigger: "branch_created", targetStatus: { id: "progress", name: "In progress" }, enabled: true }] : [],
      transitions: configured ? [{ id: "transition", automationId: "recipe", signalId: "signal-123", before: { id: "ready", name: "Ready" }, after: { id: "progress", name: "In progress" }, occurredAt: "2026-08-23T09:00:00.000Z", ...(reversed ? { reversedAt: "2026-08-23T10:00:00.000Z" } : {}) }] : [] } } });
  });
  await page.goto(`/app/projects/${projectId}/tasks/STASH-37/development`); navigations = 0;
  await page.getByRole("button", { name: "Configure recipe" }).focus(); await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Configure Task status Automation" }); await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Enable recipe" }).click();
  await expect(page.getByText("When a branch is created")).toBeVisible();
  await page.getByRole("button", { name: "Undo status change" }).focus(); await page.keyboard.press("Enter");
  const alert = page.getByRole("alert"); await expect(alert).toContainText("The status could not be restored."); await expect(alert).toBeFocused();
  await alert.getByRole("button", { name: "Try again" }).focus(); await page.keyboard.press("Enter");
  await expect(page.getByText("Reversed")).toBeVisible(); expect(navigations).toBe(0);
});

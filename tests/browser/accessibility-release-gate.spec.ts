import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";

const memberSession = JSON.stringify({ token: "browser-acceptance-member-token" });

async function authenticate(page: Page) {
  await page.addInitScript((value) => localStorage.setItem("stash.member-session", value), memberSession);
}

async function expectWcag22Aa(page: Page, context: string) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  expect(results.violations, context).toEqual([]);
  expect(results.incomplete.filter(({ id }) => id === "target-size"), `${context}: unresolved target-size checks`).toEqual([]);
}

async function expectVisibleFocus(locator: Locator) {
  await locator.focus();
  await expect(locator).toBeFocused();
  const focus = await locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      outline: Number.parseFloat(style.outlineWidth) || 0,
      shadow: style.boxShadow === "none" ? 0 : 1,
    };
  });
  expect(focus.outline > 0 || focus.shadow > 0).toBe(true);
}

async function expectNoHorizontalPageScroll(page: Page, context: string) {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scrollWidth, context).toBeLessThanOrEqual(dimensions.clientWidth);
}

async function expectMinimumTargetSize(locator: Locator, context: string) {
  await expect(locator.first(), `${context}: representative controls exist`).toBeVisible();
  const boxes = await locator.evaluateAll((elements) => elements.filter((element) => {
    const style = getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none";
  }).map((element) => {
    const box = element.getBoundingClientRect();
    return { name: element.getAttribute("aria-label") || element.textContent?.trim() || element.tagName, width: box.width, height: box.height };
  }));
  expect(boxes.length, `${context}: representative controls exist`).toBeGreaterThan(0);
  for (const box of boxes) {
    expect(box.width, `${context}: ${box.name} width`).toBeGreaterThanOrEqual(24);
    expect(box.height, `${context}: ${box.name} height`).toBeGreaterThanOrEqual(24);
  }
}

test("@a11y authenticates by keyboard and focuses a recoverable error without losing input", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/sign-in");
  await expectMinimumTargetSize(page.getByRole("group", { name: "Authentication method" }).getByRole("button"), "authentication methods");

  const email = page.getByRole("textbox", { name: "Email" });
  const password = page.getByLabel("Password", { exact: true });
  await email.fill("member@stash.test");
  await password.fill("incorrect password value");
  await password.press("Tab");
  await expect(page.getByRole("button", { name: "Sign in" })).toBeFocused();
  await page.keyboard.press("Enter");

  const alert = page.getByRole("alert");
  await expect(alert).toHaveText("The email or password is incorrect.");
  await expect(alert).toBeFocused();
  await expect(email).toHaveValue("member@stash.test");
  await expect(password).toHaveValue("incorrect password value");
  await expectNoHorizontalPageScroll(page, "password sign-in at 320 CSS pixels");
  await expectWcag22Aa(page, "password sign-in error");
});

test("@a11y traps capture focus, closes with Escape, and restores the keyboard trigger", async ({ page }) => {
  await authenticate(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/app/inbox");

  const trigger = page.getByRole("button", { name: "Capture Note" });
  await expectVisibleFocus(trigger);
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Capture a Note" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "Note content" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await expectWcag22Aa(page, "Inbox capture dialog focus lifecycle");
});

test("@a11y keeps required Member flows reflowed, named, and axe-clean at 320 CSS pixels", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await authenticate(page);
  await page.route("**/api/member/localization", (route) => route.fulfill({ json: {
    locale: "en", timeZone: "UTC", dateFormat: "medium", weekStartsOn: "monday",
  } }));

  const paths = [
    "/app/notes/99999999-9999-4999-8999-999999999999",
    "/app/projects/22222222-2222-4222-8222-222222222222/tasks/STASH-32",
    "/app/projects/22222222-2222-4222-8222-222222222222/boards/abababab-abab-4bab-8bab-abababababa1",
    "/app/notes/99999999-9999-4999-8999-999999999999/discussions",
    "/app/search?q=release",
    "/app/settings",
    "/app/settings/data",
  ] as const;

  for (const path of paths) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expectNoHorizontalPageScroll(page, path);
    await expectWcag22Aa(page, path);
  }

  await page.goto("/app/settings");
  await expectMinimumTargetSize(page.getByRole("tab"), "settings security tabs");
  await expectMinimumTargetSize(page.getByRole("navigation", { name: "Workspace" }).getByRole("link"), "compact Workspace navigation");

  await page.goto("/app/projects/22222222-2222-4222-8222-222222222222/boards/abababab-abab-4bab-8bab-abababababa1");
  const move = page.getByRole("combobox", { name: /Move Task STASH-32/ });
  await expectMinimumTargetSize(move, "non-drag Task movement");
  await expectVisibleFocus(move);
  await move.selectOption("done");
  await expect(page.getByRole("status")).toHaveText("STASH-32 moved.");
  await expect(move).toBeFocused();
});

test("@a11y focuses failed settings updates and successful import status", async ({ page }) => {
  await authenticate(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  let saves = 0;
  await page.route("**/api/member/localization", async (route) => {
    if (route.request().method() === "PUT" && saves++ === 0) {
      await route.fulfill({ status: 503, json: { message: "Preferences are temporarily unavailable. No changes were saved." } });
      return;
    }
    await route.fulfill({ json: { locale: "en", timeZone: "UTC", dateFormat: "medium", weekStartsOn: "monday" } });
  });
  await page.goto("/app/settings");
  const locale = page.getByRole("textbox", { name: "Locale" });
  await locale.fill("fr-FR");
  await page.getByRole("button", { name: "Save regional settings" }).press("Enter");
  await expect(page.getByRole("alert")).toBeFocused();
  await expect(locale).toHaveValue("fr-FR");

  await page.route("**/api/workspace-imports/markdown", (route) => route.fulfill({ status: 201, json: {
    status: "imported",
    report: { workspaceId: "99999999-9999-4999-8999-999999999999", transformed: [], skipped: [], ambiguous: [] },
  } }));
  await page.goto("/app/settings/data");
  await page.getByLabel("Markdown or Obsidian vault").check();
  await page.getByLabel("ZIP archive").setInputFiles({ name: "vault.zip", mimeType: "application/zip", buffer: Buffer.from("fixture") });
  await page.getByRole("button", { name: "Validate and import" }).press("Enter");
  await expect(page.getByRole("status", { name: "Import result" })).toBeFocused();
  await expectWcag22Aa(page, "Workspace import result");
});

test("@a11y keeps Instance Backup verification and confirmation keyboard-operable", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("stash.instance-admin-session", JSON.stringify({ token: "browser-acceptance-admin-token" })));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/api/instance/backups", (route) => route.fulfill({ json: { backups: [{
    name: "release-ready", schema: "stash.instance-backup.v1", createdAt: "2026-08-23T10:00:00.000Z",
  }] } }));
  await page.route("**/api/instance/backups/release-ready/restore", (route) => route.fulfill({ json: { status: "verified" } }));
  await page.goto("/instance-admin/backups");
  await page.getByRole("button", { name: "Verify release-ready" }).press("Enter");
  await expect(page.getByRole("status")).toBeFocused();
  const restore = page.getByRole("button", { name: "Restore release-ready" });
  await restore.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Replace the current Instance state?" });
  await expect(dialog.getByRole("textbox", { name: "Type release-ready to confirm" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(restore).toBeFocused();
  await expectWcag22Aa(page, "Instance Backup verification and confirmation");
});

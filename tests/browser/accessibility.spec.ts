import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/projects/*/repository-connections", (route) => route.fulfill({ json: { repositoryConnections: [] } }));
  await page.route("**/api/projects/*/tasks/*/development-artifacts", (route) => route.fulfill({ json: { artifacts: [] } }));
});

test("the primary shell has no automatically detectable accessibility violations @a11y", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("stash.member-session", JSON.stringify({
    token: "browser-acceptance-member-token",
    member: { name: "Browser Member", email: "member@stash.test" },
    workspace: { name: "Acceptance Workspace" },
  })));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/app");
  await expect(page.getByRole("heading", { name: "Good morning." })).toBeVisible();
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

test("the Instance Backup restore confirmation has no detectable accessibility violations @a11y", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("stash.instance-admin-session", JSON.stringify({ token: "browser-acceptance-admin-token" })));
  await page.route("**/api/instance/backups", (route) => route.fulfill({ json: { backups: [{ name: "release-ready", schema: "stash.instance-backup.v1",
    createdAt: "2026-08-23T10:00:00.000Z", verifiedAt: "2026-08-23T10:05:00.000Z" }] } }));
  await page.route("**/api/instance/backups/release-ready/restore", (route) => route.fulfill({ json: { status: "verified", backup: "release-ready" } }));
  await page.emulateMedia({ reducedMotion: "reduce" }); await page.goto("/instance-admin/backups");
  await page.getByRole("button", { name: "Verify release-ready" }).click(); await page.getByRole("button", { name: "Restore release-ready" }).click();
  await expect(page.getByRole("dialog", { name: "Replace the current Instance state?" })).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test("an invalid Instance Backup diagnosis has no detectable accessibility violations @a11y", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("stash.instance-admin-session", JSON.stringify({ token: "browser-acceptance-admin-token" })));
  await page.route("**/api/instance/backups", (route) => route.fulfill({ json: { backups: [{ name: "metadata-missing", status: "invalid" }] } }));
  await page.route("**/api/instance/backups/metadata-missing/restore", (route) => route.fulfill({ status: 422, json: { error: "invalid_manifest",
    message: "The backup manifest is missing or invalid. No Instance data was changed." } }));
  await page.emulateMedia({ reducedMotion: "reduce" }); await page.goto("/instance-admin/backups");
  await page.getByRole("button", { name: "Verify metadata-missing" }).click(); await expect(page.getByRole("alert")).toBeFocused();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test("the upgrade readiness console has no detectable accessibility violations @a11y", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("stash.instance-admin-session", JSON.stringify({ token: "browser-acceptance-admin-token" })));
  await page.route("**/api/instance/upgrade", (route) => route.fulfill({ json: { status: "ready", currentVersion: "0.1.0", targetVersion: "0.2.0", checks: [
    { id: "database", status: "pass", message: "PostgreSQL is reachable." }, { id: "backup", status: "pass", message: "Rollback storage is writable." },
  ] } }));
  await page.emulateMedia({ reducedMotion: "reduce" }); await page.goto("/instance-admin/upgrade");
  await expect(page.getByText("PostgreSQL is reachable.")).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test("the development Signal confirmation flow has no detectable accessibility violations @a11y", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("stash.member-session", JSON.stringify({ token: "browser-acceptance-member-token" })));
  const projectId = "11111111-1111-4111-8111-111111111111";
  await page.route("**/automations", (route) => route.fulfill({ json: { automation: { recipes: [], transitions: [], availableStatuses: [] } } }));
  await page.route("**/development-signals", (route) => route.fulfill({ json: { signals: [{ signal: { id: "signal-1", kind: "pull_request", url: "https://github.com/acme/stash/pull/42", label: "#42 Shared work", occurredAt: "2026-08-23T08:00:00.000Z" }, suggestions: [{ id: "22222222-2222-4222-8222-222222222222", taskKey: "STASH-36", taskTitle: "Receive GitHub development Signals", matchedKey: "OLD-1", status: "pending_confirmation" }] }] } }));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`/app/projects/${projectId}/tasks/STASH-36/development`);
  await page.getByRole("button", { name: "Review match" }).click();
  await expect(page.getByRole("dialog", { name: "Confirm Task relationship" })).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test("the Task Automation configuration has no detectable accessibility violations @a11y", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("stash.member-session", JSON.stringify({ token: "browser-acceptance-member-token" })));
  const projectId = "11111111-1111-4111-8111-111111111111";
  await page.route("**/development-signals", (route) => route.fulfill({ json: { signals: [] } }));
  await page.route("**/automations", (route) => route.fulfill({ json: { automation: { recipes: [], transitions: [], availableStatuses: [{ id: "progress", name: "In progress" }] } } }));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`/app/projects/${projectId}/tasks/STASH-37/development`);
  await page.getByRole("button", { name: "Configure recipe" }).click();
  await expect(page.getByRole("dialog", { name: "Configure Task status Automation" })).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

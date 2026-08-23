import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

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

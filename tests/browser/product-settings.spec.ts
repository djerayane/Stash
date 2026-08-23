import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

async function authenticate(page: Page, token = "browser-acceptance-member-token") { await page.addInitScript((value) => localStorage.setItem("stash.member-session", JSON.stringify({ token: value })), token); }

test("@a11y saves Member localization and recovers from a failed update", async ({ page }) => {
  await authenticate(page); let attempts = 0;
  await page.route("**/api/member/localization", async (route) => {
    if (route.request().method() === "PUT" && attempts++ === 0) return route.fulfill({ status: 503, json: { message: "Preferences are temporarily unavailable. No changes were saved." } });
    return route.fulfill({ json: { locale: attempts ? "fr-FR" : "en", timeZone: "UTC", dateFormat: "medium", weekStartsOn: "monday" } });
  });
  await page.emulateMedia({ reducedMotion: "reduce" }); await page.goto("/app/settings");
  const locale = page.getByRole("textbox", { name: "Locale" }); await locale.fill("fr-FR"); await page.getByRole("button", { name: "Save regional settings" }).click();
  await expect(page.getByRole("alert")).toContainText("No changes were saved"); await expect(locale).toHaveValue("fr-FR");
  await page.getByRole("button", { name: "Save regional settings" }).click(); await expect(page.getByRole("status")).toContainText("Saved successfully");
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test("ordinary Members cannot discover or deep-link Organization administration", async ({ page }) => {
  await authenticate(page, "browser-acceptance-second-member-token"); await page.goto("/app/settings");
  await expect(page.getByRole("link", { name: "Organization" })).toHaveCount(0); await expect(page.getByRole("link", { name: "Imported identities" })).toHaveCount(0);
  await page.goto("/app/settings/organization"); await expect(page).toHaveURL(/\/app\/settings$/); await expect(page.getByRole("heading", { name: "Make Stash work in your language and time." })).toBeVisible();
});

test("@a11y administrators discover every Organization control surface", async ({ page }) => {
  await authenticate(page);
  await page.route("**/api/organizations/*/roles", (route) => route.fulfill({ json: { roles: [{ name: "Owner" }, { name: "Admin" }, { name: "Member" }] } }));
  await page.route("**/api/agent-grant-options", (route) => route.fulfill({ json: { organizations: [{ organizationId: "11111111-1111-4111-8111-111111111111", projects: [] }] } }));
  await page.route("**/api/organizations/*/repository-connections", (route) => route.fulfill({ json: { repositoryConnections: [] } }));
  await page.emulateMedia({ reducedMotion: "reduce" }); await page.goto("/app/settings/organization");
  for (const heading of ["Roles and Members", "Invite access", "GitHub Repository Connections", "OpenID Connect"]) await expect(page.getByRole("heading", { name: heading })).toBeVisible();
  await expect(page.getByRole("link", { name: "Review Member departure" })).toHaveAttribute("href", "/app/settings/members");
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test("@a11y keeps Instance diagnostics in the operator-only console", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("stash.instance-admin-session", JSON.stringify({ token: "browser-acceptance-admin-token" })));
  await page.route("**/api/diagnostics", (route) => route.fulfill({ json: { settings: { diagnosticSubmissions: false, crashReportSubmissions: false, updateChecks: false }, pending: [], pendingCrashReports: [], updateCheckPayload: {} } }));
  await page.emulateMedia({ reducedMotion: "reduce" }); await page.goto("/instance-admin/diagnostics");
  await expect(page.getByRole("heading", { name: "Observe the Instance on its own terms." })).toBeVisible(); await page.getByRole("button", { name: "Review consent settings" }).click();
  await expect(page.getByRole("dialog", { name: "Diagnostic consent" })).toBeVisible(); expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

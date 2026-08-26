import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

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

test("@a11y imports an Obsidian vault by keyboard and exposes every conversion outcome",async({page})=>{
  await authenticate(page);let uploads=0;await page.route("**/api/workspace-imports/markdown",async route=>{uploads+=1;expect(route.request().headers().authorization).toBe("Bearer browser-acceptance-member-token");await route.fulfill({status:201,json:{status:"imported",report:{workspaceId:"99999999-9999-4999-8999-999999999999",transformed:[{object:"Note:Home.md",reason:"frontmatter_tags_extracted"}],skipped:[{object:".obsidian/config",reason:"hidden_vault_metadata"}],ambiguous:[{object:"Link:Home.md->Idea",reason:"multiple_note_targets"}]}}});});
  await page.emulateMedia({reducedMotion:"reduce"});await page.goto("/app/settings/data");await page.getByLabel("Markdown or Obsidian vault").focus();await page.keyboard.press("Space");await page.getByLabel("ZIP archive").setInputFiles({name:"vault.zip",mimeType:"application/zip",buffer:Buffer.from("fixture")});await page.getByRole("button",{name:"Validate and import"}).focus();await page.keyboard.press("Enter");
  await expect(page.getByRole("heading",{name:"Import committed"})).toBeVisible();await expect(page.getByRole("heading",{name:"Ambiguous (1)"})).toBeVisible();expect(uploads).toBe(1);expect((await new AxeBuilder({page}).analyze()).violations).toEqual([]);
  await page.getByRole("button",{name:"Open imported Workspace"}).click();await expect(page).toHaveURL(/\/app\/notes$/);await expect(page.getByText("Imported Workspace",{exact:true})).toBeVisible();
});

test("@a11y downloads a safe Workspace archive by keyboard and recovers without losing import state", async ({ page }) => {
  await authenticate(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  let exportAttempts = 0;
  await page.route("**/api/workspaces/*/export", async (route) => {
    exportAttempts += 1;
    if (exportAttempts === 1) {
      await route.fulfill({ status: 503, json: { message: "The Workspace export could not be completed. No partial export was produced." } });
      return;
    }
    await route.continue();
  });
  await page.goto("/app/settings/data");
  const markdown = page.getByLabel("Markdown or Obsidian vault");
  const archiveInput = page.getByLabel("ZIP archive");
  await markdown.check();
  await archiveInput.setInputFiles({ name: "preserved-vault.zip", mimeType: "application/zip", buffer: Buffer.from("preserve me") });

  const downloadButton = page.getByRole("button", { name: "Download Workspace archive" });
  await downloadButton.focus();
  await expect(downloadButton).toBeFocused();
  await page.keyboard.press("Enter");
  const alert = page.getByRole("alert");
  await expect(alert).toBeFocused();
  await expect(alert).toHaveText("The Workspace export could not be completed. No partial export was produced.");
  await expect(markdown).toBeChecked();
  await expect.poll(() => archiveInput.evaluate((input: HTMLInputElement) => ({ length: input.files?.length, name: input.files?.[0]?.name })))
    .toEqual({ length: 1, name: "preserved-vault.zip" });

  await downloadButton.focus();
  const [download] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Enter")]);
  expect(download.suggestedFilename()).toMatch(/^stash-workspace-.+\.zip$/);
  const path = await download.path();
  expect(path).not.toBeNull();
  const bytes = await readFile(path!);
  expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  expect(bytes.toString("utf8")).toContain("stash.portable-workspace-export.v1");
  expect(bytes.toString("utf8")).not.toContain("browser-acceptance-admin-token");
  await expect(page.getByRole("status", { name: "Workspace export result" })).toBeFocused();
  await expect(markdown).toBeChecked();
  await expect.poll(() => archiveInput.evaluate((input: HTMLInputElement) => ({ length: input.files?.length, name: input.files?.[0]?.name })))
    .toEqual({ length: 1, name: "preserved-vault.zip" });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test("confirms recovery-code replacement and Role authority changes before mutation", async ({ page }) => {
  await authenticate(page); let recoveryPosts = 0; let rolePuts = 0;
  await page.route("**/api/member/localization", (route) => route.fulfill({ json: { locale: "en", timeZone: "UTC", dateFormat: "medium", weekStartsOn: "monday" } }));
  await page.route("**/api/auth/recovery-codes", (route) => { recoveryPosts += 1; return recoveryPosts === 1 ? route.fulfill({ status: 503, json: { message: "Recovery codes were not changed." } }) : route.fulfill({ json: { codes: ["new-code"] } }); });
  await page.goto("/app/settings"); await page.getByRole("tab", { name: "Recovery" }).click(); await page.getByRole("button", { name: "Generate recovery codes" }).click();
  const recovery = page.getByRole("dialog", { name: "Replace every recovery code?" }); await expect(recovery).toBeVisible(); await expect(recovery.getByRole("button", { name: "Keep existing codes" })).toBeFocused(); expect(recoveryPosts).toBe(0); expect((await new AxeBuilder({ page }).include("[role=dialog]").analyze()).violations).toEqual([]);
  await recovery.getByRole("button", { name: "Invalidate and generate" }).click(); await expect(recovery.getByRole("alert")).toContainText("not changed"); await recovery.getByRole("button", { name: "Invalidate and generate" }).click(); await expect(page.getByText("new-code")).toBeVisible();
  await page.route("**/api/organizations/*/roles", async (route) => { if (route.request().method() === "PUT") { rolePuts += 1; return rolePuts === 1 ? route.fulfill({ status: 403, json: { message: "The final Owner cannot be changed." } }) : route.fulfill({ json: {} }); } return route.fulfill({ json: { roles: [{ name: "Owner" }, { name: "Admin" }, { name: "Member" }] } }); });
  await page.route("**/api/organizations/*/members/*/role", (route) => { rolePuts += 1; return rolePuts === 1 ? route.fulfill({ status: 403, json: { message: "The final Owner cannot be changed." } }) : route.fulfill({ json: {} }); });
  await page.route("**/api/agent-grant-options", (route) => route.fulfill({ json: { organizations: [] } })); await page.route("**/api/organizations/*/repository-connections", (route) => route.fulfill({ json: { repositoryConnections: [] } }));
  await page.goto("/app/settings/organization"); await page.getByRole("combobox", { name: "Role for Browser Member" }).selectOption("Admin"); const role = page.getByRole("dialog", { name: /Change Browser Member/ }); await expect(role.getByRole("button", { name: "Keep current Role" })).toBeFocused(); expect(rolePuts).toBe(0);
  await role.getByRole("button", { name: "Confirm Role change" }).click(); await expect(role.getByRole("alert")).toContainText("final Owner"); expect((await new AxeBuilder({ page }).include("[role=dialog]").analyze()).violations).toEqual([]); await role.getByRole("button", { name: "Keep current Role" }).click(); expect(rolePuts).toBe(1);
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

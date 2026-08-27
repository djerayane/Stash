import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

test.beforeEach(async ({ page }, testInfo) => {
  if (testInfo.title.includes("protected first-run setup") || testInfo.title.includes("real custom Role admin flow")) return;
  await page.route("**/api/projects/*/repository-connections", (route) => route.fulfill({ json: { repositoryConnections: [] } }));
  await page.route("**/api/projects/*/tasks/*/development-artifacts", (route) => route.fulfill({ json: { artifacts: [] } }));
});

const memberSession = JSON.stringify({
  token: "browser-acceptance-member-token",
  member: { name: "Forged Member", email: "forged@evil.test" },
  workspace: { name: "Forged Workspace" },
});

async function installMemberSession(page: Page) {
  await page.addInitScript((session) => localStorage.setItem("stash.member-session", session), memberSession);
}

test("@a11y @stable-knowledge-journey carries a fresh personal Instance through durable knowledge and work", async ({ page }) => {
  await expect.poll(async () => fetch("http://127.0.0.1:4174/health/ready").then(({ status }) => status).catch(() => 0),
    { timeout: 20_000 }).toBe(200);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("http://127.0.0.1:4174/sign-in");

  await expect(page.getByRole("heading", { name: "Keep the thread." })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Setup code" })).toHaveCount(0);
  await page.getByRole("textbox", { name: "Name" }).fill("Ada Lovelace");
  await page.getByRole("textbox", { name: "Email" }).fill("ada@example.test");
  await page.getByRole("button", { name: "Continue" }).press("Enter");
  await expect(page.getByRole("textbox", { name: "Workspace name" })).toBeFocused();
  await page.getByRole("textbox", { name: "Workspace name" }).fill("Ada's Workspace");
  await page.getByLabel("Password").fill("correct horse battery staple");
  await page.getByRole("textbox", { name: "Setup code" }).fill("STASH-ONE");
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByRole("button", { name: "Create my Workspace" }).press("Enter");

  await expect(page).toHaveURL(/\/app\/notes\/[0-9a-f-]{36}$/);
  const starterNoteId = page.url().split("/").at(-1)!;
  await expect.poll(() => page.evaluate(() => localStorage.getItem("stash.member-session")))
    .toMatch(/"token":"[^"]+"/);
  await expect(page.getByRole("heading", { name: "Try the pieces together" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Connect your thinking/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /Continue planning/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Task View · First moves" })).toBeVisible();
  await expect(page.getByText("Shape your first idea").last()).toBeVisible();
  await expect(page.getByText("Ready")).toHaveCount(2);
  await page.getByRole("textbox", { name: "Collection title" }).fill("Questions worth keeping");
  await page.getByRole("textbox", { name: "Idea" }).fill("Shape a durable question");
  await page.getByRole("button", { name: "Save Collection" }).press("Enter");
  await expect(page.getByRole("textbox", { name: "Collection title" })).toHaveValue("Questions worth keeping");
  await page.getByRole("combobox", { name: "Layout" }).selectOption("table");
  await page.getByRole("textbox", { name: "Task title contains" }).fill("Shape");
  await page.getByRole("button", { name: "Save Task View" }).press("Enter");
  await expect(page.getByRole("table")).toContainText("Shape your first idea");
  await expect(page.getByRole("table")).not.toContainText("Turn one Note into action");

  const exportedStatus = await page.evaluate(async () => {
    const session = JSON.parse(localStorage.getItem("stash.member-session")!);
    const current = await (await fetch("/api/client-session", { headers: { authorization: `Bearer ${session.token}` } })).json();
    return (await fetch(`/api/workspaces/${current.workspace.id}/export`, { headers: { authorization: `Bearer ${session.token}` } })).status;
  });
  expect(exportedStatus).toBe(200);

  await page.goto("http://127.0.0.1:4174/app/projects");
  await page.getByRole("button", { name: "Create a Project in Ada's Workspace" }).press("Enter");
  await page.getByRole("textbox", { name: "Project name" }).fill("Launch");
  await page.getByRole("textbox", { name: "Project key" }).fill("LAUNCH");
  await page.getByRole("button", { name: "Create Project" }).press("Enter");
  await expect(page).toHaveURL(/\/app\/projects\/[0-9a-f-]{36}\/boards$/);
  const projectId = page.url().split("/").at(-2)!;

  const journey = await page.evaluate(async ({ projectId, starterNoteId }) => {
    const token = JSON.parse(localStorage.getItem("stash.member-session")!).token as string;
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const session = await (await fetch("/api/client-session", { headers })).json();
    const root = await (await fetch(`/api/workspaces/${session.workspace.id}/note-tree`, { method: "POST", headers,
      body: JSON.stringify({ title: "Durable launch knowledge" }) })).json();
    const childResponse = await fetch(`/api/workspaces/${session.workspace.id}/note-tree`, { method: "POST", headers,
      body: JSON.stringify({ title: "Linked release evidence", parentId: root.node.id }) });
    const child = await childResponse.json();
    const linked = await fetch(`/api/notes/${root.node.id}/context/links`, { method: "POST", headers,
      body: JSON.stringify({ targetNoteId: child.node.id, label: "Release evidence", relationshipType: "supports" }) });
    const collection = await fetch(`/api/notes/${root.node.id}/collections`, { method: "POST", headers, body: JSON.stringify({
      schema: "stash.collection.v1", id: crypto.randomUUID(), workspaceId: session.workspace.id, ownerNoteId: root.node.id,
      title: "Release questions", properties: [{ id: crypto.randomUUID(), name: "Question", type: "text", position: 1 }], records: [],
    }) });
    const rootNote = await (await fetch(`/api/notes/${root.node.id}`, { headers })).json();
    const sourceBlockKey = rootNote.document.blocks[0].blockKey;
    const promoted = await fetch(`/api/notes/${root.node.id}/blocks/${sourceBlockKey}/tasks`, { method: "POST", headers,
      body: JSON.stringify({ projectId, title: "Promote the release decision" }) });
    const promotedBody = await promoted.json();
    const childProject = await (await fetch(`/api/workspaces/${session.workspace.id}/projects`, { method: "POST", headers,
      body: JSON.stringify({ name: "Launch follow-up", key: "FOLLOW" }) })).json();
    const nested = await fetch(`/api/projects/${childProject.id}/parent`, { method: "PUT", headers,
      body: JSON.stringify({ parentProjectId: projectId }) });
    const discussion = await fetch("/api/discussions", { method: "POST", headers,
      body: JSON.stringify({ target: { kind: "note", noteId: root.node.id }, message: "Keep the launch context attached" }) });
    const search = await fetch(`/api/workspaces/${session.workspace.id}/search?q=launch`, { headers });
    const exported = await fetch(`/api/workspaces/${session.workspace.id}/export`, { headers });
    return { token, workspaceId: session.workspace.id, rootId: root.node.id, starterNoteId,
      childStatus: childResponse.status, linkStatus: linked.status, collectionStatus: collection.status,
      taskStatus: promoted.status, taskKey: promotedBody.task?.key, sourceBlockKey: promotedBody.sourceBlock?.blockId,
      nestedProjectStatus: nested.status, discussionStatus: discussion.status,
      searchStatus: search.status, searchTotal: (await search.json()).total, exportStatus: exported.status };
  }, { projectId, starterNoteId });
  expect(journey).toMatchObject({ childStatus: 201, linkStatus: 201, collectionStatus: 201, taskStatus: 201,
    taskKey: "LAUNCH-1", nestedProjectStatus: 200, discussionStatus: 201, searchStatus: 200, exportStatus: 200 });
  expect(journey.sourceBlockKey).toBeTruthy();
  expect(journey.searchTotal).toBeGreaterThan(0);

  await page.goto(`http://127.0.0.1:4174/app/notes/${starterNoteId}`);
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Move Note branch to trash" }).press("Enter");
  await expect(page.getByText("This Note branch is trashed.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Try the pieces together" })).toHaveCount(0);
  await page.reload();
  await page.goto("http://127.0.0.1:4174/app/notes");
  const noteTreeWorkspace = page.getByRole("region", { name: "Note Tree workspace" });
  await noteTreeWorkspace.getByRole("button", { name: "Show archived and trashed branches" }).press("Enter");
  await noteTreeWorkspace.getByRole("button", { name: "Restore Start here" }).press("Enter");
  await expect(noteTreeWorkspace.getByText("Start here restored.")).toBeVisible();
  await page.goto(`http://127.0.0.1:4174/app/notes/${starterNoteId}`);
  await expect(page.getByRole("textbox", { name: "Collection title" })).toHaveValue("Questions worth keeping");
  await expect(page.getByRole("textbox", { name: "Idea" })).toHaveValue("Shape a durable question");
  await expect(page.getByRole("combobox", { name: "Layout" })).toHaveValue("table");
  await expect(page.getByRole("textbox", { name: "Task title contains" })).toHaveValue("Shape");

  const independentNoteId = await page.evaluate(async () => {
    const token = JSON.parse(localStorage.getItem("stash.member-session")!).token;
    const session = await (await fetch("/api/client-session", { headers: { authorization: `Bearer ${token}` } })).json();
    const response = await fetch(`/api/workspaces/${session.workspace.id}/note-tree`, { method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ title: "Independent Note" }) });
    return ((await response.json()) as { node: { id: string } }).node.id;
  });

  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Remove tutorial" }).press("Enter");
  await expect(page.getByText("The starter tutorial and its sample Tasks were permanently removed.")).toBeFocused();
  await expect(page.getByRole("button", { name: "Restore Note branch" })).toHaveCount(0);
  const cleanup = await page.evaluate(async ({ starterNoteId }) => {
    const token = JSON.parse(localStorage.getItem("stash.member-session")!).token;
    const tutorial = await fetch(`/api/notes/${starterNoteId}/starter-tutorial`, { headers: { authorization: `Bearer ${token}` } });
    const session = await (await fetch("/api/client-session", { headers: { authorization: `Bearer ${token}` } })).json();
    const tasks = await (await fetch(`/api/workspaces/${session.workspace.id}/tasks?scope=projectless`, { headers: { authorization: `Bearer ${token}` } })).json();
    return { tutorialStatus: tutorial.status, tasks };
  }, { starterNoteId });
  expect(cleanup.tutorialStatus).toBe(404);
  expect(cleanup.tasks.tasks).toEqual([]);
  await page.goto(`http://127.0.0.1:4174/app/notes/${independentNoteId}`);
  await expect(page.getByRole("textbox", { name: "Note content" })).toBeVisible();
  await expect(page.getByText("The starter tutorial and its sample Tasks were permanently removed.")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Restore Note branch" })).toHaveCount(0);
  await page.getByRole("button", { name: "Open Note context" }).press("Enter");
  await expect(page.getByRole("complementary", { name: "Note context" })).toBeVisible();

  await page.evaluate(() => localStorage.removeItem("stash.member-session"));
  const restarted = await page.request.post("http://127.0.0.1:4176/restart");
  expect(restarted.status()).toBe(200);
  await page.goto("http://127.0.0.1:4174/sign-in");
  await page.getByRole("textbox", { name: "Email" }).fill("ada@example.test");
  await page.getByLabel("Password").fill("correct horse battery staple");
  await page.getByRole("button", { name: "Sign in" }).press("Enter");
  await expect(page).toHaveURL(/\/app\//);
  await page.goto(`http://127.0.0.1:4174/app/notes/${journey.rootId}`);
  await expect(page.getByRole("heading", { name: "Durable launch knowledge" })).toBeVisible();
});

test("uses the real custom Role admin flow to grant Project creation and explains denial before it", async ({ page }) => {
  const origin = "http://127.0.0.1:4175";
  await expect.poll(async () => fetch(`${origin}/health/ready`).then(({ status }) => status).catch(() => 0),
    { timeout: 20_000 }).toBe(200);
  const signIn = async (email: string, password: string) => {
    await page.goto(`${origin}/sign-in`);
    await page.getByRole("textbox", { name: "Email" }).fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).press("Enter");
    await expect(page).toHaveURL(/\/app\//);
  };
  await signIn("role-member@stash.test", "member correct horse battery");
  await page.goto(`${origin}/app/projects`);
  await expect(page.getByRole("button", { name: "Create a Project in Organization Workspace" })).toBeDisabled();
  await expect(page.getByText("Your Organization Role does not include Project creation.")).toBeVisible();

  await page.evaluate(() => localStorage.clear());
  await signIn("role-owner@stash.test", "owner correct horse battery");
  await page.goto(`${origin}/app/settings/organization`);
  await expect(page.getByRole("heading", { name: "Custom Roles" })).toBeVisible();
  await page.getByRole("textbox", { name: "Role name" }).fill("Project lead");
  await page.getByRole("checkbox", { name: "Can create Projects" }).check();
  await page.getByRole("button", { name: "Create custom Role" }).press("Enter");
  const role = page.getByRole("textbox", { name: "Role name" }).nth(1).locator("xpath=ancestor::article[1]");
  await expect(role).toBeVisible();
  await role.getByRole("combobox", { name: "Add Organization Member" }).selectOption({ label: "Role Member" });
  await role.getByRole("button", { name: "Grant Role" }).press("Enter");
  await expect(role.getByText("Role Member")).toBeVisible();

  await page.evaluate(() => localStorage.clear());
  await signIn("role-member@stash.test", "member correct horse battery");
  await page.goto(`${origin}/app/projects`);
  const create = page.getByRole("button", { name: "Create a Project in Organization Workspace" });
  await expect(create).toBeEnabled(); await create.press("Enter");
  await page.getByRole("textbox", { name: "Project name" }).fill("Member Launch");
  await page.getByRole("textbox", { name: "Project key" }).fill("MEMBER");
  await page.getByRole("button", { name: "Create Project" }).press("Enter");
  await expect(page).toHaveURL(/\/app\/projects\/[0-9a-f-]{36}\/boards$/);
});

test("restores an anonymous deep link after authentication", async ({ page }) => {
  await page.goto("/app/tasks?assigned=me");
  await expect(page.getByRole("heading", { name: "Sign in to Stash" })).toBeVisible();
  await expect(page).toHaveURL(/\/sign-in\?returnTo=%2Fapp%2Ftasks%3Fassigned%3Dme$/);

  await page.evaluate((session) => localStorage.setItem("stash.member-session", session), memberSession);
  await page.reload();

  await expect(page).toHaveURL(/\/app\/tasks\?assigned=me$/);
  await expect(page.getByRole("heading", { name: "Tasks", exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Workspace" })).toHaveCount(0);
  await expect(page.getByText("Forged Workspace")).toHaveCount(0);
});

test("completes an OIDC browser callback and restores a safe deep link", async ({ page }) => {
  await page.goto("/app/tasks?assigned=me");
  await page.evaluate(() => sessionStorage.setItem("stash.oidc-return-to", "/app/tasks?assigned=me"));
  await page.goto("/api/auth/oidc/44444444-4444-4444-8444-444444444444/callback?code=browser-code&state=browser-state");
  await expect(page).toHaveURL(/\/app\/tasks\?assigned=me$/);
  await expect(page.getByRole("heading", { name: "Tasks", exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("stash.member-session"))).toBe(JSON.stringify({ token: "browser-acceptance-member-token" }));
});

test("rejects an external destination during an OIDC browser callback", async ({ page }) => {
  await page.goto("/sign-in");
  await page.evaluate(() => sessionStorage.setItem("stash.oidc-return-to", "https://evil.example/steal"));
  await page.goto("/api/auth/oidc/44444444-4444-4444-8444-444444444444/callback?code=browser-code&state=browser-state");
  await expect(page).toHaveURL(/\/app\/notes$/);
  await expect(page.getByRole("heading", { name: "Note Tree" }).last()).toBeVisible();
});

test("rejects the Instance Administrator credential from the Member shell", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("stash.member-session", JSON.stringify({ token: "browser-acceptance-admin-token",
    member: { name: "Forged administrator", email: "admin@evil.test" }, workspace: { name: "Forged Workspace" } })));
  await page.goto("/app");
  await expect(page.getByRole("heading", { name: "Sign in to Stash" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Workspace" })).toHaveCount(0);
});

test("verifies and confirms an Instance restore through the operator console", async ({ page }) => {
  const operations: Array<{ dryRun: boolean; confirmation?: string }> = [];
  await page.route("**/api/instance/backups", (route) => route.fulfill({ json: { backups: [{ name: "release-ready", schema: "stash.instance-backup.v1",
    createdAt: "2026-08-23T10:00:00.000Z", verifiedAt: "2026-08-23T10:05:00.000Z" }] } }));
  await page.route("**/api/instance/backups/release-ready/restore", async (route) => {
    const body = await route.request().postDataJSON() as { dryRun: boolean; confirmation?: string }; operations.push(body);
    await route.fulfill({ json: { status: body.dryRun ? "verified" : "restored", backup: "release-ready" } });
  });
  await page.emulateMedia({ reducedMotion: "reduce" }); await page.goto("/instance-admin/backups");
  await expect(page.getByRole("heading", { name: "Administrator access" })).toBeVisible();
  await page.getByLabel("Instance Administrator token").fill("browser-acceptance-admin-token");
  await page.getByRole("button", { name: "Continue" }).press("Enter");
  const verify = page.getByRole("button", { name: "Verify release-ready" }); await expect(verify).toBeVisible(); await verify.press("Enter");
  await expect(page.getByRole("status")).toBeFocused();
  const restore = page.getByRole("button", { name: "Restore release-ready" }); await expect(restore).toBeEnabled(); await restore.press("Enter");
  const destructive = page.getByRole("button", { name: "Restore Instance" }); await expect(destructive).toBeDisabled();
  await page.getByRole("textbox", { name: /Type release-ready/ }).fill("release-ready"); await expect(destructive).toBeEnabled(); await destructive.press("Enter");
  await expect(page.getByRole("status")).toContainText("restored successfully");
  expect(operations).toEqual([{ dryRun: true }, { dryRun: false, confirmation: "release-ready" }]);
});

test("preflights and confirms an Instance upgrade by keyboard", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("stash.instance-admin-session", JSON.stringify({ token: "browser-acceptance-admin-token" })));
  let upgraded = false;
  await page.route("**/api/instance/upgrade", async (route) => {
    if (route.request().method() === "POST") { upgraded = true; await route.fulfill({ json: { status: "upgraded", restartRequired: true } }); return; }
    await route.fulfill({ json: { status: "ready", currentVersion: "0.1.0", targetVersion: "0.2.0", checks: [
      { id: "database", status: "pass", message: "PostgreSQL is reachable." }, { id: "backup", status: "pass", message: "Rollback storage is writable." },
    ] } });
  });
  await page.emulateMedia({ reducedMotion: "reduce" }); await page.goto("/instance-admin/upgrade");
  await expect(page.getByRole("heading", { name: "Upgrade with a way back." })).toBeVisible();
  const action = page.getByRole("button", { name: "Upgrade to 0.2.0" }); await expect(action).toBeDisabled();
  await page.getByRole("textbox", { name: /Type 0.2.0/ }).fill("0.2.0"); await action.press("Enter");
  await expect(page.getByRole("status")).toBeFocused(); await expect(page.getByRole("status")).toContainText("Restart the Instance");
  expect(upgraded).toBe(true);
});

test("keeps a malformed backup visible and announces its verification diagnosis", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("stash.instance-admin-session", JSON.stringify({ token: "browser-acceptance-admin-token" })));
  await page.route("**/api/instance/backups", (route) => route.fulfill({ json: { backups: [{ name: "metadata-missing", status: "invalid" }] } }));
  await page.route("**/api/instance/backups/metadata-missing/restore", (route) => route.fulfill({ status: 422, json: { error: "invalid_manifest",
    message: "The backup manifest is missing or invalid. No Instance data was changed." } }));
  await page.emulateMedia({ reducedMotion: "reduce" }); await page.goto("/instance-admin/backups");
  await expect(page.getByText("Manifest details unavailable")).toBeVisible();
  await page.getByRole("button", { name: "Verify metadata-missing" }).press("Enter");
  const diagnosis = page.getByRole("alert"); await expect(diagnosis).toBeFocused(); await expect(diagnosis).toContainText("manifest is missing or invalid");
  await expect(page.getByRole("button", { name: "Restore metadata-missing" })).toBeDisabled();
});

test("supports keyboard navigation and focuses changed route content", async ({ page }) => {
  await installMemberSession(page);
  await page.route("**/api/workspaces/88888888-8888-4888-8888-888888888888/activity", (route) => route.fulfill({ json: { activities: [] } }));
  await page.goto("/app");
  const inbox = page.getByRole("link", { name: "Inbox" });
  await inbox.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/app\/inbox$/);
  await expect(page.getByRole("heading", { name: "Inbox", exact: true })).toBeVisible();
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
  await expect(page.getByRole("region", { name: "Choose what reaches you." }).locator("form")).toHaveCSS("transform", "none");
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
  await page.getByRole("combobox", { name: /Digest cadence/ }).selectOption("daily");
  await expect(page.getByText("Preferences saved.")).toHaveCount(0);
  await expect(page.getByRole("status")).toHaveText("Unsaved changes.");
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test("discovers Projects without raw identifiers and navigates implemented shell actions", async ({ page }) => {
  await installMemberSession(page);
  await page.goto("/app/tasks");
  await expect(page.getByRole("heading", { name: "Tasks", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create Task" })).toBeVisible();
  await page.getByRole("link", { name: "Capture" }).click();
  await expect(page).toHaveURL(/\/app\/inbox$/);
  await expect.poll(() => page.evaluate(() => localStorage.getItem("stash.last-active-context:88888888-8888-4888-8888-888888888888"))).toBe("/app/inbox");
  await page.goto("/app/missing");
  await page.getByRole("link", { name: "Go home" }).click();
  await expect(page).toHaveURL(/\/app\/inbox$/);
});

test("@a11y creates an allowed Project and explains a denied Workspace by keyboard", async ({ page }) => {
  await installMemberSession(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/app/projects");

  const create = page.getByRole("button", { name: "Create a Project in Acceptance Workspace" });
  await expect(create).toBeVisible();
  await expect(page.getByRole("button", { name: "Create a Project in Shared Workspace" })).toBeDisabled();
  await expect(page.getByText("Your Organization Role does not include Project creation.")).toBeVisible();
  await create.focus(); await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Create a Project" });
  await expect(dialog.getByRole("textbox", { name: "Project name" })).toBeFocused();
  await dialog.getByRole("textbox", { name: "Project name" }).fill("First launch");
  await dialog.getByRole("textbox", { name: "Project key" }).fill("launch");
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await dialog.getByRole("button", { name: "Create Project" }).press("Enter");
  await expect(page).toHaveURL(/\/app\/projects\/[0-9a-f-]{36}\/boards$/);
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
  const notes = page.getByRole("link", { name: "Note Tree" });
  const normalDuration = await notes.evaluate((element) => getComputedStyle(element).transitionDuration);
  expect(Number.parseFloat(normalDuration)).toBeGreaterThan(0.1);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const reducedDuration = await notes.evaluate((element) => getComputedStyle(element).transitionDuration);
  expect(Number.parseFloat(reducedDuration)).toBeLessThan(0.01);
  const pageContent = page.locator("main > :first-child");
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
  await page.getByRole("link", { name: "Note Tree" }).click();
  await page.getByText("More", { exact: true }).click();
  await page.getByRole("link", { name: "Members" }).click();
  await expect(page.locator("details").filter({ has: page.getByText("More", { exact: true }) })).not.toHaveAttribute("open", "");
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

test("maps imported attribution to a verified local Member by keyboard without exposing administrator credentials", async ({ page }) => {
  await installMemberSession(page); await page.emulateMedia({ reducedMotion: "reduce" }); await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/app/settings/imported-identities");
  await expect(page.getByRole("heading", { name: "Reconnect imported people." })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Grace Hopper" })).toBeVisible();
  const confirm = page.getByRole("button", { name: "Confirm mapping" }); await expect(confirm).toBeDisabled();
  await page.getByRole("combobox", { name: "Local Member" }).selectOption("11111111-1111-4111-8111-111111111111");
  await confirm.focus(); await page.keyboard.press("Enter");
  const status = page.getByRole("status"); await expect(status).toBeFocused(); await expect(status).toContainText("Grace Hopper now resolves to Browser Member");
  await expect(page.getByRole("heading", { name: "No unresolved Identity Stubs" })).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test("announces and focuses a session failure, then retries by keyboard without reloading", async ({ page }) => {
  await installMemberSession(page);
  let sessionAttempts = 0;
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
  const documentIdentity = await page.evaluate(() => { const value = crypto.randomUUID();
    Object.defineProperty(window, "__stashRetryDocumentIdentity", { value, configurable: true }); return value; });
  const navigatedDocumentIdentities: Array<string | null> = [];
  page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) void frame.evaluate(() =>
    (window as typeof window & { __stashRetryDocumentIdentity?: string }).__stashRetryDocumentIdentity ?? null)
    .then((identity) => navigatedDocumentIdentities.push(identity)); });
  await page.getByRole("button", { name: "Try again" }).focus();
  await page.keyboard.press("Enter");

  await expect(page.getByRole("heading", { name: "Note Tree" }).last()).toBeVisible();
  expect(sessionAttempts).toBe(2);
  await expect.poll(() => navigatedDocumentIdentities).toEqual([documentIdentity]);
  expect(await page.evaluate(() => (window as typeof window & { __stashRetryDocumentIdentity?: string }).__stashRetryDocumentIdentity)).toBe(documentIdentity);
});

test("issues and revokes an Agent Grant and safely reviews its Proposal by keyboard", async ({ page }) => {
  await installMemberSession(page); await page.emulateMedia({ reducedMotion: "reduce" }); let loadAttempts = 0; let created = false; let revoked = false; let proposalStatus = "pending"; let reviewSubmitted: any; let navigations = 0; let submitted: any;
  await page.addInitScript(() => { (window as any).__stashRejectClipboard = true; Object.defineProperty(navigator, "clipboard", { configurable: true,
    value: { writeText: async () => { if ((window as any).__stashRejectClipboard) throw new DOMException("Denied", "NotAllowedError"); } } }); });
  page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) navigations += 1; });
  await page.route("**/api/agent-grant-options", (route) => route.fulfill({ json: { organizations: [{ organizationId: "44444444-4444-4444-8444-444444444444", organizationName: "Acceptance Organization", projects: [{ id: "22222222-2222-4222-8222-222222222222", name: "Release planning" }] }] } }));
  await page.route("**/api/organizations/44444444-4444-4444-8444-444444444444/agent-grants**", async (route) => {
    if (route.request().url().endsWith("/proposals/proposal-1/review")) { reviewSubmitted = route.request().postDataJSON(); proposalStatus = "applied"; await route.fulfill({ json: { status: "applied", proposal: { id: "proposal-1", grantId: "grant-1", organizationId: "44444444-4444-4444-8444-444444444444", sponsoringMemberId: "browser-member", agentName: "Research agent", capability: "note.write", input: { workspaceId: "workspace-1", projectId: "22222222-2222-4222-8222-222222222222", input: { content: "Review me" } }, createdAt: "2026-08-23T10:00:00.000Z", status: "applied", reviewedAt: "2026-08-23T10:10:00.000Z", reviewedByMemberId: "browser-member" } } }); return; }
    if (route.request().url().endsWith("/proposals")) { await route.fulfill({ json: { proposals: [{ id: "proposal-1", grantId: "grant-1", organizationId: "44444444-4444-4444-8444-444444444444", sponsoringMemberId: "browser-member", agentName: "Research agent", capability: "note.write", input: { workspaceId: "workspace-1", projectId: "22222222-2222-4222-8222-222222222222", input: { content: "Review me" } }, createdAt: "2026-08-23T10:00:00.000Z", status: proposalStatus, ...(proposalStatus === "applied" ? { reviewedAt: "2026-08-23T10:10:00.000Z", reviewedByMemberId: "browser-member" } : {}) }] } }); return; }
    const method = route.request().method();
    if (method === "POST") { created = true; submitted = route.request().postDataJSON(); await route.fulfill({ status: 201, json: { status: "created", token: "stash_agent_abcdefghijklmnop.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", grant: { id: "99999999-9999-4999-8999-999999999999", organizationId: "44444444-4444-4444-8444-444444444444", sponsoringMemberId: "browser-member", name: "Research assistant", scopes: submitted.scopes, expiresAt: submitted.expiresAt, createdAt: "2026-08-23T10:00:00.000Z" } } }); return; }
    if (method === "DELETE") { revoked = true; await route.fulfill({ json: { grantId: "99999999-9999-4999-8999-999999999999", revoked: true } }); return; }
    loadAttempts += 1; if (loadAttempts === 1) { await route.fulfill({ status: 503, json: { message: "Agent Grants are temporarily unavailable." } }); return; }
    await route.fulfill({ json: { grants: created ? [{ id: "99999999-9999-4999-8999-999999999999", organizationId: "44444444-4444-4444-8444-444444444444", sponsoringMemberId: "browser-member", name: "Research assistant", scopes: [{ capability: "note.write", mode: "propose" }], expiresAt: "2026-09-22T10:00:00.000Z", createdAt: "2026-08-23T10:00:00.000Z", ...(revoked ? { revokedAt: "2026-08-23T10:00:00.000Z" } : {}) }] : [] } });
  });
  await page.goto("/app"); navigations = 0; await page.getByRole("link", { name: "Agents" }).focus(); await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Agent access, kept deliberate" })).toBeVisible(); navigations = 0; const alert = page.getByRole("alert"); await expect(alert).toBeFocused();
  await alert.getByRole("button", { name: "Try again" }).click(); await expect(page.getByText("No agents can access this Organization.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Agent Proposals" })).toBeVisible(); await page.getByText("Review submitted details").focus(); await page.keyboard.press("Enter"); await expect(page.getByText("Review me")).toBeVisible();
  await page.getByRole("button", { name: "Review and apply" }).focus(); await page.keyboard.press("Enter"); const proposalDialog = page.getByRole("dialog", { name: "Confirm this Proposal decision" });
  await expect(proposalDialog).toBeVisible(); await expect(proposalDialog.getByRole("button", { name: "Cancel" })).toBeFocused(); expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.keyboard.press("Tab"); await expect(proposalDialog.getByRole("button", { name: "Confirm decision" })).toBeFocused(); await page.keyboard.press("Enter"); await expect(page.getByText("applied", { exact: true })).toBeVisible();
  expect(reviewSubmitted).toMatchObject({ decision: "apply", confirmed: true }); expect(reviewSubmitted.operationId).toMatch(/^[0-9a-f-]{36}$/);
  await page.getByLabel("Agent name").fill("Research assistant"); await page.getByLabel("Project scope").selectOption("22222222-2222-4222-8222-222222222222"); await page.getByLabel("Create Notes").check(); await page.getByLabel("Create Notes policy").selectOption("direct"); await page.getByLabel("Lifetime").selectOption("1"); await page.getByRole("button", { name: "Review Direct authority" }).focus(); await page.keyboard.press("Enter");
  const directDialog = page.getByRole("dialog", { name: "Confirm Direct agent authority" }); await expect(directDialog).toBeVisible(); expect(created).toBe(false); await expect(directDialog.getByRole("button", { name: "Keep review required" })).toBeFocused(); expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]); await page.keyboard.press("Tab"); await expect(directDialog.getByRole("button", { name: "Issue with Direct authority" })).toBeFocused(); await page.keyboard.press("Enter");
  const credential = page.getByRole("region", { name: "Copy this credential now" }); await expect(credential).toBeFocused(); await expect(credential).toContainText("stash_agent_");
  expect(submitted.projectId).toBe("22222222-2222-4222-8222-222222222222"); expect(submitted.scopes).toEqual([{ capability: "note.read", mode: "direct" }, { capability: "note.write", mode: "direct" }]); expect(new Date(submitted.expiresAt).getTime()-Date.now()).toBeLessThanOrEqual(86_400_000);
  expect(submitted.directAuthorityConfirmation).toBe("I authorize this agent to use Direct capabilities without Proposal review");
  const copy = page.getByRole("button", { name: "Copy credential" }); await copy.focus(); await page.keyboard.press("Enter"); const copyError = page.getByRole("alert"); await expect(copyError).toBeFocused(); await expect(copyError).toContainText("copy it manually");
  const code = credential.locator("code"); await expect(code).toContainText("stash_agent_"); await expect(code).toHaveCSS("user-select", "text"); expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.evaluate(() => { (window as any).__stashRejectClipboard = false; }); await copy.focus(); await page.keyboard.press("Enter"); const copied = credential.getByRole("status"); await expect(copied).toHaveText("Credential copied."); await expect(copied).toBeFocused();
  await page.getByRole("button", { name: "Revoke" }).click(); await expect(page.getByRole("button", { name: "Revoked" })).toBeDisabled();
  expect(navigations).toBe(0);
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

test("creates a Task branch from its named Repository Connection without navigation", async ({ page }) => {
  await installMemberSession(page);
  const projectId = "11111111-1111-4111-8111-111111111111"; let body: Record<string, unknown> = {}; let navigations = 0;
  page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) navigations += 1; });
  await page.route("**/development-signals", (route) => route.fulfill({ json: { signals: [] } }));
  await page.route("**/automations", (route) => route.fulfill({ json: { automation: { recipes: [], transitions: [], availableStatuses: [] } } }));
  await page.route("**/api/projects/*/repository-connections", (route) => route.fulfill({ json: { repositoryConnections: [{ id: "22222222-2222-4222-8222-222222222222", repositoryUrl: "https://github.com/acme/stash" }] } }));
  await page.route("**/development-artifacts", async (route) => { if (route.request().method() === "POST") { body = route.request().postDataJSON(); await route.fulfill({ status: 201, json: { artifact: { kind: "branch", providerId: "STASH-35-work", url: "https://github.com/acme/stash/tree/STASH-35-work", label: "STASH-35-work" } } }); return; } await route.fulfill({ json: { artifacts: [] } }); });
  await page.goto(`/app/projects/${projectId}/tasks/STASH-35/development`); navigations = 0;
  await expect(page.getByRole("combobox", { name: "Repository" })).toHaveValue("22222222-2222-4222-8222-222222222222");
  await page.getByRole("textbox", { name: "Branch name (optional)" }).fill("STASH-35-work"); await page.getByRole("button", { name: "Create branch" }).click();
  await expect.poll(() => body).toMatchObject({ action: "create_branch", connectionId: "22222222-2222-4222-8222-222222222222", branchName: "STASH-35-work" }); expect(navigations).toBe(0);
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

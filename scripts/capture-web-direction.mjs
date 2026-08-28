import { chromium } from "@playwright/test";
import { fileURLToPath } from "node:url";

const output = fileURLToPath(new URL("../docs/design/stash-web-direction", import.meta.url));
const acceptanceOrigin = "http://127.0.0.1:4173";
const setupOrigin = "http://127.0.0.1:4174";
const noteId = "99999999-9999-4999-8999-999999999999";
const secondNoteId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const workspaceId = "88888888-8888-4888-8888-888888888888";
const token = "browser-acceptance-member-token";

async function assertCaptureReady(page, label) {
  await page.locator('[aria-busy="true"]:visible').waitFor({ state: "detached", timeout: 10_000 }).catch(() => undefined);
  await page.locator('[role="alert"]:visible').waitFor({ state: "detached", timeout: 10_000 }).catch(() => undefined);
  const placeholder = page.getByText(/^(Loading|Loading…|Opening Note…|Something went wrong)$/i);
  await placeholder.waitFor({ state: "detached", timeout: 10_000 }).catch(() => undefined);
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  if (dimensions.scrollWidth > dimensions.clientWidth) {
    throw new Error(`${label} has page-level horizontal overflow (${dimensions.scrollWidth}px > ${dimensions.clientWidth}px).`);
  }
  const alerts = await page.locator('[role="alert"]:visible').allTextContents();
  if (alerts.length) throw new Error(`${label} contains an alert: ${alerts.join(" | ")}`);
  const pending = await page.locator('[aria-busy="true"]:visible').count();
  if (pending) throw new Error(`${label} still contains ${pending} busy element(s).`);
  const loading = await placeholder.count();
  if (loading) throw new Error(`${label} still contains a loading or failure placeholder.`);
}

async function capture(page, name, label) {
  await assertCaptureReady(page, label);
  await page.screenshot({ path: `${output}/${name}` });
}

const browser = await chromium.launch();
try {
  const desktop = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
  await desktop.emulateMedia({ reducedMotion: "reduce" });

  await desktop.goto(`${setupOrigin}/sign-in`);
  const setup = desktop.getByRole("heading", { name: /Keep the thread\.|Make Stash yours\./ });
  await desktop.getByRole("heading", { name: /Keep the thread\.|Make Stash yours\.|Sign in to Stash/ }).waitFor({ state: "visible" });
  if (!(await setup.isVisible())) {
    throw new Error("The setup Instance is already claimed. Restart scripts/browser-instance.ts before regenerating the complete reference set.");
  }
  await capture(desktop, "01-instance-setup.png", "Instance setup");
  await desktop.getByRole("textbox", { name: "Name" }).fill("Ada Lovelace");
  await desktop.getByRole("textbox", { name: "Email" }).fill("ada@example.test");
  await desktop.getByRole("button", { name: "Continue" }).click();
  await desktop.getByRole("textbox", { name: "Workspace name" }).fill("Ada's Workspace");
  await desktop.getByLabel("Password").fill("correct horse battery staple");
  const setupCode = desktop.getByRole("textbox", { name: "Setup code" });
  if (await setupCode.isVisible()) await setupCode.fill(process.env.STASH_SETUP_CODE || "STASH-ONE");
  await desktop.getByRole("button", { name: "Create my Workspace" }).click();
  await desktop.waitForURL(/\/app\//);
  await desktop.waitForFunction(() => {
    const value = localStorage.getItem("stash.member-session");
    return value ? Boolean(JSON.parse(value).token) : false;
  });

  const starterGuide = desktop.getByRole("heading", { name: "Try the pieces together" });
  await starterGuide.waitFor({ state: "visible" });
  await desktop.getByRole("link", { name: /Connect your thinking/ }).waitFor({ state: "visible" });
  await desktop.getByRole("heading", { name: "Task View · First moves" }).waitFor({ state: "visible" });
  await desktop.getByRole("textbox", { name: "Note content" }).waitFor({ state: "visible" });
  await capture(desktop, "02-starter-workspace.png", "starter Workspace");

  await desktop.addInitScript((session) => localStorage.setItem("stash.member-session", JSON.stringify(session)), { token });
  await desktop.goto(`${acceptanceOrigin}/app/notes/${noteId}`);
  await desktop.getByRole("textbox", { name: "Note content" }).waitFor();
  await capture(desktop, "03-note-tree-editor.png", "Note Tree and editor");
  await desktop.getByRole("button", { name: "Open Note context" }).click();
  await desktop.getByRole("complementary", { name: "Note context" }).waitFor();
  await desktop.getByRole("list", { name: "Related Notes outline" }).waitFor({ state: "visible" });
  await capture(desktop, "04-links-backlinks.png", "Note context");
  await desktop.getByRole("tab", { name: "Discussions" }).click();
  await desktop.getByRole("tabpanel", { name: "Discussions" }).waitFor({ state: "visible" });
  await capture(desktop, "08-contextual-collaboration.png", "Note discussions");

  const sourceCollectionId = "70707070-7070-4070-8070-707070707070";
  const sourcePropertyId = "71717171-7171-4171-8171-717171717171";
  const sourceRecordId = "72727272-7272-4272-8272-727272727272";
  const sourceResponse = await desktop.request.post(`${acceptanceOrigin}/api/notes/${secondNoteId}/collections`, {
    headers: { authorization: `Bearer ${token}` },
    data: {
      schema: "stash.collection.v1", id: sourceCollectionId, workspaceId, ownerNoteId: secondNoteId,
      title: "Research signals", properties: [{ id: sourcePropertyId, name: "Name", type: "text", position: 1 }],
      records: [{ id: sourceRecordId, position: 1, values: { [sourcePropertyId]: "Native release evidence" } }],
    },
  });
  if (sourceResponse.status() !== 201) throw new Error(`Could not seed the reusable Collection (${sourceResponse.status()}).`);

  await desktop.goto(`${acceptanceOrigin}/app/notes/${noteId}`);
  await desktop.getByRole("textbox", { name: "Note content" }).waitFor();
  const created = desktop.waitForResponse((response) => response.url().endsWith(`/api/notes/${noteId}/collections`)
    && response.request().method() === "POST");
  await desktop.getByRole("button", { name: "New collection" }).click();
  const createdResponse = await created;
  if (createdResponse.status() !== 201) throw new Error("Direct Collection creation did not succeed.");
  const createdBody = await createdResponse.json();
  const createdCollectionId = createdBody.collection.id;
  const collection = desktop.locator(`[data-collection-id="${createdCollectionId}"]`);
  const title = collection.getByRole("textbox", { name: "Collection title" });
  await title.fill("Release references");
  await title.press("Enter");
  await desktop.getByRole("region", { name: "Release references" }).waitFor({ state: "visible" });
  await collection.waitFor({ state: "visible" });

  await collection.getByRole("button", { name: "Add property" }).click();
  await desktop.getByRole("textbox", { name: "Property name" }).fill("Stage");
  await desktop.getByRole("combobox", { name: "Property type" }).selectOption("single_select");
  await desktop.getByRole("button", { name: "Add option" }).click();
  await desktop.getByRole("textbox", { name: "Option 1" }).fill("Reviewed");
  await desktop.getByRole("button", { name: "Add property" }).click();
  await collection.getByRole("columnheader", { name: "Stage" }).waitFor({ state: "visible" });

  await collection.getByRole("button", { name: "New record" }).click();
  await collection.getByRole("textbox", { name: "Name, new record" }).fill("Acceptance journey");
  await collection.getByRole("combobox", { name: "Stage, new record" }).selectOption({ label: "Reviewed" });
  await collection.getByRole("button", { name: "Save record" }).click();
  await collection.getByRole("textbox", { name: "Name, Acceptance journey" }).waitFor({ state: "visible" });

  await desktop.getByRole("button", { name: "Insert view of another collection" }).click();
  await desktop.getByRole("combobox", { name: "Collection source" }).selectOption(sourceCollectionId);
  await desktop.getByRole("button", { name: "Insert view", exact: true }).click();
  const reused = desktop.getByRole("region", { name: "Research signals" });
  await reused.getByText(/View of Research signals · From /).waitFor({ state: "visible" });
  await reused.scrollIntoViewIfNeeded();
  await capture(desktop, "05-collections-view-blocks.png", "direct and reused Collections");

  await desktop.goto(`${acceptanceOrigin}/app/tasks`);
  await desktop.getByRole("heading", { name: "Tasks", exact: true }).waitFor();
  await capture(desktop, "06-tasks.png", "Tasks");
  await desktop.goto(`${acceptanceOrigin}/app/projects`);
  await desktop.getByRole("heading", { name: /Projects/ }).waitFor();
  await capture(desktop, "07-nested-projects.png", "Projects");
  await desktop.goto(`${acceptanceOrigin}/app/search?q=release`);
  await desktop.getByRole("main").waitFor();
  await capture(desktop, "09-search.png", "Search");
  await desktop.goto(`${acceptanceOrigin}/app/settings`);
  await desktop.getByRole("main").waitFor();
  await capture(desktop, "10-settings.png", "Settings");

  const narrow = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  await narrow.emulateMedia({ reducedMotion: "reduce" });
  await narrow.addInitScript((session) => localStorage.setItem("stash.member-session", JSON.stringify(session)), { token });
  await narrow.goto(`${acceptanceOrigin}/app/notes/${noteId}`);
  await narrow.getByRole("textbox", { name: "Note content" }).waitFor();
  await capture(narrow, "11-responsive-note.png", "390-pixel Note workspace");
} finally {
  await browser.close();
}

console.log(`Updated source-truth captures in ${output}`);

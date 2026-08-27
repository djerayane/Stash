import { chromium } from "@playwright/test";

const output = "docs/design/stash-web-direction";
const browser = await chromium.launch();
const desktop = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
await desktop.emulateMedia({ reducedMotion: "reduce" });

await desktop.goto("http://127.0.0.1:4174/sign-in");
const setup = desktop.getByRole("heading", { name: "Make Stash yours." });
if (await setup.isVisible()) {
  await desktop.screenshot({ path: `${output}/01-instance-setup.png`, fullPage: true });
  await desktop.getByRole("textbox", { name: "Name" }).fill("Ada Lovelace");
  await desktop.getByRole("textbox", { name: "Email" }).fill("ada@example.test");
  await desktop.getByRole("button", { name: "Continue" }).click();
  await desktop.getByRole("textbox", { name: "Workspace name" }).fill("Ada's Workspace");
  await desktop.getByLabel("Password").fill("correct horse battery staple");
  const setupCode = desktop.getByRole("textbox", { name: "Setup code" });
  if (await setupCode.isVisible()) await setupCode.fill(process.env.STASH_SETUP_CODE || "STASH-ONE");
  await desktop.getByRole("button", { name: "Create my Workspace" }).click();
} else {
  await desktop.getByRole("textbox", { name: "Email" }).fill("ada@example.test");
  await desktop.getByLabel("Password").fill("correct horse battery staple");
  await desktop.getByRole("button", { name: "Sign in" }).click();
}
await desktop.waitForURL(/\/app\//);
await desktop.screenshot({ path: `${output}/02-starter-workspace.png`, fullPage: true });
await desktop.screenshot({ path: `${output}/05-collections-view-blocks.png`, fullPage: true });

await desktop.goto("http://127.0.0.1:4173/app/notes/99999999-9999-4999-8999-999999999999");
await desktop.evaluate(() => localStorage.setItem("stash.member-session", JSON.stringify({ token: "browser-acceptance-member-token" })));
await desktop.reload();
await desktop.getByRole("textbox", { name: "Note content" }).waitFor();
await desktop.screenshot({ path: `${output}/03-note-tree-editor.png`, fullPage: true });
await desktop.getByRole("button", { name: "Open Note context" }).click();
await desktop.getByRole("complementary", { name: "Note context" }).waitFor();
await desktop.screenshot({ path: `${output}/04-links-backlinks.png`, fullPage: true });
await desktop.getByRole("tab", { name: "Discussions" }).click();
await desktop.screenshot({ path: `${output}/08-contextual-collaboration.png`, fullPage: true });

await desktop.goto("http://127.0.0.1:4173/app/tasks");
await desktop.getByRole("heading", { name: "Tasks", exact: true }).waitFor();
await desktop.screenshot({ path: `${output}/06-tasks.png`, fullPage: true });
await desktop.goto("http://127.0.0.1:4173/app/projects");
await desktop.getByRole("heading", { name: /Projects/ }).waitFor();
await desktop.screenshot({ path: `${output}/07-nested-projects.png`, fullPage: true });
await desktop.goto("http://127.0.0.1:4173/app/search?q=release");
await desktop.getByRole("main").waitFor();
await desktop.screenshot({ path: `${output}/09-search.png`, fullPage: true });
await desktop.goto("http://127.0.0.1:4173/app/settings");
await desktop.getByRole("main").waitFor();
await desktop.screenshot({ path: `${output}/10-settings.png`, fullPage: true });

const narrow = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
await narrow.emulateMedia({ reducedMotion: "reduce" });
await narrow.addInitScript(() => localStorage.setItem("stash.member-session", JSON.stringify({ token: "browser-acceptance-member-token" })));
await narrow.goto("http://127.0.0.1:4173/app/notes/99999999-9999-4999-8999-999999999999");
await narrow.getByRole("textbox", { name: "Note content" }).waitFor();
await narrow.screenshot({ path: `${output}/11-responsive-note.png`, fullPage: true });

await browser.close();

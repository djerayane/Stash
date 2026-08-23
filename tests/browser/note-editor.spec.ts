import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const noteId = "99999999-9999-4999-8999-999999999999";
const secondNoteId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const richNoteId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const memberSession = JSON.stringify({ token: "browser-acceptance-member-token" });

test.beforeEach(async ({ page }) => {
  await page.addInitScript((session) => localStorage.setItem("stash.member-session", session), memberSession);
});

test("edits a stable linked Block with the collaborative React editor", async ({ page }) => {
  await page.goto(`/app/notes/${noteId}`);
  await expect(page.getByRole("heading", { name: "Release collaboration plan" })).toBeVisible();
  const editor = page.getByRole("textbox", { name: "Note content" });
  await expect(editor.locator("[data-block-id='66666666-6666-4666-8666-666666666666']")).toHaveText("Preserve this linked Block");
  await editor.locator("p").click(); await page.keyboard.press("End"); await page.keyboard.type(" after review");
  await expect(page.getByRole("status")).toHaveText("All changes saved");
  await expect(editor.locator("[data-block-id='66666666-6666-4666-8666-666666666666']")).toContainText("after review");
});

test("direct Note navigation replaces the Yjs document with the destination's authoritative snapshot", async ({ page }) => {
  await page.goto(`/app/notes/${noteId}`);
  await expect(page.getByRole("textbox", { name: "Note content" })).toContainText("Preserve this linked Block");
  await page.evaluate((destination) => {
    history.pushState(null, "", destination);
    dispatchEvent(new PopStateEvent("popstate"));
  }, `/app/notes/${secondNoteId}`);
  const editor = page.getByRole("textbox", { name: "Note content" });
  await expect(editor).toHaveText("Authoritative second Note");
  await expect(editor).not.toContainText("Stale canonical second Note");
  await expect(editor).not.toContainText("Preserve this linked Block");
});

test("offers link, callout, and Workspace Attachment authoring controls", async ({ page }) => {
  await page.goto(`/app/notes/${noteId}`);
  await expect(page.getByRole("button", { name: "Insert link" })).toBeVisible();
  await page.getByRole("button", { name: "Insert callout" }).click();
  await expect(page.getByRole("textbox", { name: "Note content" }).locator("[data-callout]")).toContainText("Callout");
  let prompt = 0;
  page.on("dialog", (dialog) => void dialog.accept(prompt++ === 0 ? "./attachments/attachment-id/design.pdf" : "Design brief"));
  await page.getByRole("button", { name: "Insert Workspace Attachment" }).click();
  await expect(page.getByRole("link", { name: "Design brief" })).toHaveAttribute("href", "./attachments/attachment-id/design.pdf");
});

test("preserves every checklist item and callout paragraph with stable identities", async ({ page }) => {
  await page.goto(`/app/notes/${richNoteId}`);
  const persisted = page.waitForResponse((response) => response.request().method() === "POST" && response.url().includes(`/api/notes/${richNoteId}/collaboration`));
  const editor = page.getByRole("textbox", { name: "Note content" });
  await editor.click(); await page.keyboard.press("ControlOrMeta+End"); await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Checklist" }).click();
  await page.keyboard.type("First acceptance item"); await page.keyboard.press("Enter"); await page.keyboard.type("Second acceptance item");
  await page.keyboard.press("ControlOrMeta+End"); await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Insert callout" }).click();
  await page.keyboard.press("End"); await page.keyboard.press("Enter"); await page.keyboard.type("Second callout paragraph");
  await persisted; await expect(page.getByRole("status")).toHaveText("All changes saved");
  const authoredItems = editor.locator("li[data-block-key]").filter({ hasText: /First acceptance item|Second acceptance item/ });
  const itemKeys = await authoredItems.evaluateAll((items) => items.map((item) => item.getAttribute("data-block-key")));
  expect(itemKeys).toHaveLength(2); expect(new Set(itemKeys).size).toBe(2);
  const calloutParagraphKeys = await editor.locator("[data-callout] p[data-block-key]").evaluateAll((items) => items.map((item) => item.getAttribute("data-block-key")));
  expect(calloutParagraphKeys).toHaveLength(2); expect(new Set(calloutParagraphKeys).size).toBe(2);
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Note content" })).toContainText("First acceptance item");
  await expect(page.getByRole("textbox", { name: "Note content" })).toContainText("Second acceptance item");
  await expect(page.getByRole("textbox", { name: "Note content" })).toContainText("Second callout paragraph");
});

test("two real editors merge concurrent contributions without changing linked Block identity", async ({ browser }) => {
  const firstContext = await browser.newContext(); const secondContext = await browser.newContext();
  await Promise.all([firstContext.addInitScript((session) => localStorage.setItem("stash.member-session", session), memberSession),
    secondContext.addInitScript((session) => localStorage.setItem("stash.member-session", session), memberSession)]);
  const first = await firstContext.newPage(); const second = await secondContext.newPage();
  await Promise.all([first.goto(`/app/notes/${noteId}`), second.goto(`/app/notes/${noteId}`)]);
  const firstBlock = first.getByRole("textbox", { name: "Note content" }).locator("[data-block-id='66666666-6666-4666-8666-666666666666']");
  const secondBlock = second.getByRole("textbox", { name: "Note content" }).locator("[data-block-id='66666666-6666-4666-8666-666666666666']");
  await Promise.all([firstBlock.click(), secondBlock.click()]);
  await Promise.all([first.keyboard.press("Home").then(() => first.keyboard.type("First ")),
    second.keyboard.press("End").then(() => second.keyboard.type(" Second"))]);
  await Promise.all([first.getByRole("status").waitFor(), second.getByRole("status").waitFor()]);
  await expect(firstBlock).toContainText("First", { timeout: 6_000 }); await expect(firstBlock).toContainText("Second", { timeout: 6_000 });
  await expect(firstBlock).toHaveAttribute("data-block-id", "66666666-6666-4666-8666-666666666666");
  await firstContext.close(); await secondContext.close();
});

test("the collaborative editor is keyboard operable and axe-clean @a11y", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" }); await page.goto(`/app/notes/${noteId}`);
  await page.getByRole("button", { name: "Bold" }).focus(); await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Bold" })).toHaveAttribute("aria-pressed", "true");
  const editor = page.getByRole("textbox", { name: "Note content" }); await editor.focus();
  await expect(editor).toBeFocused();
  expect(await editor.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe("none");
  const results = await new AxeBuilder({ page }).analyze(); expect(results.violations).toEqual([]);
});

test("a read-only Guest gets an axe-clean non-editable Note without local retries @a11y", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => localStorage.setItem("stash.member-session", JSON.stringify({ token: "browser-acceptance-guest-token" })));
  await page.goto(`/app/notes/${noteId}`);
  const editor = page.getByRole("textbox", { name: "Note content" });
  await expect(editor).toHaveAttribute("contenteditable", "false");
  await expect(page.getByRole("status")).toHaveText("Read-only Note");
  for (const control of await page.getByRole("toolbar", { name: "Text formatting" }).getByRole("button").all()) await expect(control).toBeDisabled();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test("initial collaboration errors preserve landmarks and recover accessibly @a11y", async ({ page }) => {
  let unavailable = true;
  await page.route("**/api/notes/**/collaboration", async (route) => {
    if (unavailable) await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "unavailable" }) });
    else await route.continue();
  });
  await page.goto(`/app/notes/${noteId}`);
  await expect(page.getByRole("main")).toBeVisible();
  const alert = page.getByRole("alert"); await expect(alert).toBeFocused({ timeout: 15_000 });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.keyboard.press("Tab"); const retry = page.getByRole("button", { name: "Try again" }); await expect(retry).toBeFocused();
  unavailable = false; await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Release collaboration plan" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Note content" })).toBeVisible();
});

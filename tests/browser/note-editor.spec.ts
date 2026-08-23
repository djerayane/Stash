import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const noteId = "99999999-9999-4999-8999-999999999999";
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

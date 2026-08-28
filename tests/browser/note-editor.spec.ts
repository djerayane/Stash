import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const noteId = "99999999-9999-4999-8999-999999999999";
const secondNoteId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const richNoteId = `cccccccc-cccc-4ccc-8ccc-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
const emptyCodeNoteId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const markdownNoteId = "14141414-1414-4414-8414-141414141414";
const principalBoundaryNoteId = "12121212-1212-4212-8212-121212121212";
const memberSession = JSON.stringify({ token: "browser-acceptance-member-token" });

test.beforeEach(async ({ page }) => {
  await page.addInitScript((session) => {
    if (!localStorage.getItem("stash.member-session")) localStorage.setItem("stash.member-session", session);
  }, memberSession);
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

test("keeps visible toolbar command labels inside their controls", async ({ page }) => {
  await page.goto(`/app/notes/${noteId}`);
  const toolbar = page.getByRole("toolbar", { name: "Text formatting" });
  await expect(toolbar.getByRole("button", { name: "Insert Workspace Attachment" })).toBeVisible();
  const overflowing = await toolbar.getByRole("button").evaluateAll((buttons) => buttons
    .filter((button) => button.scrollWidth > button.clientWidth)
    .map((button) => ({ name: button.getAttribute("aria-label") ?? button.textContent?.trim() ?? "unnamed", clientWidth: button.clientWidth, scrollWidth: button.scrollWidth, width: getComputedStyle(button).width })));
  expect(overflowing).toEqual([]);
});

test("keeps an arbitrary Note title within three lines at narrow width", async ({ page }) => {
  const longTitle = "Release collaboration strategy for every regional launch team and every carefully preserved decision";
  await page.route((url) => url.pathname === `/api/notes/${noteId}`, (route) => route.fulfill({ json: {
    id: noteId, revision: 1, content: longTitle, document: { type: "doc", blocks: [{ type: "paragraph", blockKey: "title-wrap-seed", content: [{ text: "Body" }] }] },
  } }));
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto(`/app/notes/${noteId}`);
  const heading = page.getByRole("heading", { name: longTitle });
  await expect(heading).toBeVisible();
  const renderedLines = await heading.evaluate((title) => Math.round(title.clientHeight / Number.parseFloat(getComputedStyle(title).lineHeight)));
  expect(renderedLines).toBeLessThanOrEqual(3);
});

test("preserves every checklist item and callout paragraph with stable identities", async ({ page }) => {
  await page.goto(`/app/notes/${richNoteId}`);
  const editor = page.getByRole("textbox", { name: "Note content" });
  await expect(editor).toContainText("Rich structure seed");
  await expect(page.getByRole("status")).toHaveText("All changes saved");
  const seedParagraph = editor.locator("p").last();
  await seedParagraph.evaluate((paragraph) => {
    const range = document.createRange();
    range.selectNodeContents(paragraph); range.collapse(false);
    const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
    (paragraph.parentElement?.closest("[contenteditable='true']") as HTMLElement | null)?.focus();
  });
  await page.keyboard.press("Enter");
  const trailingParagraph = editor.locator("p").last();
  await expect(trailingParagraph).toHaveText("");
  await trailingParagraph.click();
  await page.getByRole("button", { name: "Checklist" }).click();
  const firstChecklistItem = editor.locator("li[data-block-key]").last();
  await expect(firstChecklistItem).toBeVisible();
  await firstChecklistItem.locator("p").click();
  await page.keyboard.insertText("First acceptance item");
  await expect(editor.getByText("First acceptance item", { exact: true })).toBeVisible();
  await page.keyboard.press("Enter"); await page.keyboard.insertText("Second acceptance item");
  await expect(editor.getByText("Second acceptance item", { exact: true })).toBeVisible();
  await page.keyboard.press("Enter"); await page.keyboard.insertText("Nested acceptance item");
  await expect(editor.getByText("Nested acceptance item", { exact: true })).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(editor.locator("li li").filter({ hasText: "Nested acceptance item" })).toBeVisible();
  await expect.poll(() => page.evaluate(async (id) => (await fetch(`/api/notes/${id}`, { headers: { authorization: "Bearer browser-acceptance-member-token" } })).json()
    .then((note: { content: string }) => note.content), richNoteId)).toContain("Nested acceptance item");
  const authoredItems = ["First acceptance item", "Second acceptance item", "Nested acceptance item"].map((content) =>
    editor.getByText(content, { exact: true }).locator("xpath=ancestor::li[@data-block-key][1]"));
  await Promise.all(authoredItems.map((item) => expect(item).toHaveCount(1)));
  const itemKeys = await Promise.all(authoredItems.map((item) => item.getAttribute("data-block-key")));
  expect(itemKeys).toHaveLength(3); expect(new Set(itemKeys).size).toBe(3);
  await page.keyboard.press("ControlOrMeta+End"); await page.keyboard.press("Enter"); await page.keyboard.press("Enter"); await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Insert callout" }).click();
  const insertedCalloutParagraph = editor.locator("[data-callout] p").filter({ hasText: "Callout" });
  await expect(insertedCalloutParagraph).toHaveCount(1);
  await insertedCalloutParagraph.click();
  await page.keyboard.press("End"); await page.keyboard.press("Enter");
  await page.keyboard.insertText("Second callout paragraph.");
  await expect(editor.getByText("Second callout paragraph.", { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(async (id) => (await fetch(`/api/notes/${id}`, { headers: { authorization: "Bearer browser-acceptance-member-token" } })).json()
    .then((note: { content: string }) => note.content), richNoteId)).toContain("Second callout paragraph.");
  await expect(page.getByRole("status")).toHaveText("All changes saved");
  const calloutParagraphs = editor.locator("[data-callout] p[data-block-key]");
  await expect(calloutParagraphs).toHaveCount(2);
  const calloutParagraphKeys = await calloutParagraphs.evaluateAll((items) => items.map((item) => item.getAttribute("data-block-key")));
  expect(calloutParagraphKeys).toHaveLength(2); expect(new Set(calloutParagraphKeys).size).toBe(2);
  const canonical = await page.evaluate(async (id) => (await fetch(`/api/notes/${id}`, { headers: { authorization: "Bearer browser-acceptance-member-token" } })).json(), richNoteId) as {
    content: string; document: { blocks: Array<{ type: string; children?: unknown[]; paragraphs?: unknown[] }> };
  };
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Note content" })).toContainText("First acceptance item");
  await expect(page.getByRole("textbox", { name: "Note content" })).toContainText("Second acceptance item");
  await expect(page.getByRole("textbox", { name: "Note content" }).locator("li li").filter({ hasText: "Nested acceptance item" })).toBeVisible();
  const restoredItemKeys = await Promise.all(["First acceptance item", "Second acceptance item", "Nested acceptance item"].map((content) =>
    page.getByRole("textbox", { name: "Note content" }).getByText(content, { exact: true }).locator("xpath=ancestor::li[@data-block-key][1]").getAttribute("data-block-key")));
  expect(restoredItemKeys).toEqual(itemKeys);
  await expect(page.getByRole("textbox", { name: "Note content" })).toContainText("Second callout paragraph");
  const restoredCallout = page.getByRole("textbox", { name: "Note content" }).locator("[data-callout]");
  await expect(restoredCallout.locator("p")).toHaveCount(2);
  expect(await restoredCallout.locator("p").evaluateAll((items) => items.map((item) => item.getAttribute("data-block-key")))).toEqual(calloutParagraphKeys);
  expect(canonical.content).toContain("  - [ ] Nested acceptance item");
  expect(canonical.content).toContain(">\n> Second callout paragraph");
  expect(canonical.document.blocks.find((block) => block.type === "check" && block.children?.length)?.children).toHaveLength(1);
  expect(canonical.document.blocks.find((block) => block.type === "callout")?.paragraphs).toHaveLength(2);
});

test("edits technical constructs through portable Markdown and rejects unsupported source without data loss", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`/app/notes/${markdownNoteId}`);
  await expect(page.getByRole("textbox", { name: "Note content" })).toContainText("Technical source seed");
  await page.getByRole("tab", { name: "Rich text" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Markdown source" })).toBeFocused();
  await expect(page.getByRole("tab", { name: "Markdown source" })).toHaveAttribute("aria-selected", "false");
  await page.keyboard.press("Space");
  const source = page.getByRole("textbox", { name: "Markdown source" });
  const technicalDraft = "## Technical handoff\n\n> [!WARNING]\n> Keep a backup\n\n| Owner | State |\n| --- | --- |\n| Ada | Ready |\n\n```ts\nconst durable = true\n```";
  await source.fill(technicalDraft);
  await expect(page.getByRole("status")).toHaveText("Markdown draft kept on this device — not applied");
  page.once("dialog", (dialog) => void dialog.dismiss());
  await page.getByRole("link", { name: "Notifications" }).click();
  await expect(page).toHaveURL(`/app/notes/${markdownNoteId}`);
  page.once("dialog", (dialog) => void dialog.accept());
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Note content" })).toHaveAttribute("aria-readonly", "false");
  await page.getByRole("tab", { name: "Markdown source" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("textbox", { name: "Markdown source" })).toHaveValue(technicalDraft);
  await expect(page.getByRole("status")).toHaveText("Markdown draft kept on this device — not applied");
  const persisted = page.waitForResponse((response) => response.request().method() === "POST" && response.url().includes(`/api/notes/${markdownNoteId}/collaboration`));
  await page.getByRole("tab", { name: "Markdown source" }).focus();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("tab", { name: "Rich text" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("textbox", { name: "Note content" }).locator("pre")).toContainText("const durable = true");
  await persisted;
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Note content" }).locator("pre")).toContainText("const durable = true");

  await page.getByRole("tab", { name: "Markdown source" }).focus();
  await page.keyboard.press("Enter");
  const reloadedSource = page.getByRole("textbox", { name: "Markdown source" });
  await reloadedSource.fill(":::unsupported");
  await page.getByRole("tab", { name: "Rich text" }).focus();
  await page.keyboard.press("Space");
  await expect(page.getByText(/Markdown contains a construct Stash cannot round-trip/)).toBeVisible();
  await expect(reloadedSource).toHaveValue(":::unsupported");
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test("persists an empty code block as a normal editing state", async ({ page }) => {
  await page.goto(`/app/notes/${emptyCodeNoteId}`);
  const persisted = page.waitForResponse((response) => response.request().method() === "POST" && response.url().includes(`/api/notes/${emptyCodeNoteId}/collaboration`));
  await page.getByRole("tab", { name: "Markdown source" }).click();
  await page.getByRole("textbox", { name: "Markdown source" }).fill("```\n\n```");
  await page.getByRole("tab", { name: "Rich text" }).click();
  await expect(page.getByRole("textbox", { name: "Note content" }).locator("pre")).toBeVisible();
  await persisted;
  await expect(page.getByRole("status")).toHaveText("All changes saved");
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Note content" }).locator("pre")).toBeVisible();
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

test("a replacement Member cannot see or submit a revoked Member's offline contribution", async ({ page }) => {
  await page.route(`**/api/notes/${principalBoundaryNoteId}/collaboration`, async (route) => {
    if (route.request().method() === "POST" && route.request().headers().authorization === "Bearer browser-acceptance-member-token")
      await route.abort("failed");
    else await route.continue();
  });
  await page.goto(`/app/notes/${principalBoundaryNoteId}`);
  const firstEditor = page.getByRole("textbox", { name: "Note content" });
  await firstEditor.click(); await page.keyboard.press("End"); await page.keyboard.type(" revoked offline contribution");
  await expect(page.getByRole("status")).toHaveText("Changes kept on this device");
  const firstPendingKey = `stash.pending-note-update:11111111-1111-4111-8111-111111111111:${principalBoundaryNoteId}`;
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), firstPendingKey)).not.toBeNull();

  await page.evaluate(() => localStorage.setItem("stash.member-session", JSON.stringify({ token: "browser-acceptance-second-member-token" })));
  await page.reload();
  await expect(page.getByText("Second Browser Member", { exact: true })).toBeVisible();
  const secondEditor = page.getByRole("textbox", { name: "Note content" });
  await expect(secondEditor).toContainText("Principal boundary seed");
  await expect(secondEditor).not.toContainText("revoked offline contribution");
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), firstPendingKey)).not.toBeNull();
  const secondPersisted = page.waitForResponse((response) => response.request().method() === "POST"
    && response.request().headers().authorization === "Bearer browser-acceptance-second-member-token");
  await secondEditor.click(); await page.keyboard.press("End"); await page.keyboard.type(" second Member contribution");
  await secondPersisted;
  await expect(page.getByRole("status")).toHaveText("All changes saved");
  const snapshot = await page.evaluate(async ({ id }) => (await fetch(`/api/notes/${id}/collaboration`, {
    headers: { authorization: "Bearer browser-acceptance-second-member-token" },
  })).json(), { id: principalBoundaryNoteId }) as { updatedByMemberId: string };
  expect(snapshot.updatedByMemberId).toBe("browser-second-member");
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
  const alert = page.getByRole("alert").filter({ hasText: "The Note editor is unavailable." }); await expect(alert).toBeFocused({ timeout: 15_000 });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.keyboard.press("Tab"); const retry = page.getByRole("button", { name: "Try again" }); await expect(retry).toBeFocused();
  unavailable = false; await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Release collaboration plan" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Note content" })).toBeVisible();
});

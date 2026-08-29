import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const noteId = "99999999-9999-4999-8999-999999999999";
const secondNoteId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const workspaceId = "88888888-8888-4888-8888-888888888888";
const token = "browser-acceptance-member-token";

test.beforeEach(async ({ page }) => {
  await page.addInitScript((value) => localStorage.setItem("stash.member-session", JSON.stringify({ token: value })), token);
});

async function createCollection(page: Page, input: Record<string, unknown>, ownerNoteId = noteId) {
  const response = await page.request.post(`/api/notes/${ownerNoteId}/collections`, {
    headers: { authorization: `Bearer ${token}` }, data: input,
  });
  expect(response.status()).toBe(201);
}

async function createView(page: Page, input: Record<string, unknown>, ownerNoteId = noteId) {
  const response = await page.request.post(`/api/notes/${ownerNoteId}/view-blocks`, {
    headers: { authorization: `Bearer ${token}` }, data: input,
  });
  expect(response.status()).toBe(201);
}

test("creates and edits a Collection without leaving its table", async ({ page }) => {
  await page.goto(`/app/notes/${noteId}`);
  const created = page.waitForResponse((response) => response.url().endsWith(`/api/notes/${noteId}/collections`)
    && response.request().method() === "POST");
  await page.getByRole("button", { name: "New collection" }).press("Enter");
  const collectionId = ((await (await created).json()) as { collection: { id: string } }).collection.id;
  const collection = page.getByRole("region", { name: "Untitled collection" });
  await expect(collection.getByRole("columnheader", { name: "Name" })).toBeVisible();
  await expect(collection.getByRole("textbox", { name: "Collection title" })).toBeFocused();

  await collection.getByRole("button", { name: "Add property" }).press("Enter");
  await page.getByRole("textbox", { name: "Property name" }).fill("Status");
  await page.getByRole("combobox", { name: "Property type" }).selectOption("single_select");
  await page.getByRole("button", { name: "Add option" }).press("Enter");
  await page.getByRole("textbox", { name: "Option 1" }).fill("Research");
  await page.getByRole("button", { name: "Add option" }).press("Enter");
  await page.getByRole("textbox", { name: "Option 2" }).fill("Ready");
  await page.getByRole("button", { name: "Add property" }).press("Enter");
  await expect(collection.getByRole("columnheader", { name: "Status" })).toBeVisible();

  await collection.getByRole("button", { name: "New record" }).press("Enter");
  const name = collection.getByRole("textbox", { name: "Name, new record" });
  await name.fill("Research");
  await name.press("Enter");
  const savedName = collection.getByRole("textbox", { name: "Name, Research" });
  await expect(savedName).toHaveValue("Research");

  const renamed = page.waitForResponse((response) => response.url().endsWith(`/api/collections/${collectionId}`)
    && response.request().method() === "PATCH");
  const title = page.getByRole("textbox", { name: "Collection title" });
  await title.fill("Browser research");
  await title.press("Enter");
  expect((await renamed).status()).toBe(200);
  await expect(page.getByRole("region", { name: "Browser research" })).toBeVisible();
});

test("requests presentation requirements in context and keeps advanced controls behind View", async ({ page }) => {
  const collectionId = "20202020-2020-4020-8020-202020202020"; const textId = "21212121-2121-4121-8121-212121212121";
  await createCollection(page, { schema: "stash.collection.v1", id: collectionId, workspaceId, ownerNoteId: noteId,
    title: "Presentation research", properties: [{ id: textId, name: "Name", type: "text", position: 1 }], records: [] });
  await page.goto(`/app/notes/${noteId}`);
  const collection = page.getByRole("region", { name: "Presentation research" });
  await expect(collection.getByRole("combobox", { name: "Filter by" })).toHaveCount(0);
  await collection.getByRole("button", { name: "Calendar" }).press("Enter");
  await expect(collection.getByText("Calendar needs a date property.")).toBeVisible();
  await collection.getByRole("button", { name: "Add date property" }).press("Enter");
  await expect(collection.getByRole("region", { name: "Presentation research calendar" })).toBeVisible();
  await collection.getByRole("button", { name: "View" }).press("Enter");
  await expect(collection.getByRole("combobox", { name: "Filter by" })).toBeVisible();
  await expect(collection.getByRole("combobox", { name: "Density" })).toBeVisible();
});

test("renames, reorders, and deletes a property from its header", async ({ page }) => {
  const collectionId = "51515151-5151-4151-8151-515151515151";
  const nameId = "52525252-5252-4252-8252-525252525252";
  const statusId = "53535353-5353-4353-8353-535353535353";
  const detailsId = "54545454-5454-4454-8454-545454545454";
  await createCollection(page, { schema: "stash.collection.v1", id: collectionId, workspaceId, ownerNoteId: noteId,
    title: "Property journey", properties: [
      { id: nameId, name: "Name", type: "text", position: 1 },
      { id: statusId, name: "Status", type: "single_select", position: 2, options: [{ id: "open", name: "Open" }] },
      { id: detailsId, name: "Details", type: "text", position: 3 },
    ], records: [{ id: "55555555-5555-4555-8555-555555555555", position: 1,
      values: { [nameId]: "First", [statusId]: "open", [detailsId]: "Evidence" } }] });
  await page.goto(`/app/notes/${noteId}`);
  const collection = page.getByRole("region", { name: "Property journey" });

  await collection.getByRole("button", { name: "Edit Status property" }).press("Enter");
  const rename = page.waitForResponse((response) => response.url().endsWith(`/api/collections/${collectionId}/properties/${statusId}`)
    && response.request().method() === "PATCH");
  await page.getByRole("textbox", { name: "Property name" }).fill("Stage");
  await page.getByRole("button", { name: "Save property" }).press("Enter");
  expect((await rename).status()).toBe(200);
  await expect(collection.getByRole("columnheader", { name: "Stage" })).toBeVisible();

  await collection.getByRole("button", { name: "Edit Stage property" }).press("Enter");
  const reorder = page.waitForResponse((response) => response.url().endsWith(`/api/collections/${collectionId}/properties/order`)
    && response.request().method() === "PATCH");
  await page.getByRole("button", { name: "Move right" }).press("Enter");
  expect((await reorder).status()).toBe(200);
  await expect.poll(() => collection.locator("thead th").allTextContents()).toEqual(["Name", "Details", "Stage", "Add property"]);

  await collection.getByRole("button", { name: "Edit Stage property" }).press("Enter");
  await page.getByRole("button", { name: "Delete property" }).press("Enter");
  const dialog = page.getByRole("dialog", { name: "Delete Stage property?" });
  await expect(dialog.getByText("1 saved value will be removed.")).toBeVisible();
  const deleted = page.waitForResponse((response) => response.url().endsWith(`/api/collections/${collectionId}/properties/${statusId}`)
    && response.request().method() === "DELETE");
  await dialog.getByRole("button", { name: "Delete property" }).press("Enter");
  expect((await deleted).status()).toBe(200);
  await expect(collection.getByRole("columnheader", { name: "Stage" })).toHaveCount(0);
});

test("preserves a record draft through save, access, and synchronization failures", async ({ page }) => {
  const collectionId = "56565656-5656-4656-8656-565656565656";
  const propertyId = "57575757-5757-4757-8757-575757575757";
  const recordId = "58585858-5858-4858-8858-585858585858";
  await createCollection(page, { schema: "stash.collection.v1", id: collectionId, workspaceId, ownerNoteId: noteId,
    title: "Recovery journey", properties: [{ id: propertyId, name: "Name", type: "text", position: 1 }],
    records: [{ id: recordId, position: 1, values: { [propertyId]: "Original draft" } }] });
  let attempt = 0;
  await page.route(`**/api/collections/${collectionId}/records/${recordId}`, async (route) => {
    if (route.request().method() !== "PATCH") { await route.continue(); return; }
    attempt += 1;
    if (attempt === 1) { await route.fulfill({ status: 503, contentType: "application/json",
      body: JSON.stringify({ message: "Synchronization temporarily unavailable." }) }); return; }
    if (attempt === 2) { await route.fulfill({ status: 403, contentType: "application/json",
      body: JSON.stringify({ message: "Access to this Collection changed." }) }); return; }
    if (attempt === 3) { await route.abort("failed"); return; }
    await route.continue();
  });
  await page.goto(`/app/notes/${noteId}`);
  const collection = page.getByRole("region", { name: "Recovery journey" });
  const value = collection.getByRole("textbox", { name: "Name, Original draft" });
  await value.fill("Work that must survive"); await value.press("Enter");
  await expect(collection.getByRole("alert")).toContainText("Value not saved");
  await expect(value).toHaveValue("Work that must survive");
  const inlineRetryBox = await collection.getByRole("button", { name: "Retry Name" }).boundingBox();
  expect(inlineRetryBox?.width).toBeGreaterThanOrEqual(44);
  expect(inlineRetryBox?.height).toBeGreaterThanOrEqual(44);

  for (const expectedAttempt of [2, 3]) {
    await collection.getByRole("button", { name: "Retry Name" }).press("Enter");
    await expect.poll(() => attempt).toBe(expectedAttempt);
    await expect(value).toHaveValue("Work that must survive");
    await expect(collection.getByRole("alert")).toContainText("Value not saved");
  }
  const recovered = page.waitForResponse((response) => response.url().endsWith(`/api/collections/${collectionId}/records/${recordId}`)
    && response.request().method() === "PATCH" && response.status() === 200);
  await collection.getByRole("button", { name: "Retry Name" }).press("Enter");
  await recovered;
  await expect(collection.getByRole("alert")).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("region", { name: "Recovery journey" })
    .getByRole("textbox", { name: "Name, Work that must survive" })).toHaveValue("Work that must survive");
});

test("inserts a canonical view from another Note and reviews deletion impact", async ({ page }) => {
  const collectionId = "31313131-3131-4131-8131-313131313131";
  const propertyId = "32323232-3232-4232-8232-323232323232";
  const recordId = "33333333-3333-4333-8333-333333333333";
  await createCollection(page, { schema: "stash.collection.v1", id: collectionId, workspaceId, ownerNoteId: secondNoteId,
    title: "Cross-note source", properties: [{ id: propertyId, name: "Name", type: "text", position: 1 }],
    records: [{ id: recordId, position: 1, values: { [propertyId]: "Portable record" } }] }, secondNoteId);

  await page.goto(`/app/notes/${noteId}`);
  await page.getByRole("button", { name: "Insert view of another collection" }).press("Enter");
  const source = page.getByRole("combobox", { name: "Collection source" });
  await expect(source.getByRole("option", { name: /Cross-note source — / })).toHaveCount(1);
  await source.selectOption(collectionId);
  await page.getByRole("button", { name: "Insert view", exact: true }).press("Enter");
  const reused = page.getByRole("region", { name: "Cross-note source" });
  await expect(reused).toBeVisible();
  await expect(reused.getByText(/View of Cross-note source · From /)).toBeVisible();
  await expect(reused.getByRole("button", { name: "Collection actions" })).toHaveCount(0);
  await reused.getByRole("button", { name: "Edit Name, Portable record" }).press("Enter");
  const disclosure = page.getByRole("dialog", { name: "Edit this canonical record?" });
  await expect(disclosure.getByText(/one shared source of truth/)).toBeVisible();
  await disclosure.getByRole("button", { name: "Continue editing" }).press("Enter");
  const canonicalCell = reused.getByRole("textbox", { name: "Name, Portable record" });
  await expect(canonicalCell).toBeFocused();
  const canonicalSave = page.waitForResponse((response) => response.url().endsWith(`/api/collections/${collectionId}/records/${recordId}`)
    && response.request().method() === "PATCH");
  await canonicalCell.fill("Portable record updated");
  await canonicalCell.press("Enter");
  expect((await canonicalSave).status()).toBe(200);

  await page.goto(`/app/notes/${secondNoteId}`);
  const collection = page.getByRole("region", { name: "Cross-note source" });
  await expect(collection.getByRole("textbox", { name: "Name, Portable record updated" })).toHaveValue("Portable record updated");
  await collection.getByRole("button", { name: "Collection actions" }).press("Enter");
  await collection.getByRole("button", { name: "Delete collection" }).press("Enter");
  const dialog = page.getByRole("dialog", { name: "Delete Cross-note source collection?" });
  await expect(dialog.getByText("1 inserted view will be removed.")).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel deletion" }).press("Enter");
  await expect(collection.getByRole("button", { name: "Collection actions" })).toBeFocused();
});

test("keeps keyboard focus and multi-select Board moves within one saved View", async ({ page }) => {
  const collectionId = "41414141-4141-4141-8141-414141414141"; const titleId = "42424242-4242-4242-8242-424242424242";
  const statusId = "43434343-4343-4343-8343-434343434343"; const recordId = "44444444-4444-4444-8444-444444444444";
  const viewId = "45454545-4545-4545-8545-454545454545";
  await createCollection(page, { schema: "stash.collection.v1", id: collectionId, workspaceId, ownerNoteId: noteId,
    title: "Keyboard source", properties: [{ id: titleId, name: "Name", type: "text", position: 1 },
      { id: statusId, name: "Status", type: "multi_select", position: 2, options: [
        { id: "open", name: "Open" }, { id: "blocked", name: "Blocked" }, { id: "done", name: "Done" },
      ] }], records: [{ id: recordId, position: 1, values: { [titleId]: "Scoped record", [statusId]: ["open", "blocked"] } }] });
  await createView(page, { schema: "stash.view-block.v1", id: viewId, workspaceId, ownerNoteId: noteId,
    blockId: "46464646-4646-4646-8646-464646464646", title: "Scoped lens",
    definition: { source: { kind: "collection", collectionId }, presentation: "table", filters: [], sorts: [], groupBy: statusId, layout: {} } });
  await page.goto(`/app/notes/${noteId}`);
  const savedView = page.getByRole("region", { name: "Scoped lens" }); const name = savedView.getByRole("textbox", { name: "Name, Scoped record" });
  await name.focus(); await name.evaluate((element) => (element as HTMLInputElement).setSelectionRange(13, 13)); await name.press("ArrowRight");
  await expect(savedView.getByRole("listbox", { name: "Status, Scoped record" })).toBeFocused();

  const viewSave = page.waitForResponse((response) => response.url().endsWith(`/api/view-blocks/${viewId}`) && response.request().method() === "PATCH");
  await savedView.getByRole("button", { name: "Board" }).press("Enter"); expect((await viewSave).status()).toBe(200);
  for (const target of [savedView.getByRole("button", { name: "Scoped record" }).first(),
    savedView.getByRole("region", { name: "Open" }).getByRole("button", { name: "Move Scoped record to Done" })]) {
    const box = await target.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.height).toBeGreaterThanOrEqual(44);
  }
  let boardAttempt = 0;
  await page.route(`**/api/collections/${collectionId}/records/${recordId}`, async (route) => {
    if (route.request().method() !== "PATCH") { await route.continue(); return; }
    boardAttempt += 1;
    if (boardAttempt === 1) { await route.fulfill({ status: 503, contentType: "application/json",
      body: JSON.stringify({ message: "Synchronization temporarily unavailable." }) }); return; }
    await route.continue();
  });
  await savedView.getByRole("region", { name: "Open" }).getByRole("button", { name: "Move Scoped record to Done" }).press("Enter");
  const boardRetry = savedView.getByRole("region", { name: "Open" }).getByRole("button", { name: "Try again" });
  await expect(boardRetry).toBeVisible();
  const boardRetryBox = await boardRetry.boundingBox();
  expect(boardRetryBox?.width).toBeGreaterThanOrEqual(44);
  expect(boardRetryBox?.height).toBeGreaterThanOrEqual(44);
  const recordSave = page.waitForResponse((response) => response.url().endsWith(`/api/collections/${collectionId}/records/${recordId}`)
    && response.request().method() === "PATCH" && response.status() === 200);
  await boardRetry.press("Enter");
  const saved = await recordSave; expect(saved.status()).toBe(200);
  expect(saved.request().postDataJSON()).toEqual({ values: { [statusId]: ["blocked", "done"] } });
});

test("moves and then deletes a Collection through complete impact previews", async ({ page }) => {
  const collectionId = "59595959-5959-4959-8959-595959595959";
  const propertyId = "60606060-6060-4060-8060-606060606060";
  await createCollection(page, { schema: "stash.collection.v1", id: collectionId, workspaceId, ownerNoteId: noteId,
    title: "Consequential journey", properties: [{ id: propertyId, name: "Name", type: "text", position: 1 }],
    records: [{ id: "61616161-6161-4161-8161-616161616161", position: 1, values: { [propertyId]: "Carry me" } }] });
  await page.goto(`/app/notes/${noteId}`);
  let collection = page.getByRole("region", { name: "Consequential journey" });
  await collection.getByRole("button", { name: "Collection actions" }).press("Enter");
  await collection.getByRole("button", { name: "Move to another Note" }).press("Enter");
  const moveDialog = page.getByRole("dialog", { name: "Move Consequential journey collection?" });
  await expect(moveDialog.getByText("1 record will move with this Collection.")).toBeVisible();
  await moveDialog.getByRole("combobox", { name: "Destination Note" }).selectOption(secondNoteId);
  const moved = page.waitForResponse((response) => response.url().endsWith(`/api/notes/${noteId}/collections/relocate`)
    && response.request().method() === "POST");
  await moveDialog.getByRole("button", { name: "Move collection" }).press("Enter");
  expect((await moved).status()).toBe(200);
  await expect(collection).toHaveCount(0);

  await page.goto(`/app/notes/${secondNoteId}`);
  collection = page.getByRole("region", { name: "Consequential journey" });
  await expect(collection.getByRole("textbox", { name: "Name, Carry me" })).toHaveValue("Carry me");
  await collection.getByRole("button", { name: "Collection actions" }).press("Enter");
  await collection.getByRole("button", { name: "Delete collection" }).press("Enter");
  const deleteDialog = page.getByRole("dialog", { name: "Delete Consequential journey collection?" });
  await expect(deleteDialog.getByText("1 record will be deleted.")).toBeVisible();
  const deleted = page.waitForResponse((response) => response.url().endsWith(`/api/notes/${secondNoteId}/collections/delete`)
    && response.request().method() === "POST");
  await deleteDialog.getByRole("button", { name: "Delete collection" }).press("Enter");
  expect((await deleted).status()).toBe(200);
  await expect(collection).toHaveCount(0);
});

test("keeps direct Collection controls keyboard-ready, narrow, reduced-motion, and axe-clean @a11y", async ({ page }) => {
  const collectionId = "36363636-3636-4636-8636-363636363636"; const titleId = "37373737-3737-4737-8737-373737373737";
  await createCollection(page, { schema: "stash.collection.v1", id: collectionId, workspaceId, ownerNoteId: noteId,
    title: "Accessible authoring", properties: [{ id: titleId, name: "Name", type: "text", position: 1 }],
    records: [{ id: "38383838-3838-4838-8838-383838383838", position: 1, values: { [titleId]: "Existing" } }] });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 320, height: 760 });
  await page.goto(`/app/notes/${noteId}`);
  const collection = page.getByRole("region", { name: "Accessible authoring" });
  const targets = [collection.getByRole("button", { name: "Table" }), collection.getByRole("button", { name: "New record" }),
    collection.getByRole("button", { name: "Collection actions" })];
  for (const target of targets) { const box = await target.boundingBox(); expect(box?.width).toBeGreaterThanOrEqual(44); expect(box?.height).toBeGreaterThanOrEqual(44); }
  const motion = await collection.getByRole("button", { name: "New record" }).evaluate((element) => {
    const style = getComputedStyle(element); return { transition: style.transitionDuration, animation: style.animationDuration };
  });
  expect(motion).toEqual({ transition: "0s", animation: "0s" });
  await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
  await collection.getByRole("button", { name: "New record" }).press("Enter");
  await expect(collection.getByRole("textbox", { name: "Name, new record" })).toBeFocused();
  const bounds = await collection.evaluate((element) => { const rectangle = element.getBoundingClientRect();
    return { left: rectangle.left, right: rectangle.right, viewport: window.innerWidth }; });
  expect(bounds.left).toBeGreaterThanOrEqual(-1); expect(bounds.right).toBeLessThanOrEqual(bounds.viewport + 1);
  expect((await new AxeBuilder({ page }).include('[aria-labelledby="collections-heading"]').analyze()).violations).toEqual([]);
  await page.setViewportSize({ width: 1280, height: 800 }); await page.goto("/app/notes");
  for (const target of [page.getByRole("button", { name: "Create root Note" }).first(),
    page.getByRole("button", { name: "Collapse Release collaboration plan" }).first()]) {
    const box = await target.boundingBox(); expect(box?.width).toBeGreaterThanOrEqual(44); expect(box?.height).toBeGreaterThanOrEqual(44);
  }
});

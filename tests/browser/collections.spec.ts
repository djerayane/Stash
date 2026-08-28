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
  const canonicalCell = reused.getByRole("textbox", { name: "Name, Portable record" });
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

test("keeps direct Collection controls keyboard-ready, narrow, reduced-motion, and axe-clean @a11y", async ({ page }) => {
  const collectionId = "36363636-3636-4636-8636-363636363636"; const titleId = "37373737-3737-4737-8737-373737373737";
  await createCollection(page, { schema: "stash.collection.v1", id: collectionId, workspaceId, ownerNoteId: noteId,
    title: "Accessible authoring", properties: [{ id: titleId, name: "Name", type: "text", position: 1 }],
    records: [{ id: "38383838-3838-4838-8838-383838383838", position: 1, values: { [titleId]: "Existing" } }] });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 320, height: 760 });
  await page.goto(`/app/notes/${noteId}`);
  await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
  const collection = page.getByRole("region", { name: "Accessible authoring" });
  await collection.getByRole("button", { name: "New record" }).press("Enter");
  await expect(collection.getByRole("textbox", { name: "Name, new record" })).toBeFocused();
  const bounds = await collection.evaluate((element) => { const rectangle = element.getBoundingClientRect();
    return { left: rectangle.left, right: rectangle.right, viewport: window.innerWidth }; });
  expect(bounds.left).toBeGreaterThanOrEqual(-1); expect(bounds.right).toBeLessThanOrEqual(bounds.viewport + 1);
  expect((await new AxeBuilder({ page }).include('[aria-labelledby="collections-heading"]').analyze()).violations).toEqual([]);
});

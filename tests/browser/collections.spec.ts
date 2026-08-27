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

test("creates the first Collection and reuses it through table, list, and calendar View Blocks", async ({ page }) => {
  await page.goto(`/app/notes/${noteId}`);
  await page.getByRole("button", { name: "New Collection" }).press("Enter");
  await page.getByRole("textbox", { name: "Collection title" }).fill("Browser milestones");
  await page.getByRole("textbox", { name: "First property" }).fill("When");
  await page.getByRole("combobox", { name: "Property type" }).selectOption("date_time");
  const created = page.waitForResponse((response) => response.url().endsWith(`/api/notes/${noteId}/collections`)
    && response.request().method() === "POST");
  await page.getByRole("button", { name: "Create Collection" }).press("Enter");
  const collectionId = ((await (await created).json()) as { collection: { id: string } }).collection.id;

  await page.getByRole("combobox", { name: "Source Collection" }).selectOption(collectionId);
  await page.getByRole("button", { name: "Add View Block" }).press("Enter");
  const view = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Browser milestones view" }) });
  await expect(view.getByRole("table", { name: "Browser milestones view" })).toBeVisible();
  await view.getByRole("combobox", { name: "Presentation" }).selectOption("list");
  await expect(view.getByRole("list", { name: "Browser milestones view" })).toBeVisible();
  await view.getByRole("combobox", { name: "Presentation" }).selectOption("calendar");
  await expect(view.getByRole("region", { name: "Browser milestones view calendar" })).toBeVisible();
});

test("embeds an accessible Collection from another Note and confirms its exact deletion impact", async ({ page }) => {
  const collectionId = "31313131-3131-4131-8131-313131313131";
  const propertyId = "32323232-3232-4232-8232-323232323232";
  const recordId = "33333333-3333-4333-8333-333333333333";
  await createCollection(page, { schema: "stash.collection.v1", id: collectionId, workspaceId, ownerNoteId: secondNoteId,
    title: "Cross-note source", properties: [{ id: propertyId, name: "Name", type: "text", position: 1 }],
    records: [{ id: recordId, position: 1, values: { [propertyId]: "Portable record" } }] }, secondNoteId);

  await page.goto(`/app/notes/${noteId}`);
  await page.getByRole("combobox", { name: "Source Collection" }).selectOption(collectionId);
  await page.getByRole("button", { name: "Add View Block" }).press("Enter");
  await expect(page.getByRole("table", { name: "Cross-note source view" })).toBeVisible();

  await page.goto(`/app/notes/${secondNoteId}`);
  await page.getByRole("button", { name: "Review removal impact" }).press("Enter");
  await expect(page.getByText("1 View Block will be removed.")).toBeVisible();
  const remove = page.getByRole("button", { name: "Permanently delete selected Collections" });
  await expect(remove).toBeDisabled();
  await page.getByRole("checkbox", { name: "Delete Cross-note source and its 1 record" }).check();
  await page.getByRole("checkbox", { name: "I understand this permanently deletes the selected records, relations, and View Blocks" }).check();
  const deleted = page.waitForResponse((response) => response.url().endsWith(`/api/notes/${secondNoteId}/collections/delete`)
    && response.request().method() === "POST");
  await remove.press("Enter");
  expect((await deleted).status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Cross-note source" })).toHaveCount(0);
});

test("moves a Collection record without drag and keeps every View control axe-clean @a11y", async ({ page }) => {
  const collectionId = "20202020-2020-4020-8020-202020202020";
  const textId = "21212121-2121-4121-8121-212121212121";
  const statusId = "22222222-2222-4222-8222-222222222222";
  const dateId = "23232323-2323-4323-8323-232323232323";
  const recordId = "24242424-2424-4424-8424-242424242424";
  await createCollection(page, { schema: "stash.collection.v1", id: collectionId, workspaceId, ownerNoteId: noteId,
    title: "Accessible research", properties: [
      { id: textId, name: "Idea", type: "text", position: 1 },
      { id: statusId, name: "Status", type: "single_select", position: 2,
        options: [{ id: "ready", name: "Ready" }, { id: "later", name: "Later" }] },
      { id: dateId, name: "Review date", type: "date_time", position: 3 },
    ], records: [{ id: recordId, position: 1, values: { [textId]: "Map constraints", [statusId]: "ready",
      [dateId]: { start: "2026-08-27T09:00:00.000Z", includeTime: true } } }] });
  const savedView = await page.request.post(`/api/notes/${noteId}/view-blocks`, { headers: { authorization: `Bearer ${token}` },
    data: { schema: "stash.view-block.v1", id: "34343434-3434-4434-8434-343434343434", workspaceId, ownerNoteId: noteId,
      blockId: "35353535-3535-4535-8535-353535353535", title: "Accessible research",
      definition: { source: { kind: "collection", collectionId }, presentation: "table", filters: [], sorts: [], layout: {} } } });
  expect(savedView.status()).toBe(201);

  await page.goto(`/app/notes/${noteId}`);
  const view = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Accessible research" }) });
  await view.getByRole("combobox", { name: "Group by" }).selectOption(statusId);
  await view.getByRole("combobox", { name: "Presentation" }).selectOption("board");
  await view.getByRole("button", { name: "Move Map constraints to Later" }).press("Enter");
  await expect(view.getByRole("button", { name: "Move Map constraints to Ready" })).toBeVisible();
  await view.getByRole("combobox", { name: "Presentation" }).selectOption("calendar");
  await expect(view.getByText("2026-08-27")).toBeVisible();
  await view.getByRole("combobox", { name: "Presentation" }).selectOption("table");
  expect((await new AxeBuilder({ page }).include('[aria-labelledby="collections-heading"]').analyze()).violations).toEqual([]);
});

test("authors properties and typed records, then persists an evaluated filter", async ({ page }) => {
  const collectionId = "36363636-3636-4636-8636-363636363636"; const titleId = "37373737-3737-4737-8737-373737373737";
  const firstRecordId = "38383838-3838-4838-8838-383838383838"; const viewId = "39393939-3939-4939-8939-393939393939";
  await createCollection(page, { schema: "stash.collection.v1", id: collectionId, workspaceId, ownerNoteId: noteId,
    title: "Browser authoring", properties: [{ id: titleId, name: "Name", type: "text", position: 1 }],
    records: [{ id: firstRecordId, position: 1, values: { [titleId]: "Existing" } }] });
  expect((await page.request.post(`/api/notes/${noteId}/view-blocks`, { headers: { authorization: `Bearer ${token}` }, data: {
    schema: "stash.view-block.v1", id: viewId, workspaceId, ownerNoteId: noteId, blockId: "40404040-4040-4040-8040-404040404040",
    title: "Browser authoring lens", definition: { source: { kind: "collection", collectionId }, presentation: "table", filters: [], sorts: [], layout: {} },
  } })).status()).toBe(201);

  await page.goto(`/app/notes/${noteId}`);
  const authoring = page.getByRole("region", { name: "Browser authoring authoring" });
  await authoring.getByRole("button", { name: "Add property to Browser authoring" }).press("Enter");
  await authoring.getByRole("textbox", { name: "New property name" }).fill("Score");
  await authoring.getByRole("combobox", { name: "New property type" }).selectOption("number");
  await authoring.getByRole("button", { name: "Save property" }).press("Enter");
  await expect(authoring.getByRole("textbox", { name: "New property name" })).toHaveCount(0);

  await authoring.getByRole("button", { name: "Add record to Browser authoring" }).press("Enter");
  await authoring.getByRole("textbox", { name: "Name value" }).fill("Authored");
  await authoring.getByRole("spinbutton", { name: "Score value" }).fill("7");
  await authoring.getByRole("button", { name: "Save new record" }).press("Enter");
  const view = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Browser authoring lens" }) });
  await expect(view.getByRole("cell", { name: "Authored" })).toBeVisible();
  await authoring.getByRole("button", { name: "Edit record 2" }).press("Enter");
  await authoring.getByRole("spinbutton", { name: "Score value" }).fill("8");
  await authoring.getByRole("button", { name: "Save record changes" }).press("Enter");
  await expect(view.getByText("8")).toBeVisible();

  await view.getByRole("combobox", { name: "Filter by" }).selectOption(titleId);
  await view.getByRole("combobox", { name: "Filter operator" }).selectOption("equals");
  const filterSaved = page.waitForResponse(async (response) => response.url().endsWith(`/api/view-blocks/${viewId}`)
    && response.request().method() === "PATCH" && (await response.request().postDataJSON()).filters[0]?.value === "Authored");
  await view.getByRole("textbox", { name: "Filter value" }).fill("Authored");
  await expect(view.getByText("Existing")).toHaveCount(0);
  await filterSaved;
  await page.reload();
  const reopened = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Browser authoring lens" }) });
  await expect(reopened.getByRole("combobox", { name: "Filter operator" })).toHaveValue("equals");
  await expect(reopened.getByRole("textbox", { name: "Filter value" })).toHaveValue("Authored");
  await expect(reopened.getByText("Existing")).toHaveCount(0);
});

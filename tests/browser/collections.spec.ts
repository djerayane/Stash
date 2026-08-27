import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const noteId = "99999999-9999-4999-8999-999999999999";
const workspaceId = "88888888-8888-4888-8888-888888888888";
const token = "browser-acceptance-member-token";

test.beforeEach(async ({ page }) => {
  await page.addInitScript((value) => localStorage.setItem("stash.member-session", JSON.stringify({ token: value })), token);
});

async function createCollection(page: Page, input: Record<string, unknown>) {
  const response = await page.request.post(`/api/notes/${noteId}/collections`, {
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
  await expect(page.getByRole("heading", { name: "Browser milestones" })).toBeVisible();

  await page.getByRole("combobox", { name: "Embed an owned Collection" }).selectOption(collectionId);
  await page.getByRole("button", { name: "Add View Block" }).press("Enter");
  const view = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Browser milestones view" }) });
  await expect(view.getByRole("table", { name: "Browser milestones view" })).toBeVisible();
  await view.getByRole("combobox", { name: "Presentation" }).selectOption("list");
  await expect(view.getByRole("list", { name: "Browser milestones view" })).toBeVisible();
  await view.getByRole("combobox", { name: "Presentation" }).selectOption("calendar");
  await expect(view.getByRole("region", { name: "Browser milestones view calendar" })).toBeVisible();
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

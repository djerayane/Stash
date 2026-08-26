import { expect, test, type Page } from "@playwright/test";

const workspaceId = "88888888-8888-4888-8888-888888888888";
const roadmapId = "99999999-9999-4999-8999-999999999999";
const evidenceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const memberSession = JSON.stringify({ token: "browser-acceptance-member-token" });

async function authenticate(page: Page) {
  await page.addInitScript((session) => localStorage.setItem("stash.member-session", session), memberSession);
}

async function mockKnowledgeApi(page: Page) {
  const requests: Array<{ path: string; body?: any }> = [];
  const nodes = [
    { id: roadmapId, workspaceId, title: "Release collaboration plan", position: "1", childCount: 1 },
    { id: evidenceId, workspaceId, parentId: roadmapId, title: "Authoritative second Note", position: "1", childCount: 0 },
  ];
  await page.route("**/api/workspaces/*/note-tree", async (route) => {
    const request = route.request(); const body = request.postDataJSON(); requests.push({ path: new URL(request.url()).pathname, ...(body ? { body } : {}) });
    if (request.method() === "POST") return route.fulfill({ status: 201, json: { node: { id: "77777777-7777-4777-8777-777777777777",
      workspaceId, title: body.title, position: "2", childCount: 0 } } });
    return route.fulfill({ json: { nodes } });
  });
  await page.route("**/api/notes/*/context", (route) => route.fulfill({ json: { noteId: roadmapId,
    breadcrumbs: [{ id: roadmapId, title: "Release collaboration plan" }],
    outgoingLinks: [{ id: "link-1", noteId: evidenceId, title: "Authoritative second Note", label: "Evidence", relationshipType: "supports" }],
    backlinks: [{ id: "link-2", noteId: evidenceId, title: "Authoritative second Note", label: "References" }], projectIds: [] } }));
  await page.route("**/api/notes/*/branch-preview", async (route) => { const body = route.request().postDataJSON();
    requests.push({ path: new URL(route.request().url()).pathname, body }); await route.fulfill({ json: { impact: { noteId: roadmapId,
      title: "Release collaboration plan", descendantCount: 1, collectionCount: 0, externalLinks: [],
      projectAccessChanges: body.action === "move" ? [{ noteId: evidenceId, projectId: "project-1", effect: "gained" }] : [] } } }); });
  await page.route("**/api/notes/*/move", async (route) => { requests.push({ path: new URL(route.request().url()).pathname, body: route.request().postDataJSON() });
    await route.fulfill({ json: { status: "moved", movedIds: [evidenceId], projectAccessChanges: [] } }); });
  await page.route("**/api/notes/*/links", async (route) => { requests.push({ path: new URL(route.request().url()).pathname, body: route.request().postDataJSON() });
    await route.fulfill({ status: 201, json: { link: { id: "new-link" } } }); });
  await page.route(/\/api\/notes\/[^/]+\/(?:archive|trash|restore)$/, async (route) => { requests.push({ path: new URL(route.request().url()).pathname });
    await route.fulfill({ json: route.request().url().endsWith("/restore") ? { status: "restored", restoredIds: [roadmapId, evidenceId], parentRestored: true }
      : { status: "updated", affectedIds: [roadmapId, evidenceId] } }); });
  return requests;
}

test("authors and recovers knowledge through the keyboard-accessible Note workspace", async ({ page }) => {
  await authenticate(page); const requests = await mockKnowledgeApi(page);
  page.on("dialog", (dialog) => void dialog.accept());
  await page.goto(`/app/notes/${roadmapId}`);
  const tree = page.getByRole("tree", { name: "Note Tree" });
  await expect(tree).toBeVisible();
  await tree.getByRole("treeitem", { name: "Release collaboration plan" }).focus();
  await page.keyboard.press("ArrowDown");
  await expect(tree.getByRole("treeitem", { name: "Authoritative second Note" })).toBeFocused();

  await page.getByRole("button", { name: "Open Note context" }).click();
  const drawer = page.getByRole("complementary", { name: "Note context" });
  await expect(drawer).toContainText("Backlinks"); await expect(drawer).toContainText("Outgoing links");
  await drawer.getByRole("textbox", { name: "Target Note ID" }).fill(evidenceId);
  await drawer.getByRole("textbox", { name: "Relationship type" }).fill("supports");
  await drawer.getByRole("button", { name: "Create Note link" }).click();
  await drawer.getByRole("button", { name: "Close Note context" }).click();
  await expect(page.getByRole("button", { name: "Open Note context" })).toBeFocused();

  await page.getByRole("button", { name: "Archive Note branch" }).click();
  await expect(page.getByRole("button", { name: "Restore Note branch" })).toBeVisible();
  await page.getByRole("button", { name: "Restore Note branch" }).click();
  await expect(page.getByRole("button", { name: "Archive Note branch" })).toBeVisible();
  expect(requests).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: `/api/notes/${roadmapId}/links`, body: { targetNoteId: evidenceId, label: "Note", relationshipType: "supports" } }),
    expect.objectContaining({ path: `/api/notes/${roadmapId}/archive` }),
    expect.objectContaining({ path: `/api/notes/${roadmapId}/restore` }),
  ]));
});

test("keeps the Note Tree usable at a narrow viewport with non-pointer creation and move controls", async ({ page }) => {
  await authenticate(page); const requests = await mockKnowledgeApi(page); await page.setViewportSize({ width: 320, height: 720 });
  page.on("dialog", (dialog) => void dialog.accept());
  await page.goto("/app/notes");
  const tree = page.getByRole("tree", { name: "Note Tree" }); await expect(tree).toBeVisible();
  await tree.getByRole("treeitem", { name: "Authoritative second Note" }).focus();
  await tree.getByRole("button", { name: "Move Authoritative second Note to root" }).click();
  await page.getByRole("button", { name: "Create root Note" }).last().click();
  await page.getByRole("textbox", { name: "Root Note title" }).fill("Field observations");
  await page.getByRole("button", { name: "Create root Note" }).last().click();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect(requests).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: `/api/notes/${evidenceId}/move`, body: {} }),
    expect.objectContaining({ path: `/api/workspaces/${workspaceId}/note-tree`, body: { title: "Field observations" } }),
  ]));
});

import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const workspaceId = "88888888-8888-4888-8888-888888888888";
const roadmapId = "99999999-9999-4999-8999-999999999999";
const evidenceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const memberSession = JSON.stringify({ token: "browser-acceptance-member-token" });
const durableSession = JSON.stringify({ token: "browser-acceptance-durable-token" });
const guestSession = JSON.stringify({ token: "browser-acceptance-guest-token" });

async function authenticate(page: Page, session = memberSession) {
  await page.addInitScript((value) => localStorage.setItem("stash.member-session", value), session);
}

async function reloadDocument(page: Page) {
  const identity = await page.evaluate(() => { const value = crypto.randomUUID();
    Object.defineProperty(window, "__stashDocumentIdentity", { value, configurable: true }); return value; });
  const navigated = page.waitForEvent("framenavigated", (frame) => frame === page.mainFrame());
  await page.reload();
  await navigated;
  expect(await page.evaluate(() => (window as typeof window & { __stashDocumentIdentity?: string }).__stashDocumentIdentity ?? null)).not.toBe(identity);
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
    workspaceId,
    state: "active", revision: 1, createdAt: "2026-08-26T10:00:00.000Z", historyCount: 1, access: "edit", accessSource: "workspace",
    breadcrumbs: [{ id: roadmapId, title: "Release collaboration plan" }],
    outgoingLinks: [{ id: "link-1", noteId: evidenceId, title: "Authoritative second Note", label: "Evidence", relationshipType: "supports" }],
    backlinks: [{ id: "link-2", noteId: evidenceId, title: "Authoritative second Note", label: "References" }], projectIds: [], projects: [] } }));
  await page.route("**/api/notes/*/branch-preview", async (route) => { const body = route.request().postDataJSON();
    requests.push({ path: new URL(route.request().url()).pathname, body }); await route.fulfill({ json: { impact: { noteId: roadmapId,
      title: "Release collaboration plan", descendantCount: 1, descendants: [{ noteId: evidenceId, title: "Authoritative second Note" }],
      collectionCount: 0, externalLinks: [], projectAccessChanges: body.action === "move"
        ? [{ noteId: evidenceId, noteTitle: "Authoritative second Note", projectId: "project-1", projectName: "Stash", effect: "gained" }] : [] } } }); });
  await page.route("**/api/notes/*/move", async (route) => { requests.push({ path: new URL(route.request().url()).pathname, body: route.request().postDataJSON() });
    await route.fulfill({ json: { status: "moved", movedIds: [evidenceId], projectAccessChanges: [] } }); });
  await page.route("**/api/notes/*/context/links", async (route) => { requests.push({ path: new URL(route.request().url()).pathname, body: route.request().postDataJSON() });
    await route.fulfill({ status: 201, json: { link: { id: "new-link" } } }); });
  await page.route("**/api/notes/*/relationships?*", async (route) => {
    const depth = new URL(route.request().url()).searchParams.get("depth") === "2" ? 2 : 1;
    await route.fulfill({ json: { rootId: roadmapId, depth, limit: 24, direction: "both", hasMore: depth === 1,
      nodes: [{ id: roadmapId, title: "Release collaboration plan", depth: 0 },
        { id: evidenceId, title: "Authoritative second Note", depth: 1 }],
      edges: [{ id: "link-1", sourceNoteId: roadmapId, targetNoteId: evidenceId, kind: "note-link", relationshipType: "supports" }],
      outline: [{ id: roadmapId, title: "Release collaboration plan", depth: 0 },
        { id: evidenceId, title: "Authoritative second Note", depth: 1 }] } });
  });
  await page.route("**/api/workspaces/*/relationships/maintenance", (route) => route.fulfill({ json: {
    orphans: [{ id: evidenceId, title: "Authoritative second Note" }], brokenLinks: [],
  } }));
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
  const addChild = tree.getByRole("button", { name: "Add child to Release collaboration plan" });
  await addChild.focus(); await page.keyboard.press("Enter"); await expect(page.getByRole("textbox", { name: "Child Note title" })).toBeFocused();
  const addSibling = tree.getByRole("button", { name: "Add sibling to Release collaboration plan" });
  await addSibling.focus(); await page.keyboard.press("Space"); await expect(page.getByRole("textbox", { name: "Sibling Note title" })).toBeFocused();

  await page.getByRole("button", { name: "Open Note context" }).click();
  const drawer = page.getByRole("complementary", { name: "Note context" });
  await expect(drawer).toContainText("Backlinks"); await expect(drawer).toContainText("Outgoing links");
  const related = drawer.getByRole("region", { name: "Related Notes" });
  await expect(related.getByRole("list", { name: "Related Notes outline" })).toBeVisible();
  await expect(related.getByRole("link", { name: "Authoritative second Note" })).toBeVisible();
  await expect(related.getByTestId("relationship-visual")).toHaveAttribute("aria-hidden", "true");
  await related.getByRole("button", { name: "Expand related Notes" }).click();
  await expect(related.getByRole("button", { name: "Expand related Notes" })).toHaveCount(0);
  await related.getByRole("button", { name: "Review relationship maintenance" }).click();
  await expect(related.getByRole("heading", { name: "Orphan Notes" })).toBeVisible();
  await drawer.getByRole("combobox", { name: "Target Note" }).selectOption(evidenceId);
  await drawer.getByRole("textbox", { name: "Relationship type", exact: true }).fill("supports");
  await drawer.getByRole("button", { name: "Create Note link" }).click();
  await drawer.getByRole("button", { name: "Close Note context" }).click();
  await expect(page.getByRole("button", { name: "Open Note context" })).toBeFocused();

  await page.getByRole("button", { name: "Archive Note branch" }).click();
  await expect(page.getByRole("button", { name: "Restore Note branch" })).toBeVisible();
  await page.getByRole("button", { name: "Restore Note branch" }).click();
  await expect(page.getByRole("button", { name: "Archive Note branch" })).toBeVisible();
  expect(requests).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: `/api/notes/${roadmapId}/context/links`, body: { targetNoteId: evidenceId, label: "Note", relationshipType: "supports" } }),
    expect.objectContaining({ path: `/api/notes/${roadmapId}/archive` }),
    expect.objectContaining({ path: `/api/notes/${roadmapId}/restore` }),
  ]));
});

test("related Note navigation has no automatically detectable accessibility violations @a11y", async ({ page }) => {
  await authenticate(page); await mockKnowledgeApi(page); await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`/app/notes/${roadmapId}`);
  await page.getByRole("button", { name: "Open Note context" }).click();
  const related = page.getByRole("region", { name: "Related Notes" });
  await expect(related.getByRole("list", { name: "Related Notes outline" })).toBeVisible();
  await related.getByRole("button", { name: "Review relationship maintenance" }).click();
  await expect(related.getByRole("heading", { name: "Orphan Notes" })).toBeVisible();
  expect((await new AxeBuilder({ page }).include('[aria-label="Related Notes"]').analyze()).violations).toEqual([]);
});

test("repairs a real unresolved Note link with PUT through the acceptance Instance", async ({ page }) => {
  await authenticate(page);
  const repairRequest = page.waitForRequest((request) => /\/api\/notes\/[^/]+\/links\/[^/]+\/repair$/.test(new URL(request.url()).pathname)
    && request.method() === "PUT");
  const repairResponse = page.waitForResponse((response) => /\/api\/notes\/[^/]+\/links\/[^/]+\/repair$/.test(new URL(response.url()).pathname)
    && response.request().method() === "PUT");
  await page.goto(`/app/notes/${roadmapId}`);
  await page.getByRole("button", { name: "Open Note context" }).click();
  const related = page.getByRole("region", { name: "Related Notes" });
  await related.getByRole("button", { name: "Review relationship maintenance" }).click();
  await expect(related.getByText("Missing browser evidence", { exact: true })).toBeVisible();
  await related.getByRole("button", { name: "Repair Missing browser evidence" }).click();
  expect((await repairRequest).method()).toBe("PUT");
  expect((await repairResponse).status()).toBe(200);
  await expect(related.getByText("Missing browser evidence", { exact: true })).toHaveCount(0);
  const links = await page.request.get(`/api/notes/${roadmapId}/links`,
    { headers: { authorization: "Bearer browser-acceptance-member-token" } });
  expect(links.status()).toBe(200);
  expect((await links.json()).links).toEqual(expect.arrayContaining([
    expect.objectContaining({ targetNoteId: evidenceId, state: "resolved", revision: 2 }),
  ]));
});

test("persists a real Note branch lifecycle through the acceptance Instance", async ({ page }) => {
  await authenticate(page, durableSession);
  page.on("dialog", (dialog) => void dialog.accept());
  await page.goto("/app/notes");
  await page.getByRole("button", { name: "Create root Note" }).last().click();
  await page.getByRole("textbox", { name: "Root Note title" }).fill("Browser field guide");
  await page.getByRole("button", { name: "Create root Note" }).last().click();
  await expect(page).toHaveURL(/\/app\/notes\/[0-9a-f-]+$/);
  const guide = page.getByRole("treeitem", { name: "Browser field guide" }); await expect(guide).toBeVisible();
  await guide.getByRole("button", { name: "Add child to Browser field guide" }).click();
  await page.getByRole("textbox", { name: "Child Note title" }).fill("Browser observations");
  await page.getByRole("button", { name: "Create child Note" }).click();
  const observations = page.getByRole("treeitem", { name: "Browser observations" }); await expect(observations).toHaveAttribute("aria-level", "2");
  await guide.getByRole("button", { name: /Nest Browser field guide under Release collaboration plan/ }).click();
  await expect(guide).toHaveAttribute("aria-level", "2"); await expect(observations).toHaveAttribute("aria-level", "3");

  const childUrl = page.url(); await guide.getByText("Browser field guide", { exact: true }).click(); await expect(page).not.toHaveURL(childUrl);
  const guideId = new URL(page.url()).pathname.split("/").at(-1)!;
  const guestContext = await page.request.get(`/api/notes/${guideId}/context`, { headers: { authorization: "Bearer browser-acceptance-guest-token" } });
  expect(guestContext.status()).toBe(200);

  await page.getByRole("button", { name: "Create root Note" }).last().click();
  await page.getByRole("textbox", { name: "Root Note title" }).fill("Private linked research");
  await page.getByRole("button", { name: "Create root Note" }).last().click();
  await expect(page.getByRole("treeitem", { name: "Private linked research" })).toHaveAttribute("aria-current", "page");
  await expect(page).not.toHaveURL(new RegExp(`/app/notes/${guideId}$`));
  const privateId = new URL(page.url()).pathname.split("/").at(-1)!;
  await guide.getByText("Browser field guide", { exact: true }).click();
  await page.getByRole("button", { name: "Open Note context" }).click();
  const drawer = page.getByRole("complementary", { name: "Note context" });
  await drawer.getByRole("combobox", { name: "Target Note" }).selectOption({ label: "Private linked research" });
  await drawer.getByRole("textbox", { name: "Relationship type", exact: true }).fill("supports");
  await drawer.getByRole("button", { name: "Create Note link" }).click();
  await drawer.getByRole("button", { name: "Close Note context" }).click();
  const memberLinkedContext = await page.request.get(`/api/notes/${guideId}/context`, { headers: { authorization: "Bearer browser-acceptance-durable-token" } });
  expect((await memberLinkedContext.json()).outgoingLinks).toEqual(expect.arrayContaining([expect.objectContaining({ noteId: privateId, title: "Private linked research" })]));
  const guestLinkedContext = await page.request.get(`/api/notes/${guideId}/context`, { headers: { authorization: "Bearer browser-acceptance-guest-token" } });
  const guestBody = await guestLinkedContext.json();
  expect(guestBody.outgoingLinks).toEqual([]);
  expect(JSON.stringify(guestBody)).not.toContain(privateId);
  expect(JSON.stringify(guestBody)).not.toContain("Private linked research");
  expect((await page.request.get(`/api/notes/${privateId}/context`, { headers: { authorization: "Bearer browser-acceptance-guest-token" } })).status()).toBe(404);

  await expect(page).toHaveURL(new RegExp(`/app/notes/${guideId}$`));
  await page.getByRole("button", { name: "Archive Note branch" }).click();
  await expect(page.getByRole("button", { name: "Restore Note branch" })).toBeVisible();
  const reopened = await page.request.post("/api/test/note-tree/reopen", { headers: { authorization: "Bearer browser-acceptance-durable-token" } });
  expect(reopened.status()).toBe(200);
  await reloadDocument(page);
  await page.getByRole("button", { name: "Show archived and trashed branches" }).click();
  await expect(page.getByRole("region", { name: "Archived and trashed branches" })).toContainText("Browser field guide");
  await page.getByRole("button", { name: "Restore Browser field guide" }).click(); await expect(guide).toBeVisible();
  await guide.getByText("Browser field guide", { exact: true }).click(); await page.getByRole("button", { name: "Move Note branch to trash" }).click();
  await expect(page.getByRole("button", { name: "Restore Note branch" })).toBeVisible(); await reloadDocument(page);
  await page.getByRole("button", { name: "Show archived and trashed branches" }).click();
  await page.getByRole("button", { name: "Restore Browser field guide" }).click();
  await expect(guide).toBeVisible(); await expect(observations).toBeVisible();
});

test("lets an inherited Project Guest read child Discussions without mutation affordances", async ({ page }) => {
  await authenticate(page, guestSession);
  const created = await page.request.post("/api/discussions", {
    headers: { authorization: "Bearer browser-acceptance-durable-token" },
    data: { target: { kind: "note", noteId: evidenceId }, message: "Inherited Guest review context" },
  });
  expect(created.status()).toBe(201);
  const discussionId = (await created.json()).discussion.id as string;
  const guestList = await page.request.get(`/api/notes/${evidenceId}/discussions`, {
    headers: { authorization: "Bearer browser-acceptance-guest-token" },
  });
  expect(guestList.status()).toBe(200);
  expect(JSON.stringify(await guestList.json())).toContain("Inherited Guest review context");
  expect((await page.request.post("/api/discussions", { headers: { authorization: "Bearer browser-acceptance-guest-token" },
    data: { target: { kind: "note", noteId: evidenceId }, message: "Guest write" } })).status()).toBe(403);
  expect((await page.request.post(`/api/discussions/${discussionId}/messages`, {
    headers: { authorization: "Bearer browser-acceptance-guest-token" }, data: { content: "Guest reply" },
  })).status()).toBe(403);
  expect((await page.request.put(`/api/discussions/${discussionId}/resolution`, {
    headers: { authorization: "Bearer browser-acceptance-guest-token" }, data: {},
  })).status()).toBe(403);

  await page.goto(`/app/notes/${evidenceId}`);
  await expect(page.getByText(/Read-only access · Project Guests/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Archive Note branch" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Move Note branch to trash" })).toHaveCount(0);
  await page.getByRole("button", { name: "Open Note context" }).click();
  const drawer = page.getByRole("complementary", { name: "Note context" });
  await expect(drawer.getByText(/Note links are read-only/)).toBeVisible();
  await expect(drawer.getByRole("button", { name: "Create Note link" })).toHaveCount(0);
  await drawer.getByRole("tab", { name: "Discussions" }).click();
  await expect(drawer.getByText("Inherited Guest review context")).toBeVisible();
  await expect(drawer.getByText(/only Workspace Members can contribute or resolve/)).toBeVisible();
  await expect(drawer.getByRole("textbox", { name: "Start a Discussion" })).toHaveCount(0);
  await expect(drawer.getByRole("textbox", { name: "Reply" })).toHaveCount(0);
  await expect(drawer.getByRole("button", { name: "Resolve Discussion" })).toHaveCount(0);

  await page.goto(`/app/notes/${evidenceId}/discussions`);
  await expect(page.getByText("Inherited Guest review context")).toBeVisible();
  await expect(page.getByText(/only Workspace Members can contribute or resolve/)).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Start a Discussion" })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Reply" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Resolve Discussion" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Create Note from selection" })).toHaveCount(0);

  await page.goto(`/app/notes/${evidenceId}/history`);
  await expect(page.getByText(/Read-only history/)).toBeVisible();
  await page.getByRole("button", { name: "Review revision" }).first().click();
  const historyDialog = page.getByRole("dialog", { name: /Revision 1/ });
  await expect(historyDialog).toContainText("Original release plan");
  await expect(historyDialog.getByRole("button", { name: "Confirm restore" })).toHaveCount(0);
  await historyDialog.getByRole("button", { name: "Close" }).click();
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

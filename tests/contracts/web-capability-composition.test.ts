import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the web composition root consumes capability contributions instead of universal screen imports", async () => {
  const shell = await readFile(new URL("../../apps/web/src/app-shell.tsx", import.meta.url), "utf8");
  assert.match(shell, /routesFromWebCapabilities/);
  assert.match(shell, /navigationFromCapabilities/);
  assert.doesNotMatch(shell, /from "\.\/core-workflows"/);
  assert.doesNotMatch(shell, /import \{[^}]*\b(?:InboxPage|SearchPage|TasksPage|ProjectBrowser|BoardsPage|DiscussionsPage)\b/);
});

test("prototype-only universal web copy is absent from the product shell", async () => {
  const shell = await readFile(new URL("../../apps/web/src/app-shell.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(shell, /migration foundation|focused product flow that follows/i);
});

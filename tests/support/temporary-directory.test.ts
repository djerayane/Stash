import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { test } from "node:test";

import { cleanupTestDirectories, temporaryTestDirectory, withTemporaryDirectory } from "./temporary-directory.js";

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

test("test-owned temporary directories are removed after success and failure", async () => {
  let successfulPath = "";
  await withTemporaryDirectory("stash-cleanup-success-", async (path) => {
    successfulPath = path;
    assert.equal(await exists(path), true);
  });
  assert.equal(await exists(successfulPath), false);

  let failedPath = "";
  await assert.rejects(() => withTemporaryDirectory("stash-cleanup-failure-", async (path) => {
    failedPath = path;
    throw new Error("expected fixture failure");
  }), /expected fixture failure/);
  assert.equal(await exists(failedPath), false);
});

test("test-file temporary directories remain usable until centralized exit cleanup", async () => {
  const first = await temporaryTestDirectory("stash-test-lifetime-first-");
  const second = await temporaryTestDirectory("stash-test-lifetime-second-");
  assert.equal(await exists(first), true);
  assert.equal(await exists(second), true);
  cleanupTestDirectories();
  assert.equal(await exists(first), false);
  assert.equal(await exists(second), false);
});

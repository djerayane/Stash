import { temporaryTestDirectory } from "../support/temporary-directory.js";

import assert from "node:assert/strict";
import { writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { startInstance } from "../support/start-test-instance.js";

test("the Instance serves the built web client and its SPA routes", async (context) => {
  const webRoot = await temporaryTestDirectory("stash-web-client-");
  await mkdir(join(webRoot, "assets"));
  await writeFile(join(webRoot, "index.html"), "<!doctype html><title>Built Stash</title>");
  await writeFile(join(webRoot, "assets", "client.js"), "window.stash = true;");

  const instance = await startInstance({
    database: { async verifyConnection() {}, async close() {} },
    host: "127.0.0.1",
    port: 0,
    instanceAdminToken: "test-admin-token",
    webClientRoot: webRoot,
  });
  context.after(() => instance.close());

  const home = await fetch(instance.url);
  assert.equal(home.status, 200);
  assert.match(home.headers.get("content-type") ?? "", /^text\/html/);
  assert.match(await home.text(), /Built Stash/);

  const clientAsset = await fetch(`${instance.url}/assets/client.js`);
  assert.equal(clientAsset.status, 200);
  assert.match(clientAsset.headers.get("content-type") ?? "", /javascript/);
  assert.equal(await clientAsset.text(), "window.stash = true;");

  for (const path of ["/notes", "/boards", "/workspaces/11111111-1111-4111-8111-111111111111/notes", "/notes/22222222-2222-4222-8222-222222222222/edit"]) {
    const spaRoute = await fetch(`${instance.url}${path}`, { headers: { accept: "text/html" } });
    assert.equal(spaRoute.status, 200, `${path} must be owned by the Vite SPA`);
    assert.match(await spaRoute.text(), /Built Stash/);
  }

  const missingApi = await fetch(`${instance.url}/api/does-not-exist`, { headers: { accept: "application/json" } });
  assert.equal(missingApi.status, 404);

  for (const path of ["/api/does-not-exist", "/health/does-not-exist", "/mcp/does-not-exist"]) {
    const operational = await fetch(`${instance.url}${path}`, { headers: { accept: "text/html" } });
    assert.equal(operational.status, 404, `${path} must never fall through to the SPA`);
    assert.match(operational.headers.get("content-type") ?? "", /^application\/json/);
    assert.deepEqual(await operational.json(), {
      error: "not_found",
      message: "No Stash surface exists at this path.",
    });
  }
});

import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { startInstance, type RunningInstance } from "../src/instance.js";

describe("Vite web application hosting", () => {
  let instance: RunningInstance | undefined;
  afterEach(async () => { await instance?.close(); instance = undefined; });

  async function run() {
    const directory = await mkdtemp(join(tmpdir(), "stash-web-"));
    await mkdir(join(directory, "assets"));
    await writeFile(join(directory, "index.html"), '<div id="root">React shell</div>');
    await writeFile(join(directory, "assets", "app.js"), "globalThis.__stash = true");
    instance = await startInstance({
      database: { async verifyConnection() {}, async close() {} }, host: "127.0.0.1", port: 0,
      instanceAdminToken: "test-token", webClientRoot: directory,
    });
    return instance.url;
  }

  it("serves Vite assets and falls back to the SPA for deep links", async () => {
    const baseUrl = await run();
    const deepLink = await fetch(`${baseUrl}/app/tasks/assigned`, { headers: { accept: "text/html" } });
    assert.equal(deepLink.status, 200);
    assert.match(deepLink.headers.get("content-type") ?? "", /^text\/html/);
    assert.match(await deepLink.text(), /React shell/);
    const asset = await fetch(`${baseUrl}/assets/app.js`);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get("content-type") ?? "", /javascript/);
    assert.match(await asset.text(), /__stash/);
  });

  it("preserves API and health routing instead of returning the SPA", async () => {
    const baseUrl = await run();
    const api = await fetch(`${baseUrl}/api/not-a-route`);
    assert.equal(api.status, 404);
    assert.match(api.headers.get("content-type") ?? "", /application\/json/);
    const health = await fetch(`${baseUrl}/health/live`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok" });
  });

  it("does not permit asset paths to escape the Vite directory", async () => {
    const baseUrl = await run();
    assert.equal((await fetch(`${baseUrl}/assets/%2e%2e%2fpackage.json`)).status, 404);
  });
});

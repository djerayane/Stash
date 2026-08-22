import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { startInstance, type DatabaseProbe, type RunningInstance } from "../src/instance.js";

class ProtocolCompatibleDatabaseProbe implements DatabaseProbe {
  public failure: Error | undefined;

  async verifyConnection(): Promise<void> {
    if (this.failure) throw this.failure;
  }

  async close(): Promise<void> {}
}

describe("running Stash Instance", () => {
  let instance: RunningInstance | undefined;

  afterEach(async () => {
    await instance?.close();
    instance = undefined;
  });

  async function run(database = new ProtocolCompatibleDatabaseProbe()) {
    instance = await startInstance({
      database,
      host: "127.0.0.1",
      port: 0,
      instanceAdminToken: "test-instance-admin-token",
    });
    return { database, baseUrl: instance.url };
  }

  it("serves the browser surface and liveness health", async () => {
    const { baseUrl } = await run();

    const browser = await fetch(baseUrl);
    assert.equal(browser.status, 200);
    assert.match(browser.headers.get("content-type") ?? "", /^text\/html/);
    assert.match(await browser.text(), /Stash/);

    const live = await fetch(`${baseUrl}/health/live`);
    assert.equal(live.status, 200);
    assert.deepEqual(await live.json(), { status: "ok" });
  });

  it("reports database readiness and makes a recoverable outage visible", async () => {
    const { baseUrl, database } = await run();

    const ready = await fetch(`${baseUrl}/health/ready`);
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), { status: "ready" });

    database.failure = new Error("connection refused");
    const unavailable = await fetch(`${baseUrl}/health/ready`);
    assert.equal(unavailable.status, 503);
    assert.deepEqual(await unavailable.json(), {
      status: "unavailable",
      error: "database_unavailable",
    });
  });

  it("returns explicit protocol errors for invalid input and unsupported routes", async () => {
    const { baseUrl } = await run();

    const invalidBody = await fetch(`${baseUrl}/api/instance`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-instance-admin-token",
        "content-type": "application/json",
      },
      body: "not-json",
    });
    assert.equal(invalidBody.status, 400);
    assert.deepEqual(await invalidBody.json(), {
      error: "invalid_json",
      message: "Request body must be valid JSON.",
    });

    const missing = await fetch(`${baseUrl}/not-a-surface`);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), {
      error: "not_found",
      message: "No Stash surface exists at this path.",
    });
  });

  it("makes permission failures visible without exposing the configured token", async () => {
    const { baseUrl } = await run();

    const denied = await fetch(`${baseUrl}/api/instance`);
    assert.equal(denied.status, 401);
    const responseText = await denied.text();
    assert.deepEqual(JSON.parse(responseText), {
      error: "unauthorized",
      message: "A valid Instance Administrator bearer token is required.",
    });
    assert.doesNotMatch(responseText, /test-instance-admin-token/);

    const allowed = await fetch(`${baseUrl}/api/instance`, {
      headers: { authorization: "Bearer test-instance-admin-token" },
    });
    assert.equal(allowed.status, 200);
    assert.deepEqual(await allowed.json(), { name: "Stash", status: "running" });
  });
});

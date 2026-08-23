import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  createOptionalRedisAcceleration,
  type AccelerationFailure,
  type RedisCache,
} from "../src/acceleration.js";
import { startInstance, type DatabaseProbe, type RunningInstance } from "../src/instance.js";

class ProtocolCompatibleDatabaseProbe implements DatabaseProbe {
  public failure: Error | undefined;

  async verifyConnection(): Promise<void> {
    if (this.failure) throw this.failure;
  }

  async close(): Promise<void> {}
  async resolveClientSessionPrincipal(accountId: string) {
    return accountId === "member" ? { member: { id: "member", name: "Server Member", email: "member@stash.test" },
      workspace: { id: "workspace", name: "Server Workspace" }, capabilities: [] } : undefined;
  }
}

class ProtocolCompatibleRedisFake implements RedisCache {
  readonly values = new Map<string, string>();
  readonly operations: string[] = [];
  failure: Error | undefined;

  async get(key: string): Promise<string | null> {
    this.operations.push(`get:${key}`);
    if (this.failure) throw this.failure;
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.operations.push(`set:${key}`);
    if (this.failure) throw this.failure;
    this.values.set(key, value);
  }
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

  it("does not synthesize a browser surface when the Vite build is unavailable", async () => {
    const { baseUrl } = await run();

    const browser = await fetch(baseUrl);
    assert.equal(browser.status, 404);
    assert.match(browser.headers.get("content-type") ?? "", /^application\/json/);
    assert.deepEqual(await browser.json(), { error: "not_found", message: "No Stash surface exists at this path." });

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

  it("reports authenticated client permissions without granting Member sessions Instance authority", async () => {
    instance = await startInstance({
      database: new ProtocolCompatibleDatabaseProbe(),
      host: "127.0.0.1",
      port: 0,
      instanceAdminToken: "test-instance-admin-token",
      memberAccess: {
        async authenticateBearer(authorization) {
          return authorization === "Bearer member-token" ? { accountId: "member", sessionId: "session" } : undefined;
        },
      },
    });

    const administrator = await fetch(`${instance.url}/api/client-session`, {
      headers: { authorization: "Bearer test-instance-admin-token" },
    });
    assert.equal(administrator.status, 401);

    const member = await fetch(`${instance.url}/api/client-session`, {
      headers: { authorization: "Bearer member-token" },
    });
    assert.equal(member.status, 200);
    assert.deepEqual(await member.json(), { authenticated: true,
      member: { id: "member", name: "Server Member", email: "member@stash.test" },
      workspace: { id: "workspace", name: "Server Workspace" }, capabilities: [] });

    const anonymous = await fetch(`${instance.url}/api/client-session`);
    assert.equal(anonymous.status, 401);
  });

  it("keeps the Instance API identical on Redis hits, misses, and outages", async () => {
    const expected = { name: "Stash", status: "running" };
    const authorization = { authorization: "Bearer test-instance-admin-token" };

    for (const state of ["hit", "miss", "outage"] as const) {
      const redis = new ProtocolCompatibleRedisFake();
      const failures: AccelerationFailure[] = [];
      if (state === "hit") {
        redis.values.set("stash:instance:summary:v1", JSON.stringify(expected));
      }
      if (state === "outage") redis.failure = new Error("connection refused");

      instance = await startInstance({
        database: new ProtocolCompatibleDatabaseProbe(),
        host: "127.0.0.1",
        port: 0,
        instanceAdminToken: "test-instance-admin-token",
        acceleration: createOptionalRedisAcceleration({
          redis,
          onFailure: (failure) => failures.push(failure),
        }),
      });

      const response = await fetch(`${instance.url}/api/instance`, { headers: authorization });
      assert.equal(response.status, 200, state);
      assert.deepEqual(await response.json(), expected, state);
      assert.equal(redis.operations[0], "get:stash:instance:summary:v1", state);
      assert.equal(redis.operations.some((operation) => operation.startsWith("set:")), state !== "hit");
      assert.equal(failures.length > 0, state === "outage");

      await instance.close();
      instance = undefined;
    }
  });
});

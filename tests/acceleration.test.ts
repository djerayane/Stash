import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createOptionalRedisAcceleration,
  type RedisCache,
} from "../src/acceleration.js";
import { startRedisAcceleration } from "../src/redis-acceleration.js";

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
    this.operations.push(`set:${key}:${value}`);
    if (this.failure) throw this.failure;
    this.values.set(key, value);
  }
}

const json = {
  encode: JSON.stringify,
  decode(value: string): { name: string } {
    const decoded: unknown = JSON.parse(value);
    if (
      typeof decoded !== "object" ||
      decoded === null ||
      !("name" in decoded) ||
      typeof decoded.name !== "string"
    ) {
      throw new Error("invalid cached value");
    }
    return { name: decoded.name };
  },
};

describe("optional Redis acceleration", () => {
  it("uses a cached value without consulting the authoritative source", async () => {
    const redis = new ProtocolCompatibleRedisFake();
    redis.values.set("instance", '{"name":"Stash"}');
    const acceleration = createOptionalRedisAcceleration({ redis });
    let sourceReads = 0;

    const value = await acceleration.readThrough({
      key: "instance",
      codec: json,
      loadAuthoritative: async () => {
        sourceReads += 1;
        return { name: "from PostgreSQL" };
      },
    });

    assert.deepEqual(value, { name: "Stash" });
    assert.equal(sourceReads, 0);
  });

  it("loads authoritative data and populates Redis after a cache miss", async () => {
    const redis = new ProtocolCompatibleRedisFake();
    const acceleration = createOptionalRedisAcceleration({ redis });

    const value = await acceleration.readThrough({
      key: "instance",
      codec: json,
      loadAuthoritative: async () => ({ name: "Stash" }),
    });

    assert.deepEqual(value, { name: "Stash" });
    assert.equal(redis.values.get("instance"), '{"name":"Stash"}');
  });

  it("has identical behavior when Redis is not configured", async () => {
    const acceleration = createOptionalRedisAcceleration();

    const value = await acceleration.readThrough({
      key: "instance",
      codec: json,
      loadAuthoritative: async () => ({ name: "Stash" }),
    });

    assert.deepEqual(value, { name: "Stash" });
  });

  it("falls back on Redis failures and makes the degraded state visible", async () => {
    const redis = new ProtocolCompatibleRedisFake();
    redis.failure = new Error("connection refused");
    const failures: Array<{ operation: string; message: string }> = [];
    const acceleration = createOptionalRedisAcceleration({
      redis,
      onFailure(failure) {
        failures.push({ operation: failure.operation, message: failure.cause.message });
      },
    });

    const value = await acceleration.readThrough({
      key: "instance",
      codec: json,
      loadAuthoritative: async () => ({ name: "Stash" }),
    });

    assert.deepEqual(value, { name: "Stash" });
    assert.deepEqual(failures, [
      { operation: "read", message: "connection refused" },
      { operation: "write", message: "connection refused" },
    ]);
  });

  it("rejects corrupt cached data without returning it", async () => {
    const redis = new ProtocolCompatibleRedisFake();
    redis.values.set("instance", '{"unexpected":true}');
    const failures: string[] = [];
    const acceleration = createOptionalRedisAcceleration({
      redis,
      onFailure: ({ operation }) => failures.push(operation),
    });

    const value = await acceleration.readThrough({
      key: "instance",
      codec: json,
      loadAuthoritative: async () => ({ name: "authoritative" }),
    });

    assert.deepEqual(value, { name: "authoritative" });
    assert.deepEqual(failures, ["decode"]);
  });

  it("reports invalid Redis configuration while preserving direct reads", async () => {
    const failures: string[] = [];
    const runtime = startRedisAcceleration("not-a-url", ({ cause }) => {
      failures.push(cause.message);
    });

    const value = await runtime.acceleration.readThrough({
      key: "instance",
      codec: json,
      loadAuthoritative: async () => ({ name: "Stash" }),
    });

    assert.deepEqual(value, { name: "Stash" });
    assert.equal(failures.length, 1);
    await runtime.close();
  });

  it("bypasses a connecting Redis client instead of queueing the read", async () => {
    let cacheReads = 0;
    let closed = false;
    const connectingClient = {
      isOpen: true,
      isReady: false,
      on() {},
      async connect(): Promise<never> {
        return new Promise<never>(() => {});
      },
      async get(): Promise<string | null> {
        cacheReads += 1;
        return new Promise<string | null>(() => {});
      },
      async set(): Promise<void> {},
      async close(): Promise<void> {
        closed = true;
      },
    };
    const runtime = startRedisAcceleration(
      "redis://connecting.invalid:6379",
      () => {},
      () => connectingClient,
    );

    const value = await runtime.acceleration.readThrough({
      key: "instance",
      codec: json,
      loadAuthoritative: async () => ({ name: "authoritative" }),
    });

    assert.deepEqual(value, { name: "authoritative" });
    assert.equal(cacheReads, 0);
    await runtime.close();
    assert.equal(closed, true);
  });

  it("bounds an in-flight Redis command if readiness changes during a request", async () => {
    const failures: string[] = [];
    const stalledClient = {
      isOpen: true,
      isReady: true,
      on() {},
      async connect() {},
      async get(): Promise<string | null> {
        return new Promise<string | null>(() => {});
      },
      async set(): Promise<void> {},
      async close() {},
    };
    const runtime = startRedisAcceleration(
      "redis://stalled.invalid:6379",
      ({ cause }) => failures.push(cause.message),
      () => stalledClient,
    );

    const value = await runtime.acceleration.readThrough({
      key: "instance",
      codec: json,
      loadAuthoritative: async () => ({ name: "authoritative" }),
    });

    assert.deepEqual(value, { name: "authoritative" });
    assert.deepEqual(failures, ["Redis operation timed out"]);
    await runtime.close();
  });
});

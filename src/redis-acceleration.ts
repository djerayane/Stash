import { createClient } from "redis";

import {
  createOptionalRedisAcceleration,
  type AccelerationFailure,
  type OptionalRedisAcceleration,
  type RedisCache,
  toError,
} from "./acceleration.js";

export interface RunningRedisAcceleration {
  acceleration: OptionalRedisAcceleration;
  close(): Promise<void>;
}

interface RedisRuntimeClient extends RedisCache {
  readonly isOpen: boolean;
  readonly isReady: boolean;
  connect(): Promise<unknown>;
  close(): Promise<unknown>;
  on(event: "error", listener: (cause: Error) => void): unknown;
}

type RedisClientFactory = (url: string) => RedisRuntimeClient;

const defaultRedisClientFactory: RedisClientFactory = (url) =>
  createClient({ url }) as RedisRuntimeClient;

const redisOperationTimeoutMilliseconds = 100;

async function bounded<Value>(operation: Promise<Value>): Promise<Value> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Redis operation timed out")),
          redisOperationTimeoutMilliseconds,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function startRedisAcceleration(
  url: string,
  onFailure: (failure: AccelerationFailure) => void,
  createRedisClient: RedisClientFactory = defaultRedisClientFactory,
): RunningRedisAcceleration {
  let client: RedisRuntimeClient;
  try {
    client = createRedisClient(url);
  } catch (cause) {
    onFailure({
      operation: "read",
      key: "connection",
      cause: toError(cause),
    });
    return {
      acceleration: createOptionalRedisAcceleration(),
      async close() {},
    };
  }
  client.on("error", (cause: Error) => {
    onFailure({ operation: "read", key: "connection", cause });
  });

  // Redis is acceleration only: connecting must never delay Instance startup.
  void client.connect().catch((cause: unknown) => {
    onFailure({
      operation: "read",
      key: "connection",
      cause: toError(cause),
    });
  });

  return {
    acceleration: createOptionalRedisAcceleration({
      redis: {
        async get(key) {
          if (!client.isReady) throw new Error("Redis is not ready");
          return bounded(client.get(key));
        },
        async set(key, value) {
          if (!client.isReady) throw new Error("Redis is not ready");
          return bounded(client.set(key, value));
        },
      },
      onFailure,
    }),
    async close() {
      if (client.isOpen) await client.close();
    },
  };
}

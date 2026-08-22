import { createClient } from "redis";

import {
  createOptionalRedisAcceleration,
  type AccelerationFailure,
  type OptionalRedisAcceleration,
  type RedisCache,
} from "./acceleration.js";

export interface RunningRedisAcceleration {
  acceleration: OptionalRedisAcceleration;
  close(): Promise<void>;
}

export function startRedisAcceleration(
  url: string,
  onFailure: (failure: AccelerationFailure) => void,
): RunningRedisAcceleration {
  let client: ReturnType<typeof createClient>;
  try {
    client = createClient({ url });
  } catch (cause) {
    onFailure({
      operation: "read",
      key: "connection",
      cause: cause instanceof Error ? cause : new Error(String(cause)),
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
      cause: cause instanceof Error ? cause : new Error(String(cause)),
    });
  });

  return {
    acceleration: createOptionalRedisAcceleration({
      redis: client as RedisCache,
      onFailure,
    }),
    async close() {
      if (client.isOpen) await client.close();
    },
  };
}

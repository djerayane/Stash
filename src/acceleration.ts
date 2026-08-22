export interface RedisCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
}

export interface AccelerationFailure {
  operation: "read" | "decode" | "write";
  key: string;
  cause: Error;
}

export interface ValueCodec<Value> {
  encode(value: Value): string;
  decode(value: string): Value;
}

export interface ReadThroughOptions<Value> {
  key: string;
  codec: ValueCodec<Value>;
  loadAuthoritative(): Promise<Value>;
}

export interface OptionalRedisAcceleration {
  readThrough<Value>(options: ReadThroughOptions<Value>): Promise<Value>;
}

interface OptionalRedisAccelerationOptions {
  redis: RedisCache;
  onFailure?(failure: AccelerationFailure): void;
}

export function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

export function createOptionalRedisAcceleration(
  options?: OptionalRedisAccelerationOptions,
): OptionalRedisAcceleration {
  return {
    async readThrough<Value>({ key, codec, loadAuthoritative }: ReadThroughOptions<Value>) {
      if (!options) return loadAuthoritative();

      let cached: string | null = null;
      try {
        cached = await options.redis.get(key);
      } catch (cause) {
        options.onFailure?.({ operation: "read", key, cause: toError(cause) });
      }

      if (cached !== null) {
        try {
          return codec.decode(cached);
        } catch (cause) {
          options.onFailure?.({ operation: "decode", key, cause: toError(cause) });
        }
      }

      const authoritative = await loadAuthoritative();
      try {
        await options.redis.set(key, codec.encode(authoritative));
      } catch (cause) {
        options.onFailure?.({ operation: "write", key, cause: toError(cause) });
      }
      return authoritative;
    },
  };
}

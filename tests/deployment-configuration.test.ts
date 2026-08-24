import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { databaseUrlFromEnvironment, developmentAdminToken, developmentMasterKey, validateComposeExposure } from "../src/deployment-configuration.js";

describe("deployment configuration", () => {
  it("rejects every evaluation default on a non-loopback Compose bind address", () => {
    const secure = {
      INSTANCE_ADMIN_TOKEN: "production-token",
      INSTANCE_MASTER_KEY: "production-key",
      POSTGRES_PASSWORD: "production-password",
      PUBLIC_ORIGIN: "https://stash.example.com",
      STASH_BIND_ADDRESS: "0.0.0.0",
    };
    for (const override of [
      { INSTANCE_ADMIN_TOKEN: developmentAdminToken },
      { INSTANCE_MASTER_KEY: developmentMasterKey },
      { INSTANCE_ADMIN_TOKEN: ` ${developmentAdminToken} ` },
      { POSTGRES_PASSWORD: "stash-development-only" },
      { PUBLIC_ORIGIN: "http://localhost:3000" },
      { PUBLIC_ORIGIN: "http://stash.example.com" },
      { PUBLIC_ORIGIN: "https://localhost" },
    ]) {
      assert.throws(
        () => validateComposeExposure({ ...secure, ...override }),
        /non-loopback STASH_BIND_ADDRESS requires unique secrets, a non-default PostgreSQL password, and a canonical HTTPS PUBLIC_ORIGIN/,
      );
    }
  });

  it("preserves the zero-input loopback quick start and allows production credentials externally", () => {
    assert.doesNotThrow(() => validateComposeExposure({
      INSTANCE_ADMIN_TOKEN: developmentAdminToken,
      INSTANCE_MASTER_KEY: developmentMasterKey,
      POSTGRES_PASSWORD: "stash-development-only",
      PUBLIC_ORIGIN: "http://localhost:3000",
      STASH_BIND_ADDRESS: "127.0.0.1",
    }));
    assert.doesNotThrow(() => validateComposeExposure({
      INSTANCE_ADMIN_TOKEN: "production-token",
      INSTANCE_MASTER_KEY: "production-key",
      POSTGRES_PASSWORD: "production-password",
      PUBLIC_ORIGIN: "https://stash.example.com",
      STASH_BIND_ADDRESS: "0.0.0.0",
    }));
  });

  it("encodes arbitrary PostgreSQL credentials when Compose constructs DATABASE_URL", () => {
    assert.equal(databaseUrlFromEnvironment({
      POSTGRES_USER: "stash",
      POSTGRES_PASSWORD: "slash/value:@safe",
      POSTGRES_HOST: "postgres",
      POSTGRES_PORT: "5432",
      POSTGRES_DB: "stash",
    }), "postgres://stash:slash%2Fvalue%3A%40safe@postgres:5432/stash");
  });

  it("preserves an explicitly supplied DATABASE_URL", () => {
    assert.equal(databaseUrlFromEnvironment({ DATABASE_URL: "postgres://external.example/stash" }), "postgres://external.example/stash");
  });
});

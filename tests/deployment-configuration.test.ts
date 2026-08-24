import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { databaseUrlFromEnvironment, developmentAdminToken, developmentMasterKey, validateComposeExposure } from "../src/deployment-configuration.js";

describe("deployment configuration", () => {
  it("rejects known development credentials on a non-loopback Compose bind address", () => {
    for (const credentials of [
      { INSTANCE_ADMIN_TOKEN: developmentAdminToken, INSTANCE_MASTER_KEY: "production-key" },
      { INSTANCE_ADMIN_TOKEN: "production-token", INSTANCE_MASTER_KEY: developmentMasterKey },
      { INSTANCE_ADMIN_TOKEN: ` ${developmentAdminToken} `, INSTANCE_MASTER_KEY: "production-key" },
    ]) {
      assert.throws(
        () => validateComposeExposure({ ...credentials, STASH_BIND_ADDRESS: "0.0.0.0" }),
        /development-only credentials cannot be used with non-loopback STASH_BIND_ADDRESS/,
      );
    }
  });

  it("preserves the zero-input loopback quick start and allows production credentials externally", () => {
    assert.doesNotThrow(() => validateComposeExposure({
      INSTANCE_ADMIN_TOKEN: developmentAdminToken,
      INSTANCE_MASTER_KEY: developmentMasterKey,
      STASH_BIND_ADDRESS: "127.0.0.1",
    }));
    assert.doesNotThrow(() => validateComposeExposure({
      INSTANCE_ADMIN_TOKEN: "production-token",
      INSTANCE_MASTER_KEY: "production-key",
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

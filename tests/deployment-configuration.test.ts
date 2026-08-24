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
      { POSTGRES_PASSWORD: "   " },
      { POSTGRES_PASSWORD: "too-short" },
      { PUBLIC_ORIGIN: "http://localhost:3000" },
      { PUBLIC_ORIGIN: "http://stash.example.com" },
      { PUBLIC_ORIGIN: "https://localhost" },
      { PUBLIC_ORIGIN: "https://0.0.0.0" },
      { PUBLIC_ORIGIN: "https://10.0.0.1" },
      { PUBLIC_ORIGIN: "https://100.64.0.1" },
      { PUBLIC_ORIGIN: "https://169.254.1.1" },
      { PUBLIC_ORIGIN: "https://172.16.0.1" },
      { PUBLIC_ORIGIN: "https://192.168.1.1" },
      { PUBLIC_ORIGIN: "https://192.0.2.1" },
      { PUBLIC_ORIGIN: "https://198.18.0.1" },
      { PUBLIC_ORIGIN: "https://198.51.100.1" },
      { PUBLIC_ORIGIN: "https://203.0.113.1" },
      { PUBLIC_ORIGIN: "https://224.0.0.1" },
      { PUBLIC_ORIGIN: "https://[::]" },
      { PUBLIC_ORIGIN: "https://[::1]" },
      { PUBLIC_ORIGIN: "https://[fc00::1]" },
      { PUBLIC_ORIGIN: "https://[fe80::1]" },
      { PUBLIC_ORIGIN: "https://[fec0::1]" },
      { PUBLIC_ORIGIN: "https://[100::1]" },
      { PUBLIC_ORIGIN: "https://[64:ff9b::1]" },
      { PUBLIC_ORIGIN: "https://[2001::1]" },
      { PUBLIC_ORIGIN: "https://[2001:db8::1]" },
      { PUBLIC_ORIGIN: "https://[2002::1]" },
      { PUBLIC_ORIGIN: "https://[::ffff:192.168.1.1]" },
    ]) {
      assert.throws(
        () => validateComposeExposure({ ...secure, ...override }),
        /non-loopback STASH_BIND_ADDRESS requires unique secrets, a PostgreSQL password of at least 16 characters, and a canonical HTTPS PUBLIC_ORIGIN/,
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
    for (const publicOrigin of ["https://8.8.8.8", "https://[2606:4700:4700::1111]"]) {
      assert.doesNotThrow(() => validateComposeExposure({
        INSTANCE_ADMIN_TOKEN: "production-token",
        INSTANCE_MASTER_KEY: "production-key",
        POSTGRES_PASSWORD: "production-password",
        PUBLIC_ORIGIN: publicOrigin,
        STASH_BIND_ADDRESS: "0.0.0.0",
      }));
    }
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

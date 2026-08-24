import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

interface ComposeConfig {
  services: {
    stash: {
      environment: Record<string, string>;
      ports: Array<{ host_ip: string; published: string; target: number }>;
      volumes: Array<{ source: string; target: string }>;
    };
    postgres: { environment: Record<string, string>; volumes: Array<{ source: string; target: string }> };
  };
  volumes: Record<string, unknown>;
}

function composeConfig(overrides: Record<string, string> = {}): ComposeConfig {
  const result = spawnSync("docker", ["compose", "config", "--format", "json"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...overrides },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as ComposeConfig;
}

describe("Docker Compose quick start", () => {
  it("resolves a localhost-only Instance without prior environment setup", () => {
    const config = composeConfig();

    assert.deepEqual(config.services.stash.ports, [{ mode: "ingress", host_ip: "127.0.0.1", target: 3000, published: "3000", protocol: "tcp" }]);
    assert.equal(config.services.stash.environment.PUBLIC_ORIGIN, "http://localhost:3000");
    assert.equal(config.services.stash.environment.STASH_BIND_ADDRESS, "127.0.0.1");
    assert.match(config.services.stash.environment.INSTANCE_ADMIN_TOKEN ?? "", /development-only/);
    assert.equal(config.services.stash.environment.INSTANCE_MASTER_KEY, "c3Rhc2gtbG9jYWwtZGV2ZWxvcG1lbnQta2V5LTAwMDA=");
    assert.equal(config.services.postgres.environment.POSTGRES_PASSWORD, "stash-development-only");
  });

  it("retains persistent Instance data volumes", () => {
    const config = composeConfig();
    assert.deepEqual(Object.keys(config.volumes).sort(), ["stash-attachments", "stash-backups", "stash-postgres"]);
    assert.deepEqual(config.services.stash.volumes.map(({ source, target }) => ({ source, target })), [
      { source: "stash-attachments", target: "/var/lib/stash/attachments" },
      { source: "stash-backups", target: "/var/lib/stash/backups" },
    ]);
    assert.deepEqual(config.services.postgres.volumes.map(({ source, target }) => ({ source, target })), [
      { source: "stash-postgres", target: "/var/lib/postgresql/data" },
    ]);
  });

  it("honors explicit production configuration overrides", () => {
    const config = composeConfig({
      INSTANCE_ADMIN_TOKEN: "production-admin-token",
      INSTANCE_MASTER_KEY: "production-master-key",
      POSTGRES_PASSWORD: "production-postgres-password",
      PUBLIC_ORIGIN: "https://stash.example.com",
      STASH_BIND_ADDRESS: "0.0.0.0",
      STASH_PORT: "8443",
    });

    assert.equal(config.services.stash.environment.INSTANCE_ADMIN_TOKEN, "production-admin-token");
    assert.equal(config.services.stash.environment.INSTANCE_MASTER_KEY, "production-master-key");
    assert.equal(config.services.stash.environment.PUBLIC_ORIGIN, "https://stash.example.com");
    assert.equal(config.services.stash.environment.DATABASE_URL, "");
    assert.equal(config.services.stash.environment.POSTGRES_PASSWORD, "production-postgres-password");
    assert.deepEqual(config.services.stash.ports, [{ mode: "ingress", host_ip: "0.0.0.0", target: 3000, published: "8443", protocol: "tcp" }]);
  });

  it("passes reserved characters in an existing PostgreSQL password without interpolating a URL", () => {
    const config = composeConfig({ POSTGRES_PASSWORD: "slash/value:@safe" });
    assert.equal(config.services.postgres.environment.POSTGRES_PASSWORD, "slash/value:@safe");
    assert.equal(config.services.stash.environment.POSTGRES_PASSWORD, "slash/value:@safe");
    assert.equal(config.services.stash.environment.DATABASE_URL, "");
  });
});

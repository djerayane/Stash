import { temporaryTestDirectory } from "../support/temporary-directory.js";

import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";

import { loadStandaloneConfiguration } from "../../src/standalone-configuration.js";

describe("standalone first-run secret boundary", () => {
  test("fails closed when an existing configuration references a missing master key", async () => {
    const root = await temporaryTestDirectory("stash-existing-missing-key-"); const missing = join(dirname(root), ".missing-master-key");
    await mkdir(join(root, "config"), { recursive: true });
    await writeFile(join(root, "config", "runtime.json"), JSON.stringify({ schema: "stash.standalone-config.v1", publicOrigin: "http://localhost:3000", host: "127.0.0.1", port: 3000, masterKeyFile: missing }));
    await assert.rejects(loadStandaloneConfiguration(root), /configured master-key file.*unreadable or missing/i);
  });

  test("does not invent a key when durable state exists without generated configuration", async () => {
    const root = await temporaryTestDirectory("stash-existing-no-config-"); await mkdir(join(root, "database")); await writeFile(join(root, "database", "state"), "durable");
    await assert.rejects(loadStandaloneConfiguration(root), /existing data directory.*configuration/i);
  });

  test("rejects falsy, partial, and wrong-type saved configuration before mutation", async () => {
    const invalid = [null, false, 0, "", {}, { schema: "stash.standalone-config.v1" },
      { schema: "stash.standalone-config.v1", publicOrigin: 1, host: "127.0.0.1", port: 3000, masterKeyFile: "/tmp/key" },
      { schema: "stash.standalone-config.v1", publicOrigin: "http://localhost:3000", host: "", port: "3000", masterKeyFile: "/tmp/key" }];
    for (const value of invalid) {
      const root = await temporaryTestDirectory("stash-invalid-config-"); await mkdir(join(root, "config"));
      await writeFile(join(root, "config", "runtime.json"), JSON.stringify(value));
      await assert.rejects(loadStandaloneConfiguration(root), /configuration is unreadable or invalid/i);
    }
  });

  test("does not rewrite durable configuration for an invocation-only host or port override", async () => {
    const root = await temporaryTestDirectory("stash-saved-config-"); const keyFile = join(dirname(root), ".saved-key"); await writeFile(keyFile, "a".repeat(44)); await mkdir(join(root, "config"));
    const bytes = `${JSON.stringify({ schema: "stash.standalone-config.v1", publicOrigin: "http://localhost:3000", host: "127.0.0.1", port: 3000, masterKeyFile: keyFile }, null, 2)}\n`;
    const path = join(root, "config", "runtime.json"); await writeFile(path, bytes); const loaded = await loadStandaloneConfiguration(root, "127.0.0.1", "4000");
    assert.equal(loaded.configuration.port, 4000); assert.equal(await readFile(path, "utf8"), bytes);
  });
});

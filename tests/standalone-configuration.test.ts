import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";

import { loadStandaloneConfiguration } from "../src/standalone-configuration.js";

describe("standalone first-run secret boundary", () => {
  test("fails closed when an existing configuration references a missing master key", async () => {
    const root = await mkdtemp(join(tmpdir(), "stash-existing-missing-key-")); const missing = join(dirname(root), ".missing-master-key");
    await mkdir(join(root, "config"), { recursive: true });
    await writeFile(join(root, "config", "runtime.json"), JSON.stringify({ schema: "stash.standalone-config.v1", publicOrigin: "http://localhost:3000", host: "127.0.0.1", port: 3000, masterKeyFile: missing }));
    await assert.rejects(loadStandaloneConfiguration(root), /configured master-key file.*unreadable or missing/i);
  });

  test("does not invent a key when durable state exists without generated configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "stash-existing-no-config-")); await mkdir(join(root, "database")); await writeFile(join(root, "database", "state"), "durable");
    await assert.rejects(loadStandaloneConfiguration(root), /existing data directory.*configuration/i);
  });
});

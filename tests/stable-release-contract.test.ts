import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

describe("first stable release verification contract", () => {
  it("publishes executable journey and benchmark commands with representative conditions", async () => {
    const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
      scripts: Record<string, string>;
    };
    const guide = await readFile(new URL("../docs/stable-release-verification.md", import.meta.url), "utf8");

    assert.equal(packageJson.scripts["test:stable-release"], "node --import tsx --test tests/stable-release-journey.test.ts");
    assert.equal(packageJson.scripts["benchmark:stable-release"], "node --import tsx scripts/benchmark-stable-release.ts");
    for (const required of [
      "pnpm run test:stable-release",
      "pnpm run benchmark:stable-release",
      "STASH_BENCHMARK_URL",
      "1,000 active Members",
      "100 Organizations",
      "10,000 Projects",
      "one million Notes and Tasks",
      "100 concurrent editing sessions",
      "ten million searchable Blocks",
      "one terabyte of Attachments",
      "does not certify",
    ]) assert.match(guide, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("rejects absolute benchmark targets before sending a credential", () => {
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/benchmark-stable-release.ts"], {
      cwd: new URL("..", import.meta.url), encoding: "utf8", env: { ...process.env,
        STASH_BENCHMARK_URL: "http://127.0.0.1:1", STASH_BENCHMARK_PATHS: "data:text/plain,credential-leak",
        STASH_BENCHMARK_TOKEN: "must-not-leave-origin", STASH_BENCHMARK_REQUESTS: "1", STASH_BENCHMARK_CONCURRENCY: "1" },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /STASH_BENCHMARK_PATHS must contain only absolute paths on the configured Instance origin/);
    assert.doesNotMatch(result.stderr, /fetch failed|ECONNREFUSED/);
  });
});

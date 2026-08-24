import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

const root = new URL("..", import.meta.url);

async function workflow(name: string): Promise<string> {
  return readFile(new URL(`.github/workflows/${name}`, root), "utf8");
}

describe("container release contract", () => {
  it("uses one secret-free reusable quality gate for pull requests", async () => {
    const quality = await workflow("release-quality.yml");
    const pullRequest = await workflow("compose-quick-start.yml");

    assert.match(quality, /workflow_call:/);
    assert.match(quality, /release:\s*\n\s*description:.*\n\s*required: false\s*\n\s*type: boolean\s*\n\s*default: false/);
    assert.match(quality, /pnpm run check/);
    assert.match(quality, /pnpm run test/);
    assert.match(quality, /docker compose up -d --wait/);
    assert.match(quality, /linux\/amd64,linux\/arm64/);
    assert.match(pullRequest, /pull_request:/);
    assert.match(pullRequest, /uses: \.\/.github\/workflows\/release-quality\.yml/);
    assert.match(pullRequest, /release: false/);
    assert.doesNotMatch(pullRequest, /secrets:/);
  });

  it("publishes only canonical version tags after release quality", async () => {
    const quality = await workflow("release-quality.yml");
    const release = await workflow("release.yml");

    assert.match(quality, /if: inputs\.release/);
    assert.match(quality, /refs\/tags\/v/);
    assert.match(quality, /build metadata is not supported/);
    assert.match(quality, /github\.sha/);
    assert.match(quality, /gh release view/);
    assert.match(quality, /ghcr\.io\/djerayane\/stash/);

    assert.match(release, /tags:\s*\n\s*- ['"]v\*['"]/);
    assert.match(release, /release-quality:\s*\n\s*uses: \.\/.github\/workflows\/release-quality\.yml/);
    assert.match(release, /release: true/);
    assert.match(release, /publish-container:\s*\n\s*needs: release-quality/);
    assert.match(release, /packages: write/);
    assert.doesNotMatch(release, /contents: write/);
    assert.match(release, /linux\/amd64,linux\/arm64/);
    assert.match(release, /provenance: true/);
    assert.match(release, /ghcr\.io\/djerayane\/stash/);
    assert.match(release, /digest=/);
    assert.match(release, /source-commit=/);
  });

  it("lets Compose select a prebuilt image while retaining its source build", () => {
    const result = spawnSync("docker", ["compose", "config", "--format", "json"], {
      cwd: root,
      encoding: "utf8",
      env: { PATH: process.env.PATH, STASH_IMAGE: "ghcr.io/djerayane/stash@sha256:abc123" },
    });
    assert.equal(result.status, 0, result.stderr);
    const config = JSON.parse(result.stdout) as { services: { stash: { build: { context: string }; image: string } } };
    assert.equal(config.services.stash.image, "ghcr.io/djerayane/stash@sha256:abc123");
    assert.ok(config.services.stash.build.context);
  });

  it("makes the published image self-report readiness without embedding credentials", async () => {
    const dockerfile = await readFile(new URL("Dockerfile", root), "utf8");
    assert.match(dockerfile, /HEALTHCHECK .*\/health\/ready/);
    assert.doesNotMatch(dockerfile, /ENV\s+(DATABASE_URL|INSTANCE_ADMIN_TOKEN|INSTANCE_MASTER_KEY|POSTGRES_PASSWORD)=/);
  });
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const root = new URL("../", import.meta.url);
const read = (path: string) => readFile(new URL(path, root), "utf8");

describe("installation documentation contract", () => {
  it("leads a fresh checkout to the web interface with the exact Compose contract", async () => {
    const [readme, guide, compose] = await Promise.all([
      read("README.md"), read("docs/installation.md"), read("compose.yaml"),
    ]);
    const runSection = readme.split("## Run an Instance")[1]?.split(/^## /m)[0] ?? "";
    assert.match(runSection, /docker compose up -d/);
    assert.match(runSection, /http:\/\/localhost:3000/);
    assert.match(readme, /\[Installation guide\]\(docs\/installation\.md\)/);
    assert.match(compose, /"\$\{STASH_BIND_ADDRESS:-127\.0\.0\.1\}:\$\{STASH_PORT:-3000\}:3000"/);
    assert.match(guide, /127\.0\.0\.1:\$\{STASH_PORT:-3000\}:3000/);
    for (const command of ["docker compose up -d", "docker compose ps", "docker compose logs stash", "docker compose stop", "docker compose start", "docker compose down"])
      assert.ok(guide.includes(command), `installation guide omits ${command}`);
  });

  it("uses the exact published image and release artifact names", async () => {
    const [guide, release, quality] = await Promise.all([
      read("docs/installation.md"), read(".github/workflows/release.yml"), read(".github/workflows/release-quality.yml"),
    ]);
    assert.match(guide, /ghcr\.io\/djerayane\/stash:<version>/);
    assert.match(release, /ghcr\.io\/djerayane\/stash:\$\{\{ steps\.metadata\.outputs\.version \}\}/);
    for (const archive of [
      "stash-instance-<version>-linux-x64.tar.gz",
      "stash-instance-<version>-linux-arm64.tar.gz",
      "stash-instance-<version>-darwin-x64.tar.gz",
      "stash-instance-<version>-darwin-arm64.tar.gz",
      "stash-instance-<version>-win32-x64.zip",
    ]) assert.ok(guide.includes(archive), `installation guide omits ${archive}`);
    assert.match(quality, /ubuntu-latest[\s\S]*macos-15-intel[\s\S]*macos-14[\s\S]*windows-latest/);
    for (const artifact of [
      "stash-capture-<version>-android-apk",
      "stash-capture-<version>-android-aab",
      "stash-capture-<version>-ios-ipa",
    ]) assert.ok(guide.includes(artifact), `installation guide omits ${artifact}`);
    assert.match(release, /name: stash-capture-\$\{\{ needs\.release-quality\.outputs\.mobile-version \}\}-android-apk/);
    assert.match(release, /name: stash-capture-\$\{\{ needs\.release-quality\.outputs\.mobile-version \}\}-android-aab/);
    assert.match(release, /name: stash-capture-\$\{\{ needs\.release-quality\.outputs\.mobile-version \}\}-ios-ipa/);
  });

  it("documents each path's complete operating contract without inventing EAS provisioning", async () => {
    const guide = await read("docs/installation.md");
    for (const requirement of [
      /prerequisites/i, /localhost evaluation/i, /production/i, /HTTPS/, /persistence/i, /backup/i,
      /upgrade/i, /SHA-256/, /exclusive process/i, /embedded/i, /preserve mode/i, /rotate mode/i,
      /destination PostgreSQL/i, /rollback/i, /directly with.*HTTPS Instance/is,
    ]) assert.match(guide, requirement);
    assert.match(guide, /EAS_PROJECT_ID/);
    assert.match(guide, /must.*create or link.*@djerayane\/stash-capture/is);
    assert.match(guide, /do not invent/i);
    assert.match(guide, /IPA.*only when.*Apple signing/is);
    assert.doesNotMatch(guide, /EAS_PROJECT_ID\s*=\s*[0-9a-f]{8}-[0-9a-f-]{27,}/i);
  });

  it("documents executable standalone commands accepted by the bundled launcher", async () => {
    const [guide, cli, launcher] = await Promise.all([
      read("docs/installation.md"), read("src/standalone-cli.ts"), read("src/standalone-launcher.ts"),
    ]);
    for (const fragment of [
      "./stash --data-dir", "./stash backup create --data-dir", "./stash backup verify --data-dir",
      "./stash backup restore --data-dir", "./stash migrate --data-dir", "stash.cmd --data-dir",
    ]) assert.ok(guide.includes(fragment), `installation guide omits ${fragment}`);
    assert.match(cli, /stash \[serve\] --data-dir/);
    assert.match(cli, /stash backup <create\|verify\|restore>/);
    assert.match(launcher, /process\.argv\[2\] === "migrate"/);
    assert.match(guide, /INSTANCE_MASTER_KEY.*outside/is);
    assert.match(guide, /source-key-file/);
    assert.match(guide, /destination-key-file/);
  });
});

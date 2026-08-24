import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

const repositoryRoot = new URL("../", import.meta.url);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "stash-package-contract-"));
  const paths = {
    root,
    server: join(root, "dist"),
    web: join(root, "web"),
    dependencies: join(root, "node_modules"),
    runtime: join(root, process.platform === "win32" ? "node.exe" : "node"),
    license: join(root, "LICENSE"),
    output: join(root, "artifacts"),
  };
  await mkdir(paths.server, { recursive: true });
  await mkdir(paths.web, { recursive: true });
  await mkdir(join(paths.dependencies, "@electric-sql", "pglite", "dist"), { recursive: true });
  await writeFile(join(paths.server, "main.js"), "export {};\n");
  await writeFile(join(paths.server, "standalone-cli.js"), "export {};\n");
  await writeFile(join(paths.server, "standalone-launcher.js"), "export {};\n");
  await writeFile(join(paths.web, "index.html"), "<title>Stash</title>\n");
  await writeFile(join(paths.dependencies, "@electric-sql", "pglite", "dist", "pglite.wasm"), "engine");
  await writeFile(join(paths.dependencies, "@electric-sql", "pglite", "dist", "pglite.data"), "engine-data");
  await writeFile(join(paths.dependencies, "@electric-sql", "pglite", "dist", "initdb.wasm"), "init-engine");
  await writeFile(paths.runtime, "runtime");
  await writeFile(paths.license, "AGPL\n");
  return paths;
}

function packageFixture(paths: Awaited<ReturnType<typeof fixture>>, omitted?: keyof Awaited<ReturnType<typeof fixture>>) {
  const values = { ...paths };
  if (omitted) values[omitted] = join(paths.root, `missing-${omitted}`);
  return spawnSync(process.execPath, ["scripts/package-server.mjs", "--version", "1.2.3", "--source-commit", "a".repeat(40),
    "--server-dir", values.server, "--web-dir", values.web, "--dependencies-dir", values.dependencies,
    "--runtime", values.runtime, "--license", values.license, "--output-dir", values.output, "--stage-only"],
  { cwd: repositoryRoot, encoding: "utf8" });
}
function archiveFixture(paths: Awaited<ReturnType<typeof fixture>>) {
  return spawnSync(process.execPath, ["scripts/package-server.mjs", "--version", "1.2.3", "--source-commit", "a".repeat(40),
    "--server-dir", paths.server, "--web-dir", paths.web, "--dependencies-dir", paths.dependencies,
    "--runtime", paths.runtime, "--license", paths.license, "--output-dir", paths.output], { cwd: repositoryRoot, encoding: "utf8" });
}

describe("self-contained Instance bundle packaging", () => {
  test("fails closed when a required runtime surface is absent", async () => {
    const expected = new Map<keyof Awaited<ReturnType<typeof fixture>>, RegExp>([
      ["server", /compiled server output/], ["web", /built web assets/], ["dependencies", /production dependency tree/],
      ["runtime", /Node runtime/], ["license", /license/],
    ]);
    for (const [missing, message] of expected) {
      const result = packageFixture(await fixture(), missing);
      assert.notEqual(result.status, 0, `${missing} unexpectedly packaged`);
      assert.match(result.stderr, message);
    }
  });

  test("stages the runtime, PGlite engine, web client, launchers, and immutable source metadata", async () => {
    const paths = await fixture();
    const result = packageFixture(paths);
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(await readFile(join(paths.output, "stash-instance-1.2.3-test", "SOURCE.json"), "utf8")) as Record<string, unknown>;
    assert.deepEqual(manifest, { schema: "stash.instance-bundle.v1", version: "1.2.3", sourceCommit: "a".repeat(40),
      platform: process.platform, architecture: process.arch });
    for (const relative of ["LICENSE", "app/dist/main.js", "app/web/index.html", "app/node_modules/@electric-sql/pglite/dist/pglite.wasm",
      process.platform === "win32" ? "stash.cmd" : "stash", process.platform === "win32" ? "runtime/node.exe" : "runtime/node"])
      await readFile(join(paths.output, "stash-instance-1.2.3-test", relative));
    assert.match(await readFile(join(paths.output, "stash-instance-1.2.3-test", process.platform === "win32" ? "stash.cmd" : "stash"), "utf8"), /standalone-launcher\.js/);
    await writeFile(join(paths.output, "stash-instance-1.2.3-test", "stale.txt"), "stale");
    assert.equal(packageFixture(paths).status, 0);
    await assert.rejects(access(join(paths.output, "stash-instance-1.2.3-test", "stale.txt")));
    assert.match(await readFile(new URL("../scripts/package-server.mjs", import.meta.url), "utf8"), /set "ROOT=%~dp0"/);
  });

  test("rejects missing or noncanonical version and source metadata", async () => {
    const paths = await fixture();
    for (const arguments_ of [["--version", "latest", "--source-commit", "a".repeat(40)], ["--version", "1.2.3", "--source-commit", "unknown"]]) {
      const result = spawnSync(process.execPath, ["scripts/package-server.mjs", ...arguments_, "--server-dir", paths.server,
        "--web-dir", paths.web, "--dependencies-dir", paths.dependencies, "--runtime", paths.runtime,
        "--license", paths.license, "--output-dir", paths.output, "--stage-only"], { cwd: repositoryRoot, encoding: "utf8" });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /version metadata|source commit metadata/);
    }
  });

  test("rebuilds byte-identical archives and checksums from identical inputs", async () => {
    const paths = await fixture(); assert.equal(archiveFixture(paths).status, 0);
    const extension = process.platform === "win32" ? ".zip" : ".tar.gz"; const archive = join(paths.output, `stash-instance-1.2.3-${process.platform}-${process.arch}${extension}`);
    const first = await readFile(archive); const firstChecksum = await readFile(`${archive}.sha256`);
    assert.equal(archiveFixture(paths).status, 0); assert.deepEqual(await readFile(archive), first); assert.deepEqual(await readFile(`${archive}.sha256`), firstChecksum);
  });

  test("uses deterministic owner and ordering flags supported by GNU and BSD tar", async () => {
    const packager = await readFile(new URL("../scripts/package-server.mjs", import.meta.url), "utf8");
    assert.match(packager, /spawnSync\("tar", \["--version"\]/);
    assert.match(packager, /--owner/);
    assert.match(packager, /--uid/);
    assert.match(packager, /--sort=name/);
  });

  test("keeps pull requests non-publishing and gates target bundles plus the release publisher", async () => {
    const quality = await readFile(new URL("../.github/workflows/release-quality.yml", import.meta.url), "utf8");
    const release = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
    assert.match(quality, /server-bundle-smoke:[\s\S]*matrix:[\s\S]*ubuntu-latest[\s\S]*macos-15-intel[\s\S]*macos-14[\s\S]*windows-latest/);
    assert.doesNotMatch(quality, /macos-13/);
    assert.match(quality, /package:server[\s\S]*smoke:server-bundle/);
    assert.match(quality, /find artifacts\/server -maxdepth 1 -type f/);
    assert.match(quality, /server-bundle-postgres-migration:[\s\S]*postgres:17-alpine[\s\S]*--postgres-url/);
    assert.match(quality, /runner\.os == 'Linux'[\s\S]*install --yes bubblewrap iptables strace[\s\S]*--dport 2375:2376 -j REJECT/);
    const smoke = await readFile(new URL("../scripts/smoke-server-bundle.mjs", import.meta.url), "utf8");
    assert.match(smoke, /process\.kill\(-child\.pid/); assert.match(smoke, /taskkill[\s\S]*"\/T"/);
    assert.match(smoke, /sandbox-exec/); assert.match(smoke, /\.docker\/run\/docker\.sock/); assert.match(smoke, /strace[\s\S]*trace=process,network,file/);
    assert.match(smoke, /sudo[\s\S]*--non-interactive[\s\S]*bwrap[\s\S]*--unshare-user[\s\S]*--uid[\s\S]*--gid[\s\S]*--tmpfs[\s\S]*\/run[\s\S]*\/dev\/null/); assert.match(smoke, /netsh/); assert.match(smoke, /dir=out[\s\S]*action=block/);
    assert.match(smoke, /deny network-outbound[\s\S]*localhost:/);
    const windowsIsolation = await readFile(new URL("../scripts/windows-bundle-isolation.ps1", import.meta.url), "utf8"); assert.match(windowsIsolation, /Get-Command docker\.exe,podman\.exe -All[\s\S]*Move-Item[\s\S]*remains executable/);
    assert.match(smoke, /Standalone descendant retained port/);
    assert.match(JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).scripts["package:server"], /prepare-server-deploy/);
    assert.match(release, /publish-server-bundles:\s*\n\s*needs: release-quality/);
    assert.match(release, /SHA256SUMS/);
    assert.doesNotMatch(await readFile(new URL("../.github/workflows/compose-quick-start.yml", import.meta.url), "utf8"), /upload-release-asset|gh release/);
    assert.match(await readFile(new URL("../.github/workflows/compose-quick-start.yml", import.meta.url), "utf8"), /permissions:\s*\n\s*contents: read\s*\n\s*packages: read/);
    assert.match(await readFile(new URL("../scripts/prepare-server-deploy.mjs", import.meta.url), "utf8"), /fileURLToPath/);
  });
});

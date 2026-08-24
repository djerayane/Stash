import { createHash } from "node:crypto";
import { chmod, cp, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

function parse(arguments_) {
  const values = new Map(); let stageOnly = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    if (arguments_[index] === "--stage-only") { stageOnly = true; continue; }
    const name = arguments_[index]; const value = arguments_[index + 1];
    if (!name?.startsWith("--") || !value || value.startsWith("--") || values.has(name)) throw new Error("Invalid packaging arguments");
    values.set(name, value); index += 1;
  }
  return { values, stageOnly };
}

async function requirePath(path, description, kind = "any") {
  try {
    const metadata = await stat(path);
    if (kind === "file" && !metadata.isFile() || kind === "directory" && !metadata.isDirectory()) throw new Error();
  } catch { throw new Error(`Missing ${description}: ${path}`); }
}
async function normalizeTree(path) { for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
  const child = join(path, entry.name); if (entry.isDirectory()) await normalizeTree(child);
  if (!entry.isSymbolicLink()) { const metadata = await stat(child); await chmod(child, entry.isDirectory() || metadata.mode & 0o111 ? 0o755 : 0o644); await utimes(child, 0, 0); }
} await chmod(path, 0o755); await utimes(path, 0, 0); }

async function main() {
  const { values, stageOnly } = parse(process.argv.slice(2));
  const version = values.get("--version") ?? process.env.STASH_VERSION; const sourceCommit = values.get("--source-commit") ?? process.env.STASH_SOURCE_COMMIT;
  if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/.test(version ?? "")) throw new Error("Canonical version metadata is required");
  if (!/^[0-9a-f]{40}$/.test(sourceCommit ?? "")) throw new Error("Full source commit metadata is required");
  const explicitRuntime = values.get("--runtime");
  const runtimeRoot = explicitRuntime ? undefined : resolve(values.get("--runtime-root") ?? (basename(dirname(process.execPath)) === "bin" ? dirname(dirname(process.execPath)) : dirname(process.execPath)));
  const runtimeExecutable = resolve(explicitRuntime ?? process.execPath);
  const runtimeRelative = explicitRuntime ? (process.platform === "win32" ? "node.exe" : "node") : relative(runtimeRoot, runtimeExecutable);
  const paths = { server: resolve(values.get("--server-dir") ?? "dist"), web: resolve(values.get("--web-dir") ?? "apps/web/dist"),
    dependencies: resolve(values.get("--dependencies-dir") ?? ".bundle-deploy/node_modules"), runtime: runtimeExecutable,
    license: resolve(values.get("--license") ?? "LICENSE"), output: resolve(values.get("--output-dir") ?? "artifacts/server") };
  await requirePath(paths.server, "compiled server output", "directory"); await requirePath(join(paths.server, "main.js"), "compiled server entrypoint", "file");
  await requirePath(join(paths.server, "standalone-cli.js"), "compiled standalone command", "file");
  await requirePath(join(paths.server, "standalone-launcher.js"), "compiled standalone launcher", "file");
  await requirePath(paths.web, "built web assets", "directory"); await requirePath(join(paths.web, "index.html"), "built web entrypoint", "file");
  await requirePath(paths.dependencies, "production dependency tree", "directory");
  for (const asset of ["pglite.wasm", "pglite.data", "initdb.wasm"]) await requirePath(join(paths.dependencies, "@electric-sql", "pglite", "dist", asset), "embedded PGlite engine", "file");
  await requirePath(paths.runtime, "Node runtime", "file"); await requirePath(paths.license, "license", "file");
  const platform = process.platform; const architecture = process.arch;
  const target = stageOnly ? "test" : `${platform}-${architecture}`; const archiveRoot = `stash-instance-${version}-${target}`;
  const stage = join(paths.output, archiveRoot); await rm(stage, { recursive: true, force: true }); await mkdir(join(stage, "app"), { recursive: true }); await mkdir(join(stage, "runtime"), { recursive: true });
  await cp(paths.server, join(stage, "app", "dist"), { recursive: true, dereference: true });
  await cp(paths.web, join(stage, "app", "web"), { recursive: true, dereference: true });
  await cp(paths.dependencies, join(stage, "app", "node_modules"), { recursive: true, dereference: true });
  await writeFile(join(stage, "app", "package.json"), `${JSON.stringify({ name: "@stash/server-bundle", version, private: true, type: "module" }, null, 2)}\n`);
  await cp(paths.license, join(stage, "LICENSE"));
  if (runtimeRoot) await cp(runtimeRoot, join(stage, "runtime"), { recursive: true, dereference: true });
  else await cp(paths.runtime, join(stage, "runtime", runtimeRelative));
  const launcherRuntime = runtimeRelative.replaceAll("\\", "/");
  const unixLauncher = `#!/bin/sh\nset -eu\nROOT=$(CDPATH= cd -- "\${0%/*}" && pwd)\nexec "$ROOT/runtime/${launcherRuntime}" "$ROOT/app/dist/standalone-launcher.js" "$@"\n`;
  const windowsRuntime = runtimeRelative.replaceAll("/", "\\");
  const windowsLauncher = `@echo off\r\nset "ROOT=%~dp0"\r\n"%ROOT%runtime\\${windowsRuntime}" "%ROOT%app\\dist\\standalone-launcher.js" %*\r\n`;
  await writeFile(join(stage, platform === "win32" ? "stash.cmd" : "stash"), platform === "win32" ? windowsLauncher : unixLauncher);
  if (platform !== "win32") { await chmod(join(stage, "stash"), 0o755); await chmod(join(stage, "runtime", runtimeRelative), 0o755); }
  const metadata = { schema: "stash.instance-bundle.v1", version, sourceCommit, platform, architecture };
  await writeFile(join(stage, "SOURCE.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  await normalizeTree(stage);
  if (stageOnly) return;
  await mkdir(paths.output, { recursive: true });
  const extension = platform === "win32" ? ".zip" : ".tar.gz"; const archive = join(paths.output, `${archiveRoot}${extension}`); await rm(archive, { force: true }); await rm(`${archive}.sha256`, { force: true });
  if (platform === "win32") {
    const result = spawnSync("powershell", ["-NoProfile", "-Command", `Compress-Archive -Path '${stage}' -DestinationPath '${archive}' -CompressionLevel Optimal`], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`Archive creation failed: ${result.stderr}`);
  } else {
    const tar = spawnSync("tar", ["--uid", "0", "--gid", "0", "--uname", "root", "--gname", "root", "-cf", "-", "-C", paths.output, basename(stage)], { maxBuffer: 1024 * 1024 * 1024 });
    if (tar.status !== 0) throw new Error(`Archive creation failed: ${tar.stderr}`);
    const gzip = spawnSync("gzip", ["-n", "-9"], { input: tar.stdout, maxBuffer: 1024 * 1024 * 1024 });
    if (gzip.status !== 0) throw new Error(`Archive compression failed: ${gzip.stderr}`); await writeFile(archive, gzip.stdout);
  }
  const digest = createHash("sha256").update(await readFile(archive)).digest("hex");
  await writeFile(`${archive}.sha256`, `${digest}  ${basename(archive)}\n`);
  process.stdout.write(`${JSON.stringify({ archive, checksum: `${archive}.sha256`, ...metadata })}\n`);
}

main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : "Server packaging failed"}\n`); process.exitCode = 1; });

import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";

function value(name) { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; }
function run(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, { encoding: "utf8", ...options });
  if (result.status !== 0) throw new Error(`${basename(command)} failed (${result.status}): ${result.stderr}`);
  return result;
}
async function waitFor(url, diagnostics = () => "") {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { const response = await fetch(`${url}/health/ready`); if (response.ok) return; } catch { /* starting */ }
    await new Promise((resolve_) => setTimeout(resolve_, 250));
  }
  throw new Error(`Standalone Instance did not become ready: ${diagnostics()}`);
}
async function json(url, path, init) { const response = await fetch(`${url}${path}`, init); return { response, body: await response.json() }; }
async function stop(child) {
  child.kill("SIGTERM");
  await new Promise((resolve_) => child.once("exit", resolve_));
}

async function main() {
  const archive = value("--archive"); const staged = value("--bundle-dir");
  if (Boolean(archive) === Boolean(staged)) throw new Error("usage: smoke-server-bundle --archive <path> | --bundle-dir <path>");
  const extraction = await mkdtemp(join(tmpdir(), "stash bundle extract ")); let bundle = staged && resolve(staged);
  if (archive) {
    if (archive.endsWith(".zip")) run("powershell", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${resolve(archive)}' -DestinationPath '${extraction}'`]);
    else run("tar", ["-xzf", resolve(archive), "-C", extraction]);
    const entries = await readdir(extraction); if (entries.length !== 1) throw new Error("Bundle archive must contain one root directory");
    bundle = join(extraction, entries[0]);
  }
  const launcher = join(bundle, process.platform === "win32" ? "stash.cmd" : "stash");
  const launcherText = await readFile(launcher, "utf8");
  if (/docker|pnpm|(?:^|[\\/])node(?:\.exe)?(?:\s|$)/im.test(launcherText.replace(/runtime[\\/]node(?:\.exe)?/g, "runtime"))) throw new Error("Launcher invokes an external runtime or Docker");
  const dataDirectory = join(extraction, "instance-data"); const backup = join(dataDirectory, "backups", "acceptance");
  const port = 31_000 + Math.floor(Math.random() * 1_000); const url = `http://127.0.0.1:${port}`;
  const cleanEnvironment = { PATH: dirname(launcher), SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR };
  const launch = () => spawn(launcher, ["serve", "--data-dir", dataDirectory, "--port", String(port)], { env: cleanEnvironment, stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
  let server = launch(); let stderr = ""; server.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    await waitFor(url, () => stderr);
    const page = await fetch(`${url}/`); if (!page.ok || !await page.text().then((text) => text.includes("Stash"))) throw new Error("Built web client was not served");
    const email = `bundle-${randomUUID()}@stash.test`; const password = "standalone-acceptance-password";
    const registration = await json(url, "/api/auth/registration", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Bundle Smoke", email, password }) });
    if (registration.response.status !== 201 || !registration.body.token) throw new Error(`Registration failed (${registration.response.status})`);
    const session = await json(url, "/api/client-session", { headers: { authorization: `Bearer ${registration.body.token}` } });
    const workspace = session.body.workspace?.id; if (!workspace) throw new Error("Personal Workspace missing after registration");
    const attachment = await fetch(`${url}/api/workspaces/${workspace}/attachments`, { method: "POST", headers: { authorization: `Bearer ${registration.body.token}`,
      "content-type": "text/plain", "x-stash-filename": "bundle.txt", "x-stash-source": "upload", "x-stash-operation-key": randomUUID() }, body: "durable bundle Attachment" });
    if (attachment.status !== 201) throw new Error(`Attachment upload failed (${attachment.status})`);
    const second = spawnSync(launcher, ["serve", "--data-dir", dataDirectory, "--port", String(port + 1)], { env: cleanEnvironment, encoding: "utf8", timeout: 15_000, shell: process.platform === "win32" });
    if (second.status === 0 || !/already (?:open|in use)|locked|another process/i.test(second.stderr)) throw new Error(`Concurrent second process was not rejected safely (status=${second.status}, signal=${second.signal}): ${second.stderr || second.stdout}`);
    await stop(server);
    const unsafe = spawnSync(launcher, ["serve", "--data-dir", join(extraction, "unsafe-data"), "--host", "0.0.0.0", "--port", String(port + 1)],
      { env: cleanEnvironment, encoding: "utf8", timeout: 15_000, shell: process.platform === "win32" });
    if (unsafe.status === 0 || !/non-loopback.*requires unique secrets/i.test(unsafe.stderr)) throw new Error(`Evaluation defaults accepted an unsafe public bind: ${unsafe.stderr || unsafe.stdout}`);
    run(launcher, ["backup", "create", "--data-dir", dataDirectory, "--backup", backup], { env: cleanEnvironment, shell: process.platform === "win32" });
    run(launcher, ["backup", "verify", "--data-dir", dataDirectory, "--backup", backup], { env: cleanEnvironment, shell: process.platform === "win32" });
    run(launcher, ["backup", "restore", "--data-dir", dataDirectory, "--backup", backup], { env: cleanEnvironment, shell: process.platform === "win32" });
    server = launch(); server.stderr.on("data", (chunk) => { stderr += chunk; }); await waitFor(url, () => stderr);
    const signIn = await json(url, "/api/auth/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
    if (signIn.response.status !== 201 || !signIn.body.token) throw new Error(`Restart sign-in failed (${signIn.response.status})`);
    for (const relative of ["database", "attachments", "backups", "config"]) if (!(await stat(join(dataDirectory, relative))).isDirectory()) throw new Error(`Missing data-directory surface ${relative}`);
    const forbidden = ["INSTANCE_MASTER_KEY", "standalone-acceptance-password"];
    for (const file of [join(bundle, "SOURCE.json"), `${archive}.sha256`].filter((path) => path && path !== "undefined.sha256")) {
      const content = await readFile(file, "utf8").catch(() => ""); for (const secret of forbidden) if (content.includes(secret)) throw new Error(`Secret leaked into ${file}`);
    }
  } finally { if (server.exitCode === null) await stop(server); }
  if (stderr.includes("docker") || stderr.includes("standalone-acceptance-password")) throw new Error("Standalone logs contain forbidden runtime or secret material");
  process.stdout.write("Standalone bundle boot, restart, lock, Attachment, backup, and restore smoke passed.\n");
}
main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : "Standalone smoke failed"}\n`); process.exitCode = 1; });

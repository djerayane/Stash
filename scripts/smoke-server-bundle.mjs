import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createConnection } from "node:net";
import { pathToFileURL } from "node:url";
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
async function filesBelow(root) { const files = []; for (const entry of await readdir(root, { withFileTypes: true })) { const path = join(root, entry.name); if (entry.isDirectory()) files.push(...await filesBelow(path)); else if (entry.isFile()) files.push(path); } return files; }
function isolatedInvocation(launcher, arguments_, traceRoot) {
  if (process.platform === "darwin") return { command: "/usr/bin/sandbox-exec", arguments: ["-p", "(version 1)(allow default)(deny file-read* file-write* (literal \"/var/run/docker.sock\"))", launcher, ...arguments_] };
  if (process.platform === "linux") return { command: "/usr/bin/strace", arguments: ["-ff", "-o", join(traceRoot, `syscalls-${randomUUID()}`), "-e", "trace=process,network,file", launcher, ...arguments_] };
  return { command: launcher, arguments: arguments_ };
}
function assertNoContainerDescendants(processList, rootPid) {
  if (process.platform === "win32") {
    const rows = JSON.parse(processList); const list = Array.isArray(rows) ? rows : [rows]; const descendants = new Set([rootPid]);
    for (let pass = 0; pass < list.length; pass += 1) for (const row of list) if (descendants.has(row.ParentProcessId)) descendants.add(row.ProcessId);
    for (const row of list) if (descendants.has(row.ProcessId) && /docker(?:\.exe)?|podman|docker\.sock/i.test(row.ExecutablePath ?? "")) throw new Error("Standalone descendant used a container runtime or Docker API");
  } else {
    const rows = processList.trim().split("\n").map((line) => { const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/); return match && { pid: +match[1], parent: +match[2], command: match[3] }; }).filter(Boolean);
    const descendants = new Set([rootPid]); for (let pass = 0; pass < rows.length; pass += 1) for (const row of rows) if (descendants.has(row.parent)) descendants.add(row.pid);
    for (const row of rows) if (descendants.has(row.pid) && /docker|podman|docker\.sock|\/var\/run\/docker/i.test(row.command)) throw new Error("Standalone descendant used a container runtime or Docker API");
  }
}
async function assertDockerSocketDenied(bundle) {
  const socket = process.platform === "win32" ? "\\\\.\\pipe\\docker_engine" : "/var/run/docker.sock";
  if (process.platform === "darwin") {
    const runtime = join(bundle, "runtime", "bin", "node"); const probe = `require('net').createConnection(${JSON.stringify(socket)}).once('connect',()=>process.exit(9)).once('error',()=>process.exit(0));setTimeout(()=>process.exit(0),500)`;
    const result = spawnSync("sandbox-exec", ["-p", "(version 1)(allow default)(deny network*)", runtime, "-e", probe], { encoding: "utf8", timeout: 2_000 });
    if (result.status !== 0) throw new Error(`Docker API socket was not denied by the standalone test context (${result.status})`); return;
  }
  if (process.platform !== "win32") return;
  await new Promise((resolve_, reject) => { const client = createConnection(socket); const timer = setTimeout(() => { client.destroy(); resolve_(); }, 500);
    client.once("connect", () => { clearTimeout(timer); client.destroy(); reject(new Error(`Docker API socket is available to standalone smoke: ${socket}`)); });
    client.once("error", () => { clearTimeout(timer); resolve_(); }); });
}
function traceDescendants(rootPid) {
  let failure; const sample = () => { try { const output = process.platform === "win32"
    ? run("powershell", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath | ConvertTo-Json"], { env: process.env }).stdout
    : run("ps", ["-axo", "pid=,ppid=,command="], { env: process.env }).stdout; assertNoContainerDescendants(output, rootPid); } catch (error) { failure ??= error; } };
  sample(); const timer = setInterval(sample, 25); return () => { clearInterval(timer); sample(); if (failure) throw failure; };
}
async function migrateFixture({ bundle, launcher, environment, postgresUrl, dataDirectory, extraction, email, password }) {
  const require = createRequire(join(bundle, "app", "package.json")); const { Pool } = require("pg");
  const { PostgresDatabase } = await import(pathToFileURL(join(bundle, "app", "dist", "postgres-database.js")));
  const { createAuthenticationSecretCodec } = await import(pathToFileURL(join(bundle, "app", "dist", "authentication-secrets.js")));
  const { PasswordAuthService } = await import(pathToFileURL(join(bundle, "app", "dist", "password-auth.js")));
  const { EmbeddedInstanceStore } = await import(pathToFileURL(join(bundle, "app", "dist", "embedded-instance-store.js")));
  const { passwordHashCodec } = await import(pathToFileURL(join(bundle, "app", "dist", "password-hash.js")));
  const { deriveEmailRecoveryLookup } = await import(pathToFileURL(join(bundle, "app", "dist", "account-recovery.js")));
  const { InvitationService } = await import(pathToFileURL(join(bundle, "app", "dist", "invitations.js")));
  const configuration = JSON.parse(await readFile(join(dataDirectory, "config", "runtime.json"), "utf8"));
  const sourceKey = (await readFile(configuration.masterKeyFile, "utf8")).trim(); const codec = createAuthenticationSecretCodec(sourceKey);
  const expected = { organizationId: randomUUID(), ownerId: randomUUID(), adminId: randomUUID(), memberId: randomUUID(), noteId: randomUUID(), workspaceId: randomUUID(),
    recoveryToken: `bundle-recovery-${randomUUID()}`, oidcSecret: `bundle-oidc-${randomUUID()}` };
  const source = await EmbeddedInstanceStore.open(dataDirectory, codec); const richPassword = "bundle-rich-migration-password";
  try { await source.database.createFirstOrganizationOwner({ organizationId: expected.organizationId, organizationName: "Bundle Migration", ownerId: expected.ownerId,
    ownerName: "Bundle Owner", ownerEmail: "bundle-owner@stash.test", passwordHash: await passwordHashCodec.hash(richPassword), role: "Owner" });
    for (const [id, role] of [[expected.adminId, "Admin"], [expected.memberId, "Member"]]) { await source.database.createAccountWithPersonalWorkspaceAndSession({ account: { id, name: `Bundle ${role}`, email: `bundle-${role.toLowerCase()}@stash.test`, passwordHash: await passwordHashCodec.hash(richPassword) }, workspace: { id: randomUUID(), name: `${role} Personal` }, session: { id: randomUUID(), accountId: id, tokenHash: randomUUID(), createdAt: new Date().toISOString(), lastSeenAt: new Date().toISOString() } });
      const invitation = await new InvitationService(source.database).create(expected.organizationId, expected.ownerId, { kind: "member", role }); if (invitation.status !== "created") throw new Error("Rich migration invitation failed"); await new InvitationService(source.database).accept(id, { token: invitation.token }); }
    await source.database.saveOidcConfiguration({ organizationId: expected.organizationId, issuer: "https://identity.bundle.test", clientId: "bundle-migration", clientSecret: expected.oidcSecret });
    await source.database.linkOidcIdentity({ organizationId: expected.organizationId, issuer: "https://identity.bundle.test", subject: "bundle-owner" }, expected.ownerId);
    await source.database.createWorkspace({ id: expected.workspaceId, name: "Rich Bundle Workspace", owner: { type: "organization", id: expected.organizationId }, createdByMemberId: expected.ownerId }, { localAccountId: expected.ownerId, displayName: "Bundle Owner" });
    await source.database.createNote(expected.ownerId, { id: expected.noteId, workspaceId: expected.workspaceId, content: "Rich migration history", document: { type: "doc", content: [{ type: "paragraph", attrs: { id: randomUUID() }, content: [{ type: "text", text: "Rich migration history" }] }] }, revision: 1, tags: ["migration"], createdByMemberId: expected.ownerId, createdAt: new Date().toISOString() }, { schema: "stash.note.v1", id: expected.noteId, workspaceId: expected.workspaceId, content: "Rich migration history", tags: ["migration"], createdAt: new Date().toISOString(), createdBy: { localAccountId: expected.ownerId, displayName: "Bundle Owner" } });
    await source.database.enqueueEmailRecovery({ id: randomUUID(), protectedDelivery: codec.encrypt("bundle-delivery"), createdAt: "2026-08-24T10:00:00.000Z" }); const claim = await source.database.claimEmailRecoveryDelivery(randomUUID(), "2026-08-24T10:10:00.000Z");
    await source.database.completeEmailRecoveryDelivery(claim.claim, { accountId: expected.ownerId, tokenLookup: deriveEmailRecoveryLookup(expected.recoveryToken), protectedSecret: codec.encrypt(expected.recoveryToken), expiresAt: "2030-08-24T10:00:00.000Z" });
  } finally { await source.close(); }
  const admin = new Pool({ connectionString: postgresUrl });
  try { for (const mode of ["preserve", "rotate"]) {
    const destinationKey = mode === "preserve" ? sourceKey : randomBytes(32).toString("base64"); const schema = `bundle_${mode}_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE SCHEMA ${schema}`); const scoped = new URL(postgresUrl); scoped.searchParams.set("options", `-csearch_path=${schema}`);
    const database = new PostgresDatabase(scoped.toString(), createAuthenticationSecretCodec(destinationKey)); await database.verifyConnection(); await database.prepareInstanceStore(); await database.close();
    const root = join(extraction, `migration-${mode}`); await mkdir(root); const destinationKeyFile = join(extraction, `destination-${mode}.key`);
    if (mode === "rotate") await writeFile(destinationKeyFile, destinationKey, { mode: 0o600 });
    const arguments_ = ["migrate", "--data-dir", dataDirectory, "--attachment-root", join(root, "attachments"), "--configuration-root", join(root, "config"), "--mode", mode,
      "--source-key-file", configuration.masterKeyFile, ...(mode === "rotate" ? ["--destination-key-file", destinationKeyFile] : [])];
    const invocation = isolatedInvocation(launcher, arguments_, extraction); const migrated = run(invocation.command, invocation.arguments, { env: { ...environment, DESTINATION_DATABASE_URL: scoped.toString(), DESTINATION_DATABASE_AVAILABLE_BYTES: String(Number.MAX_SAFE_INTEGER) }, shell: process.platform === "win32" });
    if (!/"status":"migrated"/.test(migrated.stdout)) throw new Error(`${mode} migration did not report completion`);
    for (const secret of [sourceKey, destinationKey]) if (migrated.stdout.includes(secret) || migrated.stderr.includes(secret)) throw new Error(`${mode} migration exposed a key in output`);
    const verified = new PostgresDatabase(scoped.toString(), createAuthenticationSecretCodec(destinationKey)); await verified.verifyConnection();
    if (!(await new PasswordAuthService(verified).signIn({ email, password })).member.id) throw new Error(`${mode} migration lost authentication`);
    for (const [address, id, role] of [["bundle-owner@stash.test", expected.ownerId, "Owner"], ["bundle-admin@stash.test", expected.adminId, "Admin"], ["bundle-member@stash.test", expected.memberId, "Member"]]) {
      if ((await new PasswordAuthService(verified).signIn({ email: address, password: richPassword })).member.id !== id || await verified.organizationRole(expected.organizationId, id) !== role) throw new Error(`${mode} migration lost authentication or immutable authorization roles`); }
    const oidc = await verified.findOidcConfiguration(expected.organizationId); if (oidc?.clientSecret !== expected.oidcSecret) throw new Error(`${mode} migration lost encrypted integration state`);
    if ((await verified.listNoteHistory(expected.ownerId, expected.noteId)).status !== "found" || (await verified.listWorkspaceActivity(expected.ownerId, expected.workspaceId)).status !== "found") throw new Error(`${mode} migration lost Note history or audit Activity`);
    if (await verified.findEmailRecoveryAccount(deriveEmailRecoveryLookup(expected.recoveryToken), "2026-08-24T10:00:00.000Z") !== expected.ownerId) throw new Error(`${mode} migration lost recovery state`);
    const counts = await admin.query(`SELECT (SELECT count(*) FROM ${schema}.stash_workspaces) AS workspaces, (SELECT count(*) FROM ${schema}.stash_attachments) AS attachments`);
    if (+counts.rows[0].workspaces < 1 || +counts.rows[0].attachments < 1) throw new Error(`${mode} migration lost domain or Attachment records`);
    await verified.close(); if (!(await stat(join(root, "config", "runtime.json"))).isFile()) throw new Error(`${mode} migration lost configuration`);
    const attachmentFiles = await filesBelow(join(root, "attachments")); const expectedChecksum = createHash("sha256").update("durable bundle Attachment").digest("hex");
    const checksums = await Promise.all(attachmentFiles.map(async (path) => createHash("sha256").update(await readFile(path)).digest("hex"))); if (!checksums.includes(expectedChecksum)) throw new Error(`${mode} migration changed Attachment bytes or checksums`);
    for (const path of [...attachmentFiles, ...await filesBelow(join(root, "config"))]) { const bytes = await readFile(path); for (const secret of [sourceKey, destinationKey]) if (bytes.includes(Buffer.from(secret))) throw new Error(`${mode} migration leaked a key into destination artifacts`); }
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  } } finally { await admin.end(); } return { email: "bundle-owner@stash.test", password: richPassword, workspaceId: expected.workspaceId };
}

async function main() {
  const archive = value("--archive"); const staged = value("--bundle-dir");
  if (Boolean(archive) === Boolean(staged)) throw new Error("usage: smoke-server-bundle --archive <path> | --bundle-dir <path>");
  const extraction = await mkdtemp(join(tmpdir(), "stash & bundle extract ")); let bundle = staged && resolve(staged);
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
  const cleanEnvironment = { PATH: dirname(launcher), SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
    DOCKER_HOST: `unix://${join(extraction, "docker-access-is-forbidden.sock")}` };
  const invoke = (arguments_) => isolatedInvocation(launcher, arguments_, extraction);
  const launch = () => { const call = invoke(["serve", "--data-dir", dataDirectory, "--port", String(port)]); return spawn(call.command, call.arguments, { env: cleanEnvironment, stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" }); };
  await assertDockerSocketDenied(bundle); let server = launch(); let stopTracing = traceDescendants(server.pid); let stderr = ""; server.stderr.on("data", (chunk) => { stderr += chunk; });
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
    const secondCall = invoke(["serve", "--data-dir", dataDirectory, "--port", String(port + 1)]); const second = spawnSync(secondCall.command, secondCall.arguments, { env: cleanEnvironment, encoding: "utf8", timeout: 15_000, shell: process.platform === "win32" });
    if (second.status === 0 || !/already (?:open|in use)|locked|another process/i.test(second.stderr)) throw new Error(`Concurrent second process was not rejected safely (status=${second.status}, signal=${second.signal}): ${second.stderr || second.stdout}`);
    await stop(server); stopTracing();
    const postgresUrl = value("--postgres-url"); const richFixture = postgresUrl ? await migrateFixture({ bundle, launcher, environment: cleanEnvironment, postgresUrl, dataDirectory, extraction, email, password }) : undefined;
    const unsafeCall = invoke(["serve", "--data-dir", join(extraction, "unsafe-data"), "--host", "0.0.0.0", "--port", String(port + 1)]); const unsafe = spawnSync(unsafeCall.command, unsafeCall.arguments,
      { env: cleanEnvironment, encoding: "utf8", timeout: 15_000, shell: process.platform === "win32" });
    if (unsafe.status === 0 || !/non-loopback.*requires unique secrets/i.test(unsafe.stderr)) throw new Error(`Evaluation defaults accepted an unsafe public bind: ${unsafe.stderr || unsafe.stdout}`);
    for (const operation of [["backup", "create"], ["backup", "verify"], ["backup", "restore"]]) { const call = invoke([...operation, "--data-dir", dataDirectory, "--backup", backup]); run(call.command, call.arguments, { env: cleanEnvironment, shell: process.platform === "win32" }); }
    server = launch(); stopTracing = traceDescendants(server.pid); server.stderr.on("data", (chunk) => { stderr += chunk; }); await waitFor(url, () => stderr);
    const signIn = await json(url, "/api/auth/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
    if (signIn.response.status !== 201 || !signIn.body.token) throw new Error(`Restart sign-in failed (${signIn.response.status})`);
    if (richFixture) { const richSignIn = await json(url, "/api/auth/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: richFixture.email, password: richFixture.password }) });
      if (richSignIn.response.status !== 201) throw new Error("Backup/restore lost rich fixture authentication"); const restoredWorkspaces = await json(url, "/api/workspaces", { headers: { authorization: `Bearer ${richSignIn.body.token}` } });
      if (!JSON.stringify(restoredWorkspaces.body).includes(richFixture.workspaceId)) throw new Error("Backup/restore lost rich fixture authorization or domain state"); }
    for (const relative of ["database", "attachments", "backups", "config"]) if (!(await stat(join(dataDirectory, relative))).isDirectory()) throw new Error(`Missing data-directory surface ${relative}`);
    const forbidden = ["INSTANCE_MASTER_KEY", "standalone-acceptance-password"];
    for (const file of [join(bundle, "SOURCE.json"), `${archive}.sha256`].filter((path) => path && path !== "undefined.sha256")) {
      const content = await readFile(file, "utf8").catch(() => ""); for (const secret of forbidden) if (content.includes(secret)) throw new Error(`Secret leaked into ${file}`);
    }
  } finally { if (server.exitCode === null) await stop(server); stopTracing(); }
  if (stderr.includes("docker") || stderr.includes("standalone-acceptance-password")) throw new Error("Standalone logs contain forbidden runtime or secret material");
  process.stdout.write("Standalone bundle boot, restart, lock, Attachment, backup, and restore smoke passed.\n");
}
main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : "Standalone smoke failed"}\n`); process.exitCode = 1; });

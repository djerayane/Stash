import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createAuthenticationSecretCodec } from "./authentication-secrets.js";
import { developmentAdminToken, developmentMasterKey } from "./deployment-configuration.js";
import { EmbeddedInstanceStore } from "./embedded-instance-store.js";
import { EmbeddedLocalInstanceBackupSource, EmbeddedLocalInstanceRestoreTarget } from "./instance-backup-system.js";
import { InstanceBackupService } from "./instance-backup.js";
import { composeInstanceRuntime } from "./instance-runtime.js";

interface RuntimeConfiguration { schema: "stash.standalone-config.v1"; publicOrigin: string; host: string; port: number; masterKeyFile: string }

function usage(): never {
  throw new Error("usage: stash [serve] --data-dir <path> [--host <address>] [--port <port>] | stash backup <create|verify|restore> --data-dir <path> --backup <absolute-path> [--dry-run]");
}

function parse(values: string[]) {
  const command = values[0]?.startsWith("--") || values.length === 0 ? "serve" : values.shift()!;
  const operation = command === "backup" ? values.shift() : undefined;
  const options = new Map<string, string>(); let dryRun = false;
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === "--dry-run") { dryRun = true; continue; }
    const name = values[index]; const value = values[index + 1];
    if (!name?.startsWith("--") || !value || value.startsWith("--") || options.has(name)) usage();
    options.set(name, value); index += 1;
  }
  const dataDirectory = options.get("--data-dir");
  if (!dataDirectory) usage();
  return { command, operation, options, dryRun, dataDirectory: resolve(dataDirectory) };
}

async function loadConfiguration(dataDirectory: string, hostArgument?: string, portArgument?: string) {
  const configurationPath = join(dataDirectory, "config", "runtime.json");
  let saved: RuntimeConfiguration | undefined;
  try { saved = JSON.parse(await readFile(configurationPath, "utf8")) as RuntimeConfiguration; } catch { /* first start */ }
  const host = hostArgument?.trim() || saved?.host || "127.0.0.1";
  const port = Number.parseInt(portArgument ?? String(saved?.port ?? 3000), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("--port must be an integer between 1 and 65535");
  const masterKeyFile = saved?.masterKeyFile || join(dirname(dataDirectory), `.${basename(dataDirectory)}.master-key`);
  if (saved && (saved.schema !== "stash.standalone-config.v1" || !isAbsolute(masterKeyFile))) throw new Error("Standalone generated configuration is invalid");
  await mkdir(join(dataDirectory, "config"), { recursive: true });
  try { await readFile(masterKeyFile, "utf8"); } catch {
    await writeFile(masterKeyFile, `${randomBytes(32).toString("base64")}\n`, { mode: 0o600, flag: "wx" });
  }
  if (process.platform !== "win32") await chmod(masterKeyFile, 0o600);
  const configuration: RuntimeConfiguration = { schema: "stash.standalone-config.v1", publicOrigin: `http://localhost:${port}`, host, port, masterKeyFile };
  await writeFile(configurationPath, `${JSON.stringify(configuration, null, 2)}\n`, { mode: 0o600 });
  return { configuration, masterKey: (await readFile(masterKeyFile, "utf8")).trim() };
}

async function main() {
  const parsed = parse(process.argv.slice(2));
  const { configuration, masterKey } = await loadConfiguration(parsed.dataDirectory, parsed.options.get("--host"), parsed.options.get("--port"));
  if (parsed.command === "serve") {
    const runtime = await composeInstanceRuntime({ ...process.env, STASH_DATA_DIR: parsed.dataDirectory, DATABASE_URL: undefined,
      HOST: configuration.host, PORT: String(configuration.port), STASH_BIND_ADDRESS: configuration.host,
      PUBLIC_ORIGIN: configuration.publicOrigin, INSTANCE_MASTER_KEY: masterKey, INSTANCE_ADMIN_TOKEN: developmentAdminToken,
      POSTGRES_PASSWORD: "stash-development-only", OPEN_REGISTRATION: "true", WEB_CLIENT_ROOT: fileURLToPath(new URL("../web/", import.meta.url)) });
    process.stdout.write(`Stash standalone Instance listening on ${runtime.instance.url}\nData directory: ${parsed.dataDirectory}\n`);
    const close = async () => { await runtime.close(); process.exit(0); };
    process.once("SIGINT", close); process.once("SIGTERM", close); return;
  }
  if (parsed.command !== "backup" || !["create", "verify", "restore"].includes(parsed.operation ?? "")) usage();
  const backupPath = parsed.options.get("--backup");
  if (!backupPath || !isAbsolute(backupPath)) throw new Error("--backup must be an absolute path");
  const store = await EmbeddedInstanceStore.open(parsed.dataDirectory, createAuthenticationSecretCodec(masterKey));
  try {
    const service = new InstanceBackupService(new EmbeddedLocalInstanceBackupSource({ store, publicOrigin: configuration.publicOrigin }), { masterKey });
    const result = parsed.operation === "create" ? await service.create(backupPath)
      : parsed.operation === "verify" ? await service.verify(backupPath)
      : await service.restore(backupPath, new EmbeddedLocalInstanceRestoreTarget({ store, publicOrigin: configuration.publicOrigin }), { dryRun: parsed.dryRun });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally { await store.close(); }
}

main().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : "Standalone command failed"}\n`); process.exitCode = 1; });

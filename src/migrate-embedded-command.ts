import { resolve } from "node:path";
import { Pool } from "pg";

import { createAuthenticationSecretCodec } from "./authentication-secrets.js";
import { EmbeddedInstanceStore } from "./embedded-instance-store.js";
import { migrateEmbeddedInstance, readMigrationKeys, type MigrationKeyInput } from "./embedded-instance-migration.js";
import { PostgresDatabase } from "./postgres-database.js";
import { PostgresInstanceUpgradeTarget } from "./postgres-instance-upgrade.js";
import { readStashReleaseVersion } from "./release-version.js";

function requiredEnvironment(name: string): string { const value = process.env[name]?.trim(); if (!value) throw new Error(`${name} must be configured`); return value; }
function requiredCapacity(): bigint { const value = requiredEnvironment("DESTINATION_DATABASE_AVAILABLE_BYTES");
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error("DESTINATION_DATABASE_AVAILABLE_BYTES must be a positive integer"); return BigInt(value); }
function usage(): never { throw new Error("usage: stash migrate [prepare-destination] --mode <preserve|rotate> --source-key-file <path> [--destination-key-file <path>] [--data-dir <path> --attachment-root <path> --configuration-root <path>]"); }

async function main() {
  const values = new Map<string, string>(); const arguments_ = process.argv.slice(2);
  const operation = arguments_[0] === "prepare-destination" ? arguments_.shift() : "migrate";
  if (arguments_.some((value) => /--(?:source|destination)-(?:key|master-key)(?:=|$)/.test(value))) throw new Error("Master keys must be supplied through protected key files, never command-line values");
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index]; const value = arguments_[index + 1];
    if (!name?.startsWith("--") || !value || value.startsWith("--") || values.has(name)) usage(); values.set(name, value);
  }
  const dataDirectory = values.get("--data-dir"); const attachmentRoot = values.get("--attachment-root"); const configurationRoot = values.get("--configuration-root");
  const mode = values.get("--mode"); const sourceKeyFile = values.get("--source-key-file");
  if (!sourceKeyFile || mode !== "preserve" && mode !== "rotate") usage();
  if (operation === "migrate" && (!dataDirectory || !attachmentRoot || !configurationRoot)) usage();
  if (mode === "preserve" && values.has("--destination-key-file")) throw new Error("Preserve migration does not accept a destination key file");
  const input: MigrationKeyInput = mode === "preserve" ? { mode, sourceKeyFile: resolve(sourceKeyFile) }
    : { mode, sourceKeyFile: resolve(sourceKeyFile), ...(values.get("--destination-key-file") ? { destinationKeyFile: resolve(values.get("--destination-key-file")!) } : {}) };
  const keys = await readMigrationKeys(input);
  if (operation === "prepare-destination") {
    const destinationDatabaseUrl = requiredEnvironment("DESTINATION_DATABASE_URL");
    const inspection = new Pool({ connectionString: destinationDatabaseUrl, connectionTimeoutMillis: 2_000, max: 1 });
    try {
      const existing = await inspection.query<{ table_name: string }>(`SELECT table_name FROM information_schema.tables
        WHERE table_schema=current_schema() AND table_type='BASE TABLE' ORDER BY table_name`);
      if (existing.rowCount) throw new Error("Migration destination PostgreSQL schema must be empty before preparation");
    } finally { await inspection.end(); }
    const database = new PostgresDatabase(destinationDatabaseUrl, createAuthenticationSecretCodec(keys.destination));
    try { await database.verifyConnection(); await database.prepareInstanceStore(); }
    finally { await database.close(); }
    const target = new PostgresInstanceUpgradeTarget(destinationDatabaseUrl, async () => undefined);
    try {
      const targetVersion = await readStashReleaseVersion(); const plan = await target.inspect(targetVersion);
      if (plan.checks.some((check) => check.status === "fail")) throw new Error("Migration destination Instance format preparation failed");
      if (plan.currentVersion !== targetVersion) await target.apply(plan.currentVersion, targetVersion);
      process.stdout.write(`${JSON.stringify({ status: "prepared", targetVersion })}\n`);
    } finally { await target.close(); }
    return;
  }
  const store = await EmbeddedInstanceStore.open(resolve(dataDirectory!), createAuthenticationSecretCodec(keys.source));
  const auditedSurfaces = new Set<string>();
  const audit = (surface: string, content: string | Uint8Array) => {
    const bytes = typeof content === "string" ? Buffer.from(content) : Buffer.from(content);
    for (const secret of [keys.source, keys.destination]) if (bytes.includes(Buffer.from(secret))) throw new Error(`Migration secret audit rejected ${surface}`);
    auditedSurfaces.add(surface);
  };
  try {
    await store.database.verifyConnection();
    audit("process_arguments", JSON.stringify(process.argv)); audit("diagnostics", JSON.stringify({ operation: "embedded_migration", mode }));
    const result = await migrateEmbeddedInstance({ source: store, destinationDatabaseUrl: requiredEnvironment("DESTINATION_DATABASE_URL"),
      destinationAttachmentRoot: resolve(attachmentRoot!), destinationConfigurationRoot: resolve(configurationRoot!), destinationDatabaseAvailableBytes: requiredCapacity(), keys, audit });
    audit("result", JSON.stringify(result)); audit("operator_log", "Embedded Instance migration completed");
    process.stdout.write(`${JSON.stringify({ status: "migrated", ...result, auditedSurfaces: [...auditedSurfaces].sort() })}\n`);
  } finally { await store.close(); }
}

main().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : "Embedded Instance migration failed"}\n`); process.exitCode = 1; });

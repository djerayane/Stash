import { resolve } from "node:path";

import { createAuthenticationSecretCodec } from "./authentication-secrets.js";
import { EmbeddedInstanceStore } from "./embedded-instance-store.js";
import { migrateEmbeddedInstance, readMigrationKeys, type MigrationKeyInput } from "./embedded-instance-migration.js";

function requiredEnvironment(name: string): string { const value = process.env[name]?.trim(); if (!value) throw new Error(`${name} must be configured`); return value; }
function usage(): never { throw new Error("usage: stash-migrate-embedded --data-dir <path> --attachment-root <path> --mode <preserve|rotate> --source-key-file <path> [--destination-key-file <path>]"); }

async function main() {
  const values = new Map<string, string>(); const arguments_ = process.argv.slice(2);
  if (arguments_.some((value) => /--(?:source|destination)-(?:key|master-key)(?:=|$)/.test(value))) throw new Error("Master keys must be supplied through protected key files, never command-line values");
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index]; const value = arguments_[index + 1];
    if (!name?.startsWith("--") || !value || value.startsWith("--") || values.has(name)) usage(); values.set(name, value);
  }
  const dataDirectory = values.get("--data-dir"); const attachmentRoot = values.get("--attachment-root"); const mode = values.get("--mode"); const sourceKeyFile = values.get("--source-key-file");
  if (!dataDirectory || !attachmentRoot || !sourceKeyFile || mode !== "preserve" && mode !== "rotate") usage();
  const input: MigrationKeyInput = mode === "preserve" ? { mode, sourceKeyFile: resolve(sourceKeyFile) }
    : { mode, sourceKeyFile: resolve(sourceKeyFile), ...(values.get("--destination-key-file") ? { destinationKeyFile: resolve(values.get("--destination-key-file")!) } : {}) };
  const keys = await readMigrationKeys(input); const store = await EmbeddedInstanceStore.open(resolve(dataDirectory), createAuthenticationSecretCodec(keys.source));
  try {
    await store.database.verifyConnection();
    const result = await migrateEmbeddedInstance({ source: store, destinationDatabaseUrl: requiredEnvironment("DESTINATION_DATABASE_URL"),
      destinationAttachmentRoot: resolve(attachmentRoot), keys });
    process.stdout.write(`${JSON.stringify({ status: "migrated", ...result })}\n`);
  } finally { await store.close(); }
}

main().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : "Embedded Instance migration failed"}\n`); process.exitCode = 1; });

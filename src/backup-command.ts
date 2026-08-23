import { resolve } from "node:path";

import { InstanceBackupService } from "./instance-backup.js";
import { PostgresLocalInstanceBackupSource, PostgresLocalInstanceRestoreTarget } from "./instance-backup-system.js";

function required(name: string): string { const value = process.env[name]?.trim(); if (!value) throw new Error(`${name} must be configured`); return value; }

async function main() {
  const [operation, backupPath, flag] = process.argv.slice(2);
  if (!operation || !backupPath || !["create", "verify", "restore"].includes(operation)) {
    throw new Error("usage: stash-backup <create|verify|restore> <absolute-path> [--dry-run]");
  }
  const destination = resolve(backupPath);
  if (destination !== backupPath) throw new Error("Instance Backup path must be absolute");
  const databaseUrl = required("DATABASE_URL");
  const attachmentRoot = process.env.ATTACHMENT_STORAGE_PATH?.trim() || "/var/lib/stash/attachments";
  const publicOrigin = required("PUBLIC_ORIGIN");
  const source = new PostgresLocalInstanceBackupSource({ databaseUrl, attachmentRoot, publicOrigin });
  const service = new InstanceBackupService(source, { masterKey: required("INSTANCE_MASTER_KEY") });
  const result = operation === "create" ? await service.create(destination)
    : operation === "verify" ? await service.verify(destination)
    : await service.restore(destination, new PostgresLocalInstanceRestoreTarget({ databaseUrl, attachmentRoot, publicOrigin }), { dryRun: flag === "--dry-run" });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
main().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : "Instance Backup command failed"}\n`); process.exitCode = 1; });

import { opendir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { InstanceBackupRestoreTarget, InstanceBackupService } from "./instance-backup.js";
import { json, readJson, type HttpRoute } from "./http-routing.js";

const restorePath = /^\/api\/instance\/backups\/([^/]+)\/restore$/;

function backupName(value: string): string | undefined {
  try {
    const decoded = decodeURIComponent(value);
    return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(decoded) && decoded !== "." && decoded !== ".." ? decoded : undefined;
  } catch { return undefined; }
}

function restoreDiagnostic(error: unknown): { status: number; error: string; message: string } {
  const detail = error instanceof Error ? error.message : "";
  if (/master key does not match/i.test(detail)) return { status: 422, error: "master_key_mismatch", message: "The configured Instance master key does not match this backup. No Instance data was changed." };
  if (/unsupported Instance Backup version/i.test(detail)) return { status: 422, error: "unsupported_version", message: "This Stash version cannot restore the backup format. No Instance data was changed." };
  if (/manifest is missing|manifest is invalid|manifest has no restorable|required payload is missing|manifest file entry/i.test(detail)) return { status: 422, error: "invalid_manifest", message: "The backup manifest is missing or invalid. No Instance data was changed." };
  if (/checksum|inventory|symbolic link|file is missing or invalid|payload must contain regular files/i.test(detail)) return { status: 422, error: "integrity_failed", message: "The backup payload does not match its signed manifest. No Instance data was changed." };
  if (/configuration|PUBLIC_ORIGIN|Attachment storage adapter|master-key requirement/i.test(detail)) return { status: 422, error: "incompatible_configuration", message: "The backup is not compatible with this Instance configuration. No Instance data was changed." };
  if (/already running/i.test(detail)) return { status: 409, error: "backup_operation_in_progress", message: "Another Instance Backup operation is already running." };
  return { status: 503, error: "restore_failed", message: "The restore did not complete. Stash attempted to preserve the pre-restore Instance state; inspect operator logs before retrying." };
}

async function listBackups(root: string) {
  const backups: Array<{ name: string; createdAt?: string; schema?: string; verifiedAt?: string; status: "readable" | "invalid" }> = [];
  try {
    for await (const entry of await opendir(root)) {
      if (!entry.isDirectory() || !backupName(entry.name)) continue;
      try {
        const value = JSON.parse(await readFile(join(root, entry.name, "manifest.json"), "utf8")) as { schema?: unknown; createdAt?: unknown; verification?: { verifiedAt?: unknown } };
        if (typeof value.schema !== "string" || typeof value.createdAt !== "string") backups.push({ name: entry.name, status: "invalid" });
        else backups.push({ name: entry.name, schema: value.schema, createdAt: value.createdAt, status: "readable",
          ...(typeof value.verification?.verifiedAt === "string" ? { verifiedAt: value.verification.verifiedAt } : {}) });
      } catch { backups.push({ name: entry.name, status: "invalid" }); }
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return backups.sort((left, right) => (right.createdAt ?? "").localeCompare(left.createdAt ?? "") || left.name.localeCompare(right.name));
}

export function instanceBackupRoute(service: InstanceBackupService, backupRoot?: string, restoreTarget?: InstanceBackupRestoreTarget): HttpRoute {
  return {
    matches: (_request, url) => url.pathname === "/api/instance/backups/health" || url.pathname === "/api/instance/backups" || restorePath.test(url.pathname),
    async handle(request, response, url) {
      if (url.pathname.endsWith("/health") && request.method === "GET") {
        json(response, 200, backupRoot ? await service.refreshHealth(backupRoot) : service.health()); return true;
      }
      if (url.pathname === "/api/instance/backups" && request.method === "POST") {
        if (!backupRoot) { json(response, 503, { error: "backup_storage_unavailable", message: "INSTANCE_BACKUP_PATH is not configured." }); return true; }
        try {
          const name = new Date().toISOString().replaceAll(":", "-");
          const result = await service.create(join(backupRoot, name));
          json(response, 201, { status: result.status, createdAt: result.manifest.createdAt, path: name });
        } catch (error) {
          json(response, 503, { error: "backup_failed", message: error instanceof Error ? error.message : "Instance Backup failed." });
        }
        return true;
      }
      if (url.pathname === "/api/instance/backups" && request.method === "GET") {
        if (!backupRoot) { json(response, 503, { error: "backup_storage_unavailable", message: "INSTANCE_BACKUP_PATH is not configured." }); return true; }
        json(response, 200, { backups: await listBackups(backupRoot) }); return true;
      }
      const match = restorePath.exec(url.pathname);
      if (match && request.method === "POST") {
        if (!backupRoot || !restoreTarget) { json(response, 503, { error: "restore_unavailable", message: "Instance restore is not configured." }); return true; }
        const name = backupName(match[1]!); if (!name) { json(response, 400, { error: "invalid_backup_name", message: "Choose a backup from the configured backup directory." }); return true; }
        let value: unknown;
        try { value = await readJson(request); } catch { json(response, 400, { error: "invalid_request", message: "Restore options must be valid JSON." }); return true; }
        const options = value && typeof value === "object" && !Array.isArray(value) ? value as { dryRun?: unknown; confirmation?: unknown } : {};
        if (typeof options.dryRun !== "boolean") { json(response, 400, { error: "invalid_request", message: "Choose verification or restore." }); return true; }
        if (!options.dryRun && options.confirmation !== name) { json(response, 400, { error: "restore_confirmation_required", message: `Type ${name} to confirm this destructive restore.` }); return true; }
        try {
          const result = await service.restore(join(backupRoot, name), restoreTarget, { dryRun: options.dryRun });
          json(response, 200, { status: result.status, backup: name });
        } catch (error) { const diagnostic = restoreDiagnostic(error); json(response, diagnostic.status, { error: diagnostic.error, message: diagnostic.message }); }
        return true;
      }
      return false;
    },
  };
}

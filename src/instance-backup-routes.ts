import type { InstanceBackupService } from "./instance-backup.js";
import { json, type HttpRoute } from "./http-routing.js";
import { join } from "node:path";

export function instanceBackupRoute(service: InstanceBackupService, backupRoot?: string): HttpRoute {
  return {
    matches: (_request, url) => url.pathname === "/api/instance/backups/health" || url.pathname === "/api/instance/backups",
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
      return false;
    },
  };
}

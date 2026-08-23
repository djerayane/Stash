import type { InstanceUpgradeService } from "./instance-upgrade.js";
import { json, readJson, type HttpRoute } from "./http-routing.js";

export function instanceUpgradeRoute(service: InstanceUpgradeService): HttpRoute {
  return { matches: (_request, url) => url.pathname === "/api/instance/upgrade",
    async handle(request, response) {
      if (request.method === "GET") { try { json(response, 200, await service.plan()); } catch { json(response, 503, { error: "upgrade_preflight_unavailable", message: "Upgrade readiness could not be determined." }); } return true; }
      if (request.method !== "POST") return false;
      let value: unknown; try { value = await readJson(request); } catch { json(response, 400, { error: "invalid_request", message: "Upgrade confirmation must be valid JSON." }); return true; }
      const plan = await service.plan().catch(() => undefined);
      if (!plan) { json(response, 503, { error: "upgrade_preflight_unavailable", message: "Upgrade readiness could not be determined." }); return true; }
      if (!value || typeof value !== "object" || Array.isArray(value) || (value as { confirmation?: unknown }).confirmation !== plan.targetVersion) {
        json(response, 400, { error: "upgrade_confirmation_required", message: `Type ${plan.targetVersion} to confirm this upgrade.` }); return true;
      }
      if (plan.status !== "ready") { json(response, 409, { error: "upgrade_preflight_failed", message: "Every upgrade preflight check must pass before data is changed.", checks: plan.checks }); return true; }
      try { json(response, 200, await service.upgrade()); }
      catch (error) { const detail = error instanceof Error ? error.message : "";
        if (/already running/.test(detail)) json(response, 409, { error: "upgrade_in_progress", message: "An Instance upgrade is already running." });
        else if (/rolled back/.test(detail)) json(response, 503, { error: "upgrade_failed_rolled_back", message: "The upgrade failed. The verified pre-upgrade backup was restored; inspect operator logs before retrying." });
        else json(response, 503, { error: "upgrade_failed_recovery_required", message: "The upgrade and automatic rollback failed. Keep the Instance offline and restore the pre-upgrade backup manually." });
      } return true;
    } };
}

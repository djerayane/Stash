import type { CapabilityModule } from "../capability-registry.js";
import { diagnosticsAdminRoute, diagnosticsSchemaRoute } from "../diagnostics-routes.js";
import type { Diagnostics } from "../diagnostics.js";
import { requireInstanceAdministrator } from "../http-routing.js";

export function instanceOperationsCapability(options: {
  instanceAdminToken: string;
  diagnostics: Diagnostics;
}): CapabilityModule {
  return {
    name: "instance-operations",
    routes: () => [
      diagnosticsSchemaRoute(options.diagnostics),
      requireInstanceAdministrator(options.instanceAdminToken, diagnosticsAdminRoute(options.diagnostics)),
    ],
  };
}

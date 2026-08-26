import { ownerBootstrapRoute } from "../bootstrap-route.js";
import type { CapabilityModule } from "../capability-registry.js";
import { requireInstanceAdministrator } from "../http-routing.js";
import type { OwnerBootstrapService } from "../owner-bootstrap.js";

export function instanceOperationsCapability(options: {
  instanceAdminToken: string;
  ownerBootstrap: OwnerBootstrapService;
}): CapabilityModule {
  return {
    name: "instance-operations",
    routes: () => [
      requireInstanceAdministrator(options.instanceAdminToken, ownerBootstrapRoute(options.ownerBootstrap)),
    ],
  };
}

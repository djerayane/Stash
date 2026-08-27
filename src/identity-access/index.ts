import type { CapabilityModule } from "../capability-registry.js";
import { accountRegistrationRoute, type AuthenticationFailureReporter } from "../account-registration-routes.js";
import type { AccountRegistrationService } from "../account-registration.js";
import { ownerBootstrapRoute } from "../bootstrap-route.js";
import { requireInstanceAdministrator } from "../http-routing.js";
import type { OwnerBootstrapService } from "../owner-bootstrap.js";
import { passwordAuthRoute } from "../password-auth-routes.js";
import type { PasswordAuthService } from "../password-auth.js";
import { instanceSetupRoutes } from "./instance-setup-routes.js";
import type { InstanceSetupService } from "./instance-setup.js";

export function identityAccessCapability(options: {
  passwordAuth: PasswordAuthService;
  instanceAdminToken?: string;
  instanceSetup?: InstanceSetupService;
  ownerBootstrap?: OwnerBootstrapService;
  accountRegistration?: AccountRegistrationService;
  reportAuthenticationFailure?: AuthenticationFailureReporter;
}): CapabilityModule {
  return {
    name: "identity-access",
    owns: ["password-auth", "account-registration", ...(options.instanceSetup ? ["instance-setup"] : []),
      ...(options.ownerBootstrap ? ["owner-bootstrap"] : [])],
    routes: () => [
      ...(options.instanceSetup ? [instanceSetupRoutes(options.instanceSetup)] : []),
      accountRegistrationRoute(options.accountRegistration, options.reportAuthenticationFailure),
      passwordAuthRoute(options.passwordAuth, options.reportAuthenticationFailure),
      ...(options.instanceAdminToken ? [requireInstanceAdministrator(options.instanceAdminToken, ownerBootstrapRoute(options.ownerBootstrap))] : []),
    ],
  };
}

import type { CapabilityModule } from "../capability-registry.js";
import { accountRegistrationRoute, type AuthenticationFailureReporter } from "../account-registration-routes.js";
import type { AccountRegistrationService } from "../account-registration.js";
import { ownerBootstrapRoute } from "../bootstrap-route.js";
import { requireInstanceAdministrator } from "../http-routing.js";
import type { OwnerBootstrapService } from "../owner-bootstrap.js";
import { passwordAuthRoute } from "../password-auth-routes.js";
import type { PasswordAuthService } from "../password-auth.js";

export function identityAccessCapability(options: {
  passwordAuth: PasswordAuthService;
  instanceAdminToken: string;
  ownerBootstrap?: OwnerBootstrapService;
  accountRegistration?: AccountRegistrationService;
  reportAuthenticationFailure?: AuthenticationFailureReporter;
}): CapabilityModule {
  return {
    name: "identity-access",
    routes: () => [
      accountRegistrationRoute(options.accountRegistration, options.reportAuthenticationFailure),
      passwordAuthRoute(options.passwordAuth, options.reportAuthenticationFailure),
      requireInstanceAdministrator(options.instanceAdminToken, ownerBootstrapRoute(options.ownerBootstrap)),
    ],
  };
}

import type { CapabilityModule } from "../capability-registry.js";
import { accountRegistrationRoute, type AuthenticationFailureReporter } from "../account-registration-routes.js";
import type { AccountRegistrationService } from "../account-registration.js";
import { passwordAuthRoute } from "../password-auth-routes.js";
import type { PasswordAuthService } from "../password-auth.js";

export function identityAccessCapability(options: {
  passwordAuth: PasswordAuthService;
  accountRegistration?: AccountRegistrationService;
  reportAuthenticationFailure?: AuthenticationFailureReporter;
}): CapabilityModule {
  return {
    name: "identity-access",
    routes: () => [
      accountRegistrationRoute(options.accountRegistration, options.reportAuthenticationFailure),
      passwordAuthRoute(options.passwordAuth, options.reportAuthenticationFailure),
    ],
  };
}

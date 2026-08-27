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
import { starterTutorialRoutes } from "./starter-tutorial-routes.js";
import type { StarterTutorialService } from "./starter-tutorial.js";
import type { MemberAccessResolver } from "../workspaces-projects.js";

export function identityAccessCapability(options: {
  passwordAuth: PasswordAuthService;
  instanceAdminToken?: string;
  instanceSetup?: InstanceSetupService;
  ownerBootstrap?: OwnerBootstrapService;
  accountRegistration?: AccountRegistrationService;
  reportAuthenticationFailure?: AuthenticationFailureReporter;
  starterTutorials?: StarterTutorialService;
  memberAccess?: MemberAccessResolver;
}): CapabilityModule {
  return {
    name: "identity-access",
    routes: () => [
      ...(options.instanceSetup ? [instanceSetupRoutes(options.instanceSetup)] : []),
      ...(options.starterTutorials && options.memberAccess
        ? [starterTutorialRoutes(options.starterTutorials, options.memberAccess)] : []),
      accountRegistrationRoute(options.accountRegistration, options.reportAuthenticationFailure),
      passwordAuthRoute(options.passwordAuth, options.reportAuthenticationFailure),
      ...(options.instanceAdminToken ? [requireInstanceAdministrator(options.instanceAdminToken, ownerBootstrapRoute(options.ownerBootstrap))] : []),
    ],
  };
}

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
import { accountRecoveryRoute } from "../account-recovery-routes.js";
import type { AccountRecoveryService } from "../account-recovery.js";
import { importedIdentityAdministrationRoutes, type ImportedIdentityAdministration } from "../imported-identity-administration-routes.js";
import { invitationRoutes } from "../invitation-routes.js";
import type { InvitationService } from "../invitations.js";
import { memberLocalizationRoutes } from "../member-localization-routes.js";
import type { MemberLocalizationService } from "../member-localization.js";
import { oidcAuthRoute, oidcManagementRoute } from "../oidc-auth-routes.js";
import type { OidcAuthService } from "../oidc-auth.js";
import type { OidcManagementService } from "../oidc-management.js";
import { organizationRoleRoutes } from "../organization-role-routes.js";
import type { OrganizationRoleService } from "../organization-roles.js";
import type { MemberAccessResolver } from "../workspaces-projects.js";

export function validatedOidcCallbackOrigin(value: string | undefined, allowInsecureForTest = false): string {
  if (!value) throw new Error("PUBLIC_ORIGIN must be configured when OpenID Connect is enabled");
  let origin: URL;
  try { origin = new URL(value); } catch { throw new Error("PUBLIC_ORIGIN must be a valid absolute URL"); }
  const localhostHttp = origin.protocol === "http:" && origin.hostname === "localhost";
  if (origin.origin !== origin.href.replace(/\/$/, "") || origin.username || origin.password
    || (origin.protocol !== "https:" && !localhostHttp && !(allowInsecureForTest && origin.protocol === "http:"))) {
    throw new Error("PUBLIC_ORIGIN must be an HTTPS origin, or HTTP on localhost, without credentials, path, query, or fragment");
  }
  return origin.origin;
}

export function identityAccessCapability(options: {
  passwordAuth: PasswordAuthService;
  instanceAdminToken?: string;
  instanceSetup?: InstanceSetupService;
  ownerBootstrap?: OwnerBootstrapService;
  accountRegistration?: AccountRegistrationService;
  reportAuthenticationFailure?: AuthenticationFailureReporter;
  memberAccess?: MemberAccessResolver;
  organizationRoles?: OrganizationRoleService;
  invitations?: InvitationService;
  memberLocalization?: MemberLocalizationService;
  importedIdentityAdministration?: ImportedIdentityAdministration;
  accountRecovery?: AccountRecoveryService;
  oidcAuth?: OidcAuthService;
  oidcManagement?: OidcManagementService;
  oidcCallbackOrigin?: string;
  allowInsecureOidcCallbackOriginForTest?: boolean;
}): CapabilityModule {
  const oidcCallbackOrigin = options.oidcAuth
    ? validatedOidcCallbackOrigin(options.oidcCallbackOrigin, options.allowInsecureOidcCallbackOriginForTest)
    : undefined;
  const memberRoutes = () => [
    ...(options.organizationRoles && options.memberAccess ? [organizationRoleRoutes(options.organizationRoles, options.memberAccess)] : []),
    ...(options.invitations && options.memberAccess ? [invitationRoutes(options.invitations, options.memberAccess)] : []),
    ...(options.memberLocalization && options.memberAccess ? [memberLocalizationRoutes(options.memberLocalization, options.memberAccess)] : []),
    ...(options.importedIdentityAdministration && options.memberAccess ? [importedIdentityAdministrationRoutes(options.importedIdentityAdministration, options.memberAccess)] : []),
  ];
  return {
    name: "identity-access",
    memberAccess: options.passwordAuth,
    owns: ["password-auth", "account-registration", ...(options.instanceSetup ? ["instance-setup"] : []),
      ...(options.ownerBootstrap ? ["owner-bootstrap"] : []), ...(options.organizationRoles ? ["organization-roles"] : []),
      ...(options.invitations ? ["invitations"] : []), ...(options.memberLocalization ? ["member-localization"] : []),
      ...(options.importedIdentityAdministration ? ["imported-identities"] : []), ...(options.accountRecovery ? ["account-recovery"] : []),
      ...(options.oidcAuth ? ["oidc-auth"] : []), ...(options.oidcManagement ? ["oidc-management"] : [])],
    routes: () => [
      ...(options.instanceSetup ? [instanceSetupRoutes(options.instanceSetup)] : []),
      accountRegistrationRoute(options.accountRegistration, options.reportAuthenticationFailure),
      passwordAuthRoute(options.passwordAuth, options.reportAuthenticationFailure),
      ...(options.instanceAdminToken ? [requireInstanceAdministrator(options.instanceAdminToken, ownerBootstrapRoute(options.ownerBootstrap))] : []),
      ...memberRoutes(),
      ...(options.accountRecovery ? [accountRecoveryRoute(options.accountRecovery, { resolve: (authorization) => options.passwordAuth.authenticateBearer(authorization) })] : []),
      ...(options.oidcManagement ? [oidcManagementRoute(options.oidcManagement, options.passwordAuth)] : []),
      ...(options.oidcAuth && oidcCallbackOrigin ? [oidcAuthRoute(options.oidcAuth, oidcCallbackOrigin)] : []),
    ],
    publicRoutes: memberRoutes,
  };
}

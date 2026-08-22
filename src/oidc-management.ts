import {
  InvalidOidcRequest,
  OidcIdentityNotAuthorized,
  type OidcAuthRepository,
} from "./oidc-auth.js";
import { createOidcHttpClient, type OidcHttpClient } from "./oidc-http-client.js";

export class OidcManagementNotAuthorized extends Error {}

function managementInput(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InvalidOidcRequest();
  return value as Record<string, unknown>;
}

function configuredIssuer(value: string): string {
  const url = new URL(value);
  if (url.search || url.hash) throw new Error();
  return url.href.replace(/\/$/, "");
}

export class OidcManagementService {
  readonly #repository: OidcAuthRepository;
  readonly #http: OidcHttpClient;

  constructor(repository: OidcAuthRepository, http: OidcHttpClient = createOidcHttpClient()) {
    this.#repository = repository;
    this.#http = http;
  }

  async configure(accountId: string, organizationId: string, value: unknown): Promise<void> {
    await this.#requireAdministrator(accountId, organizationId);
    const input = managementInput(value);
    if (typeof input.issuer !== "string" || typeof input.clientId !== "string" || !input.clientId
      || typeof input.clientSecret !== "string" || !input.clientSecret) throw new InvalidOidcRequest();
    let issuer: string;
    try { issuer = configuredIssuer(input.issuer); } catch { throw new InvalidOidcRequest(); }
    try { await this.#http.validateUrl(issuer); } catch { throw new InvalidOidcRequest(); }
    await this.#repository.saveOidcConfiguration({ organizationId, issuer, clientId: input.clientId, clientSecret: input.clientSecret });
  }

  async linkIdentity(accountId: string, organizationId: string, value: unknown): Promise<void> {
    await this.#requireAdministrator(accountId, organizationId);
    const input = managementInput(value);
    if (typeof input.accountId !== "string" || !input.accountId || typeof input.subject !== "string" || !input.subject) {
      throw new InvalidOidcRequest();
    }
    const configuration = await this.#repository.findOidcConfiguration(organizationId);
    if (!configuration) throw new InvalidOidcRequest();
    if (!(await this.#repository.linkOidcIdentity(
      { organizationId, issuer: configuration.issuer, subject: input.subject },
      input.accountId,
    ))) {
      throw new OidcIdentityNotAuthorized();
    }
  }

  async #requireAdministrator(accountId: string, organizationId: string): Promise<void> {
    const role = await this.#repository.organizationRole(organizationId, accountId);
    if (role !== "Owner" && role !== "Admin") throw new OidcManagementNotAuthorized();
  }
}

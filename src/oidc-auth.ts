import {
  createHash,
  createPublicKey,
  randomBytes,
  verify,
  type JsonWebKey,
} from "node:crypto";

import type { SessionRecord } from "./password-auth.js";
import { issueSession } from "./auth-session.js";

export interface OidcIdentityRecord {
  accountId: string;
  name: string;
  email: string;
}

export interface OidcAuthRepository {
  findOidcIdentity(organizationId: string, issuer: string, subject: string): Promise<OidcIdentityRecord | undefined>;
  createSession(session: SessionRecord): Promise<void>;
}

export interface OidcOrganizationConfiguration {
  organizationId: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
}

interface ProviderMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

interface PendingAuthorization {
  organizationId: string;
  nonce: string;
  verifier: string;
  redirectUri: string;
  expiresAt: number;
}

export class InvalidOidcRequest extends Error {}
export class OidcIdentityNotAuthorized extends Error {}
export class OidcProviderRejected extends Error {}

function encodeSha256(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function configuredIssuer(value: string): string {
  const url = new URL(value);
  if (url.search || url.hash) throw new Error("OIDC issuer must not contain a query or fragment");
  return url.href.replace(/\/$/, "");
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new OidcProviderRejected();
  return value as Record<string, unknown>;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || !value) throw new OidcProviderRejected();
  return value;
}

export class OidcAuthService {
  readonly #repository: OidcAuthRepository;
  readonly #configurations: Map<string, OidcOrganizationConfiguration>;
  readonly #pending = new Map<string, PendingAuthorization>();
  readonly #fetch: typeof fetch;

  constructor(
    repository: OidcAuthRepository,
    configurations: OidcOrganizationConfiguration[],
    fetcher: typeof fetch = fetch,
  ) {
    this.#repository = repository;
    this.#fetch = fetcher;
    this.#configurations = new Map(configurations.map((configuration) => {
      if (!configuration.organizationId || !configuration.clientId || !configuration.clientSecret) {
        throw new Error("OIDC organizationId, clientId, and clientSecret must not be empty");
      }
      return [configuration.organizationId, { ...configuration, issuer: configuredIssuer(configuration.issuer) }];
    }));
  }

  async begin(organizationId: string, redirectUri: string): Promise<{ authorizationUrl: string }> {
    const configuration = this.#configuration(organizationId);
    const metadata = await this.#metadata(configuration);
    const state = randomBytes(32).toString("base64url");
    const nonce = randomBytes(32).toString("base64url");
    const verifier = randomBytes(48).toString("base64url");
    this.#discardExpired();
    this.#pending.set(state, {
      organizationId,
      nonce,
      verifier,
      redirectUri,
      expiresAt: Date.now() + 10 * 60_000,
    });
    const authorizationUrl = new URL(metadata.authorization_endpoint);
    authorizationUrl.search = new URLSearchParams({
      response_type: "code",
      scope: "openid",
      client_id: configuration.clientId,
      redirect_uri: redirectUri,
      state,
      nonce,
      code_challenge: encodeSha256(verifier),
      code_challenge_method: "S256",
    }).toString();
    return { authorizationUrl: authorizationUrl.toString() };
  }

  async complete(organizationId: string, code: string | null, state: string | null, userAgent?: string) {
    if (!code || !state) throw new InvalidOidcRequest();
    const pending = this.#pending.get(state);
    this.#pending.delete(state);
    if (!pending || pending.expiresAt < Date.now() || pending.organizationId !== organizationId) {
      throw new InvalidOidcRequest();
    }

    const configuration = this.#configuration(organizationId);
    const metadata = await this.#metadata(configuration);
    const response = await this.#fetch(metadata.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: pending.redirectUri,
        client_id: configuration.clientId,
        client_secret: configuration.clientSecret,
        code_verifier: pending.verifier,
      }),
    });
    if (!response.ok) throw new OidcProviderRejected();
    const tokens = object(await response.json());
    const claims = await this.#verifyIdToken(requiredString(tokens.id_token), configuration, metadata, pending.nonce);
    const identity = await this.#repository.findOidcIdentity(organizationId, configuration.issuer, claims.subject);
    if (!identity) throw new OidcIdentityNotAuthorized();

    return issueSession(this.#repository, { id: identity.accountId, name: identity.name, email: identity.email }, userAgent);
  }

  #configuration(organizationId: string): OidcOrganizationConfiguration {
    const configuration = this.#configurations.get(organizationId);
    if (!configuration) throw new InvalidOidcRequest();
    return configuration;
  }

  async #metadata(configuration: OidcOrganizationConfiguration): Promise<ProviderMetadata> {
    const response = await this.#fetch(`${configuration.issuer}/.well-known/openid-configuration`, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw new OidcProviderRejected();
    const document = object(await response.json());
    const metadata = {
      issuer: requiredString(document.issuer),
      authorization_endpoint: requiredString(document.authorization_endpoint),
      token_endpoint: requiredString(document.token_endpoint),
      jwks_uri: requiredString(document.jwks_uri),
    };
    if (metadata.issuer !== configuration.issuer) throw new OidcProviderRejected();
    return metadata;
  }

  async #verifyIdToken(token: string, configuration: OidcOrganizationConfiguration, metadata: ProviderMetadata, nonce: string) {
    const parts = token.split(".");
    if (parts.length !== 3) throw new OidcProviderRejected();
    const [encodedHeader, encodedClaims, encodedSignature] = parts as [string, string, string];
    let header: Record<string, unknown>;
    let claims: Record<string, unknown>;
    try {
      header = object(JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8")));
      claims = object(JSON.parse(Buffer.from(encodedClaims, "base64url").toString("utf8")));
    } catch {
      throw new OidcProviderRejected();
    }
    if (header.alg !== "RS256" || typeof header.kid !== "string") throw new OidcProviderRejected();
    const jwksResponse = await this.#fetch(metadata.jwks_uri, { headers: { accept: "application/json" } });
    if (!jwksResponse.ok) throw new OidcProviderRejected();
    const keys = object(await jwksResponse.json()).keys;
    if (!Array.isArray(keys)) throw new OidcProviderRejected();
    const jwk = keys.find((candidate) => object(candidate).kid === header.kid) as JsonWebKey | undefined;
    if (!jwk || !verify("RSA-SHA256", Buffer.from(`${encodedHeader}.${encodedClaims}`), createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(encodedSignature, "base64url"))) {
      throw new OidcProviderRejected();
    }
    const audience = claims.aud;
    const audienceMatches = audience === configuration.clientId
      || (Array.isArray(audience) && audience.includes(configuration.clientId));
    const now = Math.floor(Date.now() / 1000);
    if (claims.iss !== configuration.issuer || !audienceMatches || claims.nonce !== nonce
      || typeof claims.exp !== "number" || claims.exp <= now || typeof claims.iat !== "number" || claims.iat > now + 60
      || typeof claims.sub !== "string" || !claims.sub) {
      throw new OidcProviderRejected();
    }
    return { subject: claims.sub };
  }

  #discardExpired(): void {
    const now = Date.now();
    for (const [state, pending] of this.#pending) {
      if (pending.expiresAt < now) this.#pending.delete(state);
    }
  }
}

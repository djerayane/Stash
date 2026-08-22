import {
  createHash,
  createPublicKey,
  randomBytes,
  verify,
  type JsonWebKey,
} from "node:crypto";

import type { SessionRecord } from "./password-auth.js";
import { issueSession } from "./auth-session.js";
import { createOidcHttpClient, type OidcHttpClient } from "./oidc-http-client.js";

export interface OidcIdentityRecord {
  accountId: string;
  name: string;
  email: string;
}

export interface OidcIdentityKey {
  organizationId: string;
  issuer: string;
  subject: string;
}

export interface OidcAuthRepository {
  findOidcConfiguration(organizationId: string): Promise<OidcOrganizationConfiguration | undefined>;
  findOidcIdentity(key: OidcIdentityKey): Promise<OidcIdentityRecord | undefined>;
  createSession(session: SessionRecord): Promise<void>;
  organizationRole(organizationId: string, accountId: string): Promise<BuiltInRole | undefined>;
  saveOidcConfiguration(configuration: OidcOrganizationConfiguration): Promise<void>;
  linkOidcIdentity(key: OidcIdentityKey, accountId: string): Promise<boolean>;
}

export type BuiltInRole = "Owner" | "Admin" | "Member";

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

function providerObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new OidcProviderRejected();
  return value as Record<string, unknown>;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || !value) throw new OidcProviderRejected();
  return value;
}

export class OidcAuthService {
  readonly #repository: OidcAuthRepository;
  readonly #pending = new Map<string, PendingAuthorization>();
  readonly #http: OidcHttpClient;

  constructor(
    repository: OidcAuthRepository,
    http: OidcHttpClient = createOidcHttpClient(),
  ) {
    this.#repository = repository;
    this.#http = http;
  }

  async begin(organizationId: string, redirectUri: string): Promise<{ authorizationUrl: string }> {
    const configuration = await this.#configuration(organizationId);
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

    const configuration = await this.#configuration(organizationId);
    const metadata = await this.#metadata(configuration);
    const tokens = providerObject(await this.#providerRequest(() => this.#http.postForm(
      metadata.token_endpoint,
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: pending.redirectUri,
        client_id: configuration.clientId,
        client_secret: configuration.clientSecret,
        code_verifier: pending.verifier,
      }),
    )));
    const claims = await this.#verifyIdToken(requiredString(tokens.id_token), configuration, metadata, pending.nonce);
    const identityKey: OidcIdentityKey = { organizationId, issuer: configuration.issuer, subject: claims.subject };
    const identity = await this.#repository.findOidcIdentity(identityKey);
    if (!identity) throw new OidcIdentityNotAuthorized();

    return issueSession(this.#repository, { id: identity.accountId, name: identity.name, email: identity.email }, userAgent);
  }

  async #configuration(organizationId: string): Promise<OidcOrganizationConfiguration> {
    const configuration = await this.#repository.findOidcConfiguration(organizationId);
    if (!configuration) throw new InvalidOidcRequest();
    return configuration;
  }

  async #metadata(configuration: OidcOrganizationConfiguration): Promise<ProviderMetadata> {
    const document = providerObject(await this.#providerRequest(
      () => this.#http.getJson(`${configuration.issuer}/.well-known/openid-configuration`),
    ));
    const metadata = {
      issuer: requiredString(document.issuer),
      authorization_endpoint: requiredString(document.authorization_endpoint),
      token_endpoint: requiredString(document.token_endpoint),
      jwks_uri: requiredString(document.jwks_uri),
    };
    if (metadata.issuer !== configuration.issuer) throw new OidcProviderRejected();
    await this.#providerRequest(async () => {
      await Promise.all([
        this.#http.validateUrl(metadata.authorization_endpoint),
        this.#http.validateUrl(metadata.token_endpoint),
        this.#http.validateUrl(metadata.jwks_uri),
      ]);
    });
    return metadata;
  }

  async #verifyIdToken(token: string, configuration: OidcOrganizationConfiguration, metadata: ProviderMetadata, nonce: string) {
    const parts = token.split(".");
    if (parts.length !== 3) throw new OidcProviderRejected();
    const [encodedHeader, encodedClaims, encodedSignature] = parts as [string, string, string];
    let header: Record<string, unknown>;
    let claims: Record<string, unknown>;
    try {
      header = providerObject(JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8")));
      claims = providerObject(JSON.parse(Buffer.from(encodedClaims, "base64url").toString("utf8")));
    } catch {
      throw new OidcProviderRejected();
    }
    if (header.alg !== "RS256" || typeof header.kid !== "string") throw new OidcProviderRejected();
    const keys = providerObject(await this.#providerRequest(() => this.#http.getJson(metadata.jwks_uri))).keys;
    if (!Array.isArray(keys)) throw new OidcProviderRejected();
    const jwk = keys.find((candidate) => providerObject(candidate).kid === header.kid) as JsonWebKey | undefined;
    if (!jwk || !verify("RSA-SHA256", Buffer.from(`${encodedHeader}.${encodedClaims}`), createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(encodedSignature, "base64url"))) {
      throw new OidcProviderRejected();
    }
    const audience = claims.aud;
    const audienceMatches = audience === configuration.clientId
      || (Array.isArray(audience) && audience.includes(configuration.clientId));
    const authorizedPartyMatches = !Array.isArray(audience) || audience.length <= 1
      || claims.azp === configuration.clientId;
    const now = Math.floor(Date.now() / 1000);
    if (claims.iss !== configuration.issuer || !audienceMatches || !authorizedPartyMatches || claims.nonce !== nonce
      || typeof claims.exp !== "number" || claims.exp <= now || typeof claims.iat !== "number" || claims.iat > now + 60
      || typeof claims.sub !== "string" || !claims.sub) {
      throw new OidcProviderRejected();
    }
    return { subject: claims.sub };
  }

  async #providerRequest<T>(request: () => Promise<T>): Promise<T> {
    try { return await request(); } catch { throw new OidcProviderRejected(); }
  }

  #discardExpired(): void {
    const now = Date.now();
    for (const [state, pending] of this.#pending) {
      if (pending.expiresAt < now) this.#pending.delete(state);
    }
  }
}

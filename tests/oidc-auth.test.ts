import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, it } from "node:test";

import { startInstance, type DatabaseProbe, type RunningInstance } from "../src/instance.js";
import {
  OidcAuthService,
  type OidcAuthRepository,
  type OidcIdentityKey,
  type OidcIdentityRecord,
} from "../src/oidc-auth.js";
import { OidcManagementService } from "../src/oidc-management.js";
import { createOidcHttpClient, isPublicOidcAddress } from "../src/oidc-http-client.js";
import type { SessionRecord } from "../src/password-auth.js";
import { PasswordAuthService, type AccountAuthenticationRecord, type PasswordAuthRepository } from "../src/password-auth.js";

const organizationId = "11111111-1111-4111-8111-111111111111";
const canonicalCallbackOrigin = "http://stash.public.test";

function identityMapKey(key: OidcIdentityKey): string {
  return `${key.organizationId}:${key.issuer}:${key.subject}`;
}

class ProtocolCompatibleOidcDatabase implements DatabaseProbe, OidcAuthRepository, PasswordAuthRepository {
  readonly identities = new Map<string, OidcIdentityRecord>();
  readonly configurations = new Map<string, import("../src/oidc-auth.js").OidcOrganizationConfiguration>();
  readonly sessions = new Map<string, SessionRecord>();
  sessionLookupCalls = 0;
  failure: Error | undefined;

  async verifyConnection() {}
  async close() {}
  async findOidcIdentity(key: OidcIdentityKey) {
    if (this.failure) throw this.failure;
    return this.identities.get(identityMapKey(key));
  }
  async findOidcConfiguration(organizationId: string) { return this.configurations.get(organizationId); }
  async organizationRole(_organizationId: string, accountId: string) { return accountId === "account-1" ? "Owner" as const : undefined; }
  async saveOidcConfiguration(configuration: import("../src/oidc-auth.js").OidcOrganizationConfiguration) { this.configurations.set(configuration.organizationId, configuration); }
  async linkOidcIdentity(key: OidcIdentityKey, accountId: string) {
    if (accountId !== "account-1") return false;
    this.identities.set(identityMapKey(key), { accountId, name: "Ada Lovelace", email: "ada@example.com" });
    return true;
  }
  async findAccountByEmail(_email: string): Promise<AccountAuthenticationRecord | undefined> { return undefined; }
  async findAccountById(_id: string): Promise<AccountAuthenticationRecord | undefined> { return undefined; }
  async createSession(session: SessionRecord) {
    if (this.failure) throw this.failure;
    this.sessions.set(session.id, session);
  }
  async findSessionByTokenHash(tokenHash: string) {
    this.sessionLookupCalls += 1;
    return [...this.sessions.values()].find((session) => session.tokenHash === tokenHash);
  }
  async listSessions(_accountId: string) { return []; }
  async deleteSession(_accountId: string, _sessionId: string) { return false; }
  async changePasswordAndDeleteOtherSessions(_accountId: string, _currentSessionId: string, _passwordHash: string) {}
}

class ProtocolCompatibleOidcProvider {
  readonly issuer: string;
  readonly server: Server;
  readonly #privateKey;
  readonly jwk;
  expectedNonce = "";
  tokenRequest: URLSearchParams | undefined;
  subject = "provider-member-1";
  audience: string | string[] = "stash-client";
  authorizedParty: string | undefined;
  discoveryRedirect: string | undefined;
  tokenEndpoint: string | undefined;

  private constructor(server: Server, issuer: string) {
    this.server = server;
    this.issuer = issuer;
    const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    this.#privateKey = keys.privateKey;
    this.jwk = { ...keys.publicKey.export({ format: "jwk" }), kid: "test-key", use: "sig", alg: "RS256" };
  }

  static async start() {
    let provider!: ProtocolCompatibleOidcProvider;
    const server = createServer(async (request, response) => provider.handle(request, response));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("provider did not bind");
    provider = new ProtocolCompatibleOidcProvider(server, `http://127.0.0.1:${address.port}`);
    return provider;
  }

  async close() {
    await new Promise<void>((resolve, reject) => this.server.close((error) => error ? reject(error) : resolve()));
  }

  async handle(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? "/", this.issuer);
    if (url.pathname === "/.well-known/openid-configuration") {
      if (this.discoveryRedirect) {
        response.writeHead(302, { location: this.discoveryRedirect }).end();
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ issuer: this.issuer, authorization_endpoint: `${this.issuer}/authorize`, token_endpoint: this.tokenEndpoint ?? `${this.issuer}/token`, jwks_uri: `${this.issuer}/jwks` }));
      return;
    }
    if (url.pathname === "/jwks") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ keys: [this.jwk] }));
      return;
    }
    if (url.pathname === "/token") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString("utf8");
      this.tokenRequest = new URLSearchParams(body);
      const now = Math.floor(Date.now() / 1000);
      const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "test-key", typ: "JWT" })).toString("base64url");
      const payload = Buffer.from(JSON.stringify({ iss: this.issuer, aud: this.audience, ...(this.authorizedParty ? { azp: this.authorizedParty } : {}), sub: this.subject, nonce: this.expectedNonce, iat: now, exp: now + 300 })).toString("base64url");
      const encoded = `${header}.${payload}`;
      const signature = sign("RSA-SHA256", Buffer.from(encoded), this.#privateKey).toString("base64url");
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ token_type: "Bearer", id_token: `${encoded}.${signature}` }));
      return;
    }
    if (url.pathname === "/slow") {
      response.writeHead(200, { "content-type": "application/json" });
      response.write("{");
      const interval = setInterval(() => response.write(" "), 10);
      response.once("close", () => clearInterval(interval));
      return;
    }
    response.writeHead(404).end();
  }
}

describe("optional OpenID Connect authentication on a running Stash Instance", () => {
  let instance: RunningInstance | undefined;
  let provider: ProtocolCompatibleOidcProvider | undefined;

  afterEach(async () => {
    await instance?.close();
    await provider?.close();
    instance = undefined;
    provider = undefined;
  });

  async function run() {
    provider = await ProtocolCompatibleOidcProvider.start();
    const database = new ProtocolCompatibleOidcDatabase();
    const adminToken = "organization-owner-session";
    database.sessions.set("admin-session", { id: "admin-session", accountId: "account-1", tokenHash: createHash("sha256").update(adminToken).digest("base64"), createdAt: new Date().toISOString(), lastSeenAt: new Date().toISOString() });
    database.identities.set(`${organizationId}:${provider.issuer}:provider-member-1`, {
      accountId: "account-1", name: "Ada Lovelace", email: "ada@example.com",
    });
    database.configurations.set(organizationId, { organizationId, issuer: provider.issuer, clientId: "stash-client", clientSecret: "provider-secret" });
    const oidcHttp = createOidcHttpClient({ allowUnsafeForTest: (url) => url.hostname === "127.0.0.1" });
    const oidc = new OidcAuthService(database, oidcHttp);
    instance = await startInstance({ database, host: "127.0.0.1", port: 0, instanceAdminToken: "admin-token", oidcAuth: oidc, oidcManagement: new OidcManagementService(database, oidcHttp), passwordAuth: new PasswordAuthService(database), oidcCallbackOrigin: canonicalCallbackOrigin, allowInsecureOidcCallbackOriginForTest: true });
    return { baseUrl: instance.url, database, provider, adminToken };
  }

  it("lets an Organization Owner enable OIDC and link an existing Member through supported boundaries", async () => {
    const { baseUrl, database, provider, adminToken } = await run();
    database.configurations.clear();
    database.identities.clear();
    const unauthorized = await fetch(`${baseUrl}/api/organizations/${organizationId}/auth/oidc`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: "{}",
    });
    assert.equal(unauthorized.status, 401);
    const invalid = await fetch(`${baseUrl}/api/organizations/${organizationId}/auth/oidc`, {
      method: "PUT", headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" }, body: "[]",
    });
    assert.equal(invalid.status, 422);
    const unsafeIssuer = await fetch(`${baseUrl}/api/organizations/${organizationId}/auth/oidc`, {
      method: "PUT",
      headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
      body: JSON.stringify({ issuer: "http://169.254.169.254", clientId: "stash-client", clientSecret: "provider-secret" }),
    });
    assert.equal(unsafeIssuer.status, 422);

    const configured = await fetch(`${baseUrl}/api/organizations/${organizationId}/auth/oidc`, {
      method: "PUT",
      headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
      body: JSON.stringify({ issuer: provider.issuer, clientId: "stash-client", clientSecret: "provider-secret" }),
    });
    assert.equal(configured.status, 204);
    const linked = await fetch(`${baseUrl}/api/organizations/${organizationId}/auth/oidc/identities`, {
      method: "POST",
      headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
      body: JSON.stringify({ accountId: "account-1", subject: "provider-member-1" }),
    });
    assert.equal(linked.status, 204);
    assert.ok(database.identities.has(`${organizationId}:${provider.issuer}:provider-member-1`));
  });

  it("fails startup visibly when the canonical OIDC callback origin is missing or invalid", async () => {
    const database = new ProtocolCompatibleOidcDatabase();
    const oidc = new OidcAuthService(database, createOidcHttpClient({ allowUnsafeForTest: () => true }));
    await assert.rejects(
      startInstance({ database, host: "127.0.0.1", port: 0, instanceAdminToken: "admin", oidcAuth: oidc }),
      /PUBLIC_ORIGIN must be configured/,
    );
    await assert.rejects(
      startInstance({ database, host: "127.0.0.1", port: 0, instanceAdminToken: "admin", oidcAuth: oidc, oidcCallbackOrigin: "http://stash.example" }),
      /PUBLIC_ORIGIN must be an HTTPS origin/,
    );
  });

  it("signs a mapped Organization Member in through OIDC while built-in auth remains independently available", async () => {
    const { baseUrl, database, provider } = await run();
    const start = await fetch(`${baseUrl}/api/auth/oidc/${organizationId}`, {
      headers: { host: "attacker.example", "x-forwarded-proto": "https", "x-forwarded-host": "attacker.example" },
    });
    assert.equal(start.status, 200);
    const { authorizationUrl } = await start.json() as { authorizationUrl: string };
    const authorize = new URL(authorizationUrl);
    assert.equal(authorize.origin, provider.issuer);
    assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
    assert.equal(authorize.searchParams.get("redirect_uri"), `${canonicalCallbackOrigin}/api/auth/oidc/${organizationId}/callback`);
    provider.expectedNonce = authorize.searchParams.get("nonce")!;

    const callback = await fetch(`${baseUrl}/api/auth/oidc/${organizationId}/callback?code=${randomUUID()}&state=${authorize.searchParams.get("state")}`);
    assert.equal(callback.status, 201);
    const result = await callback.json() as { token: string; member: { email: string } };
    assert.equal(result.member.email, "ada@example.com");
    assert.ok(result.token.length >= 32);
    assert.equal(database.sessions.size, 2);
    assert.equal(provider.tokenRequest?.get("client_secret"), "provider-secret");
    assert.equal(provider.tokenRequest?.get("redirect_uri"), `${canonicalCallbackOrigin}/api/auth/oidc/${organizationId}/callback`);
    assert.equal(provider.tokenRequest?.get("code_verifier")?.length, 64);

    const local = await fetch(`${baseUrl}/api/auth/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(local.status, 422);
  });

  it("hands browser callbacks to the React client without placing the token in a query string", async () => {
    const { baseUrl, provider } = await run();
    const start = await fetch(`${baseUrl}/api/auth/oidc/${organizationId}`);
    const { authorizationUrl } = await start.json() as { authorizationUrl: string };
    const authorize = new URL(authorizationUrl);
    provider.expectedNonce = authorize.searchParams.get("nonce")!;
    const callback = await fetch(`${baseUrl}/api/auth/oidc/${organizationId}/callback?code=browser-code&state=${authorize.searchParams.get("state")}`, {
      headers: { accept: "text/html" }, redirect: "manual",
    });
    assert.equal(callback.status, 303);
    const location = callback.headers.get("location")!;
    assert.match(location, /^\/auth\/oidc\/callback#token=/);
    assert.doesNotMatch(location, /[?&]token=/);
  });

  it("rejects replayed state, unmapped identities, and provider failures without exposing secrets", async () => {
    const { baseUrl, database, provider } = await run();
    const begin = async () => {
      const response = await fetch(`${baseUrl}/api/auth/oidc/${organizationId}`);
      const body = await response.json() as { authorizationUrl: string };
      const url = new URL(body.authorizationUrl);
      provider.expectedNonce = url.searchParams.get("nonce")!;
      return url.searchParams.get("state")!;
    };
    const state = await begin();
    const callbackUrl = `${baseUrl}/api/auth/oidc/${organizationId}/callback?code=valid-code&state=${state}`;
    assert.equal((await fetch(callbackUrl)).status, 201);
    assert.equal((await fetch(callbackUrl)).status, 422);

    provider.subject = "not-linked";
    const unmapped = await fetch(`${baseUrl}/api/auth/oidc/${organizationId}/callback?code=valid-code&state=${await begin()}`);
    assert.equal(unmapped.status, 403);

    provider.subject = "provider-member-1";
    database.failure = new Error("provider-secret postgres://stash:secret@db/stash");
    const failed = await fetch(`${baseUrl}/api/auth/oidc/${organizationId}/callback?code=valid-code&state=${await begin()}`);
    assert.equal(failed.status, 503);
    assert.doesNotMatch(await failed.text(), /provider-secret|postgres|stash:secret/);
  });

  it("requires azp to identify Stash when an ID token has multiple audiences", async () => {
    const { baseUrl, provider } = await run();
    provider.audience = ["stash-client", "another-client"];
    const begin = async () => {
      const response = await fetch(`${baseUrl}/api/auth/oidc/${organizationId}`);
      const { authorizationUrl } = await response.json() as { authorizationUrl: string };
      const authorize = new URL(authorizationUrl);
      provider.expectedNonce = authorize.searchParams.get("nonce")!;
      return authorize.searchParams.get("state")!;
    };
    const rejected = await fetch(`${baseUrl}/api/auth/oidc/${organizationId}/callback?code=code&state=${await begin()}`);
    assert.equal(rejected.status, 502);
    provider.authorizedParty = "stash-client";
    const accepted = await fetch(`${baseUrl}/api/auth/oidc/${organizationId}/callback?code=code&state=${await begin()}`);
    assert.equal(accepted.status, 201);
  });

  it("rejects malformed Organization IDs before repository access", async () => {
    const { baseUrl, adminToken, database } = await run();
    assert.equal((await fetch(`${baseUrl}/api/auth/oidc/not-a-uuid`)).status, 422);
    assert.equal((await fetch(`${baseUrl}/api/auth/oidc/%25ZZ`)).status, 422);
    assert.equal((await fetch(`${baseUrl}/api/organizations/not-a-uuid/auth/oidc`, {
      method: "PUT",
      headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
      body: "{}",
    })).status, 422);
    assert.equal(database.sessionLookupCalls, 0);
  });

  it("blocks insecure and private OIDC endpoints at the outbound boundary", async () => {
    const { baseUrl, database, provider } = await run();
    provider.discoveryRedirect = "http://169.254.169.254/latest/meta-data";
    assert.equal((await fetch(`${baseUrl}/api/auth/oidc/${organizationId}`)).status, 502);
    provider.discoveryRedirect = undefined;
    provider.tokenEndpoint = "https://169.254.169.254/token";
    assert.equal((await fetch(`${baseUrl}/api/auth/oidc/${organizationId}`)).status, 502);
    provider.tokenEndpoint = undefined;

    database.configurations.set(organizationId, { organizationId, issuer: provider.issuer, clientId: "stash-client", clientSecret: "provider-secret" });
    await instance?.close();
    instance = await startInstance({
      database,
      host: "127.0.0.1",
      port: 0,
      instanceAdminToken: "admin-token",
      oidcAuth: new OidcAuthService(database, createOidcHttpClient({ resolve: async () => [{ address: "127.0.0.1", family: 4 }] })),
      oidcCallbackOrigin: "https://stash.example.com",
    });
    assert.equal((await fetch(`${instance.url}/api/auth/oidc/${organizationId}`)).status, 502);

    database.configurations.set(organizationId, { organizationId, issuer: "https://identity.example", clientId: "stash-client", clientSecret: "provider-secret" });
    assert.equal((await fetch(`${instance.url}/api/auth/oidc/${organizationId}`)).status, 502);
  });
});

describe("OIDC outbound address policy", () => {
  it("allows global addresses and rejects private, reserved, documentation, transition, and mapped ranges", () => {
    for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8", "::ffff:0808:0808"]) {
      assert.equal(isPublicOidcAddress(address), true, address);
    }
    for (const address of [
      "0.0.0.0", "10.0.0.1", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.1",
      "192.0.0.1", "192.0.2.1", "192.88.99.1", "192.168.0.1", "198.18.0.1", "198.51.100.1",
      "203.0.113.1", "224.0.0.1", "240.0.0.1", "::", "::1", "fe80::1", "fc00::1", "ff02::1",
      "2001:db8::1", "2001::1", "2002::1", "3fff::1", "::ffff:127.0.0.1", "::ffff:7f00:1",
    ]) {
      assert.equal(isPublicOidcAddress(address), false, address);
    }
  });

  it("applies one absolute deadline to stalled DNS resolution", async () => {
    let resolverAborted = false;
    const client = createOidcHttpClient({
      timeoutMs: 30,
      resolve: async (_hostname, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => { resolverAborted = true; reject(signal.reason); }, { once: true });
      }),
    });
    await assert.rejects(client.getJson("https://identity.example/config"), /deadline exceeded/);
    assert.equal(resolverAborted, true);
  });

  it("applies the absolute deadline while a provider slowly streams a response", async () => {
    const provider = await ProtocolCompatibleOidcProvider.start();
    try {
      const client = createOidcHttpClient({
        timeoutMs: 40,
        allowUnsafeForTest: (url) => url.hostname === "127.0.0.1",
      });
      const startedAt = Date.now();
      await assert.rejects(client.getJson(`${provider.issuer}/slow`), /deadline exceeded/);
      assert.ok(Date.now() - startedAt < 500);
    } finally {
      await provider.close();
    }
  });
});

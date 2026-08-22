import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, it } from "node:test";

import { startInstance, type DatabaseProbe, type RunningInstance } from "../src/instance.js";
import {
  OidcAuthService,
  type OidcAuthRepository,
  type OidcIdentityRecord,
} from "../src/oidc-auth.js";
import type { SessionRecord } from "../src/password-auth.js";
import { PasswordAuthService, type AccountAuthenticationRecord, type PasswordAuthRepository } from "../src/password-auth.js";

class ProtocolCompatibleOidcDatabase implements DatabaseProbe, OidcAuthRepository, PasswordAuthRepository {
  readonly identities = new Map<string, OidcIdentityRecord>();
  readonly sessions = new Map<string, SessionRecord>();
  failure: Error | undefined;

  async verifyConnection() {}
  async close() {}
  async findOidcIdentity(organizationId: string, issuer: string, subject: string) {
    if (this.failure) throw this.failure;
    return this.identities.get(`${organizationId}:${issuer}:${subject}`);
  }
  async findAccountByEmail(_email: string): Promise<AccountAuthenticationRecord | undefined> { return undefined; }
  async findAccountById(_id: string): Promise<AccountAuthenticationRecord | undefined> { return undefined; }
  async createSession(session: SessionRecord) {
    if (this.failure) throw this.failure;
    this.sessions.set(session.id, session);
  }
  async findSessionByTokenHash(_tokenHash: string) { return undefined; }
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
  audience = "stash-client";

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
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ issuer: this.issuer, authorization_endpoint: `${this.issuer}/authorize`, token_endpoint: `${this.issuer}/token`, jwks_uri: `${this.issuer}/jwks` }));
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
      const payload = Buffer.from(JSON.stringify({ iss: this.issuer, aud: this.audience, sub: this.subject, nonce: this.expectedNonce, iat: now, exp: now + 300 })).toString("base64url");
      const encoded = `${header}.${payload}`;
      const signature = sign("RSA-SHA256", Buffer.from(encoded), this.#privateKey).toString("base64url");
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ token_type: "Bearer", id_token: `${encoded}.${signature}` }));
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
    database.identities.set(`organization-1:${provider.issuer}:provider-member-1`, {
      accountId: "account-1", name: "Ada Lovelace", email: "ada@example.com",
    });
    const oidc = new OidcAuthService(database, [{ organizationId: "organization-1", issuer: provider.issuer, clientId: "stash-client", clientSecret: "provider-secret" }]);
    instance = await startInstance({ database, host: "127.0.0.1", port: 0, instanceAdminToken: "admin-token", oidcAuth: oidc, passwordAuth: new PasswordAuthService(database) });
    return { baseUrl: instance.url, database, provider };
  }

  it("signs a mapped Organization Member in through OIDC while built-in auth remains independently available", async () => {
    const { baseUrl, database, provider } = await run();
    const start = await fetch(`${baseUrl}/api/auth/oidc/organization-1`);
    assert.equal(start.status, 200);
    const { authorizationUrl } = await start.json() as { authorizationUrl: string };
    const authorize = new URL(authorizationUrl);
    assert.equal(authorize.origin, provider.issuer);
    assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
    provider.expectedNonce = authorize.searchParams.get("nonce")!;

    const callback = await fetch(`${baseUrl}/api/auth/oidc/organization-1/callback?code=${randomUUID()}&state=${authorize.searchParams.get("state")}`);
    assert.equal(callback.status, 201);
    const result = await callback.json() as { token: string; member: { email: string } };
    assert.equal(result.member.email, "ada@example.com");
    assert.ok(result.token.length >= 32);
    assert.equal(database.sessions.size, 1);
    assert.equal(provider.tokenRequest?.get("client_secret"), "provider-secret");
    assert.equal(provider.tokenRequest?.get("code_verifier")?.length, 64);

    const local = await fetch(`${baseUrl}/api/auth/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(local.status, 422);
  });

  it("rejects replayed state, unmapped identities, and provider failures without exposing secrets", async () => {
    const { baseUrl, database, provider } = await run();
    const begin = async () => {
      const response = await fetch(`${baseUrl}/api/auth/oidc/organization-1`);
      const body = await response.json() as { authorizationUrl: string };
      const url = new URL(body.authorizationUrl);
      provider.expectedNonce = url.searchParams.get("nonce")!;
      return url.searchParams.get("state")!;
    };
    const state = await begin();
    const callbackUrl = `${baseUrl}/api/auth/oidc/organization-1/callback?code=valid-code&state=${state}`;
    assert.equal((await fetch(callbackUrl)).status, 201);
    assert.equal((await fetch(callbackUrl)).status, 422);

    provider.subject = "not-linked";
    const unmapped = await fetch(`${baseUrl}/api/auth/oidc/organization-1/callback?code=valid-code&state=${await begin()}`);
    assert.equal(unmapped.status, 403);

    provider.subject = "provider-member-1";
    database.failure = new Error("provider-secret postgres://stash:secret@db/stash");
    const failed = await fetch(`${baseUrl}/api/auth/oidc/organization-1/callback?code=valid-code&state=${await begin()}`);
    assert.equal(failed.status, 503);
    assert.doesNotMatch(await failed.text(), /provider-secret|postgres|stash:secret/);
  });
});

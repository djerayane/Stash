import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { startInstance, type RunningInstance } from "./support/start-test-instance.js";

describe("Imported Identity administration", () => {
  let instance: RunningInstance | undefined;
  afterEach(async () => { await instance?.close(); instance = undefined; });

  it("lists and explicitly maps a visible Identity Stub through a Member boundary", async () => {
    const importId="11111111-1111-4111-8111-111111111111", sourceAccountId="22222222-2222-4222-8222-222222222222", localAccountId="33333333-3333-4333-8333-333333333333", idempotencyKey="44444444-4444-4444-8444-444444444444";
    let pending = true; let mappedInput: unknown;
    instance = await startInstance({ database: { async verifyConnection() {}, async close() {} }, host: "127.0.0.1", port: 0,
      instanceAdminToken: "instance-admin", memberAccess: { async authenticateBearer(value) { return value === "Bearer member" ? { accountId: "member", sessionId: "session" } : undefined; } },
      importedIdentityAdministration: {
        async listPendingImportedIdentities(memberId) { assert.equal(memberId, "member"); return pending ? [{ importId, workspaceId: "workspace", workspaceName: "Imported", sourceAccountId, displayName: "Grace" }] : []; },
        async mapImportedIdentityAsMember(memberId, input) { assert.equal(memberId, "member"); mappedInput = input; pending = false; return { status: "mapped" }; },
      } });
    const listed = await fetch(`${instance.url}/api/imported-identities`, { headers: { authorization: "Bearer member" } });
    assert.equal(listed.status, 200); assert.equal((await listed.json() as any).identities[0].displayName, "Grace");
    const mapped = await fetch(`${instance.url}/api/imported-identity-mappings`, { method: "POST", headers: { authorization: "Bearer member", "idempotency-key": idempotencyKey, "content-type": "application/json" },
      body: JSON.stringify({ importId, sourceAccountId, localAccountId }) });
    assert.equal(mapped.status, 201); assert.deepEqual(mappedInput, { importId, sourceAccountId, localAccountId, idempotencyKey });
    assert.deepEqual(await (await fetch(`${instance.url}/api/imported-identities`, { headers: { authorization: "Bearer member" } })).json(), { identities: [] });
  });

  it("does not expose identities or silently hide authorization and conflict failures", async () => {
    const importId="11111111-1111-4111-8111-111111111111", sourceAccountId="22222222-2222-4222-8222-222222222222", idempotencyKey="44444444-4444-4444-8444-444444444444";
    instance = await startInstance({ database: { async verifyConnection() {}, async close() {} }, host: "127.0.0.1", port: 0,
      instanceAdminToken: "instance-admin", memberAccess: { async authenticateBearer(value) { return value === "Bearer member" ? { accountId: "member", sessionId: "session" } : undefined; } },
      importedIdentityAdministration: { async listPendingImportedIdentities() { return []; }, async mapImportedIdentityAsMember(_member, input) { return { status: input.localAccountId.startsWith("5555") ? "forbidden" : "conflict" }; } } });
    assert.equal((await fetch(`${instance.url}/api/imported-identities`)).status, 401);
    for (const [localAccountId, expected] of [["55555555-5555-4555-8555-555555555555", 403], ["66666666-6666-4666-8666-666666666666", 409]] as const) {
      const mappingResponse: Response = await fetch(`${instance.url}/api/imported-identity-mappings`, { method: "POST", headers: { authorization: "Bearer member", "idempotency-key": idempotencyKey, "content-type": "application/json" },
        body: JSON.stringify({ importId, sourceAccountId, localAccountId }) }); assert.equal(mappingResponse.status, expected);
    }
  });
});

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { createDiagnostics, type DiagnosticPayload } from "../src/diagnostics.js";
import { startInstance, type DatabaseProbe, type RunningInstance } from "../src/instance.js";

class AvailableDatabase implements DatabaseProbe {
  async verifyConnection(): Promise<void> {}
  async close(): Promise<void> {}
}

describe("diagnostics on a running Stash Instance", () => {
  let instance: RunningInstance | undefined;
  const authorization = { authorization: "Bearer test-instance-admin-token" };

  afterEach(async () => {
    await instance?.close();
    instance = undefined;
  });

  async function run(submit: (payload: DiagnosticPayload) => Promise<void>) {
    const diagnostics = createDiagnostics({ instanceVersion: "0.1.0", transport: { submit } });
    instance = await startInstance({
      database: new AvailableDatabase(),
      diagnostics,
      host: "127.0.0.1",
      port: 0,
      instanceAdminToken: "test-instance-admin-token",
    });
    return instance.url;
  }

  it("publishes the content-free schema while protecting settings and pending payloads", async () => {
    const submitted: DiagnosticPayload[] = [];
    const baseUrl = await run(async (payload) => { submitted.push(payload); });

    const schema = await fetch(`${baseUrl}/api/diagnostics/schema`);
    assert.equal(schema.status, 200);
    assert.equal((await schema.json() as { id: string }).id, "stash.instance-diagnostics.v1");

    const denied = await fetch(`${baseUrl}/api/diagnostics`);
    assert.equal(denied.status, 401);

    const state = await fetch(`${baseUrl}/api/diagnostics`, { headers: authorization });
    assert.equal(state.status, 200);
    const body = await state.json() as { settings: { diagnosticSubmissions: boolean }; pending: unknown[] };
    assert.equal(body.settings.diagnosticSubmissions, false);
    assert.equal(body.pending.length, 1);

    const disabled = await fetch(`${baseUrl}/api/diagnostics/submit`, {
      method: "POST",
      headers: authorization,
    });
    assert.deepEqual(await disabled.json(), { status: "disabled", submitted: 0 });
    assert.deepEqual(submitted, []);
  });

  it("requires explicit valid choices before submitting the inspected payload", async () => {
    const submitted: DiagnosticPayload[] = [];
    const baseUrl = await run(async (payload) => { submitted.push(payload); });

    const invalid = await fetch(`${baseUrl}/api/diagnostics/settings`, {
      method: "PUT",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify({ diagnosticSubmissions: true }),
    });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json() as { error: string }).error, "invalid_settings");

    const configured = await fetch(`${baseUrl}/api/diagnostics/settings`, {
      method: "PUT",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify({
        diagnosticSubmissions: true,
        crashReportSubmissions: false,
        updateChecks: false,
      }),
    });
    assert.equal(configured.status, 200);

    const submission = await fetch(`${baseUrl}/api/diagnostics/submit`, {
      method: "POST",
      headers: authorization,
    });
    assert.deepEqual(await submission.json(), { status: "submitted", submitted: 1 });
    assert.equal(submitted.length, 1);
  });

  it("reports transport failure and retains the pending payload", async () => {
    const baseUrl = await run(async () => { throw new Error("offline"); });
    await fetch(`${baseUrl}/api/diagnostics/settings`, {
      method: "PUT",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify({
        diagnosticSubmissions: true,
        crashReportSubmissions: false,
        updateChecks: false,
      }),
    });

    const failed = await fetch(`${baseUrl}/api/diagnostics/submit`, {
      method: "POST",
      headers: authorization,
    });
    assert.equal(failed.status, 503);
    assert.deepEqual(await failed.json(), {
      status: "failed",
      submitted: 0,
      error: "transport_unavailable",
    });

    const state = await fetch(`${baseUrl}/api/diagnostics`, { headers: authorization });
    assert.equal((await state.json() as { pending: unknown[] }).pending.length, 1);
  });
});

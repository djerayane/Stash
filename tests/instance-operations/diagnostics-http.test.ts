import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  createDiagnostics,
  type DiagnosticPayload,
  type DiagnosticTransport,
} from "../../src/diagnostics.js";
import { startInstance, type DatabaseProbe, type RunningInstance } from "../support/start-test-instance.js";

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

  async function run(transport: DiagnosticTransport, crashReport = false) {
    const diagnostics = createDiagnostics({ instanceVersion: "0.1.0", transport });
    if (crashReport) {
      diagnostics.recordCrashReport({
        id: "crash-1",
        occurredAt: "2026-08-22T10:05:00.000Z",
        component: "database-probe",
        errorCode: "connection_lost",
      });
    }
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
    const baseUrl = await run({ async submit(payload) { submitted.push(payload); } });

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
    const baseUrl = await run({ async submit(payload) { submitted.push(payload); } });

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
    const baseUrl = await run({ async submit() { throw new Error("offline"); } });
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

  it("independently gates local crash reports and inspectable update checks", async () => {
    const crashSubmissions: unknown[] = [];
    const updateChecks: unknown[] = [];
    const baseUrl = await run({
      async submit() {},
      async submitCrashReport(payload) { crashSubmissions.push(payload); },
      async checkForUpdates(payload) {
        updateChecks.push(payload);
        return { latestVersion: "0.2.0" };
      },
    }, true);

    const schemas = await fetch(`${baseUrl}/api/diagnostics/schemas`);
    assert.equal(schemas.status, 200);
    assert.deepEqual(
      (await schemas.json() as { schemas: { id: string }[] }).schemas.map(({ id }) => id),
      ["stash.instance-diagnostics.v1", "stash.crash-report.v1", "stash.update-check.v1"],
    );

    const state = await fetch(`${baseUrl}/api/diagnostics`, { headers: authorization });
    const stateBody = await state.json() as {
      pendingCrashReports: { id: string }[];
      updateCheckPayload: { schema: string };
    };
    assert.equal(stateBody.pendingCrashReports[0]?.id, "crash-1");
    assert.equal(stateBody.updateCheckPayload.schema, "stash.update-check.v1");

    const download = await fetch(`${baseUrl}/api/diagnostics/crash-reports/crash-1`, {
      headers: authorization,
    });
    assert.equal(download.status, 200);
    assert.equal((await download.json() as { id: string }).id, "crash-1");

    const disabledCrash = await fetch(`${baseUrl}/api/diagnostics/crash-reports/submit`, {
      method: "POST",
      headers: authorization,
    });
    assert.deepEqual(await disabledCrash.json(), { status: "disabled", submitted: 0 });
    const disabledUpdate = await fetch(`${baseUrl}/api/diagnostics/update-check`, {
      method: "POST",
      headers: authorization,
    });
    assert.deepEqual(await disabledUpdate.json(), { status: "disabled" });
    assert.deepEqual(crashSubmissions, []);
    assert.deepEqual(updateChecks, []);

    await fetch(`${baseUrl}/api/diagnostics/settings`, {
      method: "PUT",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify({
        diagnosticSubmissions: false,
        crashReportSubmissions: true,
        updateChecks: true,
      }),
    });
    const submittedCrash = await fetch(`${baseUrl}/api/diagnostics/crash-reports/submit`, {
      method: "POST",
      headers: authorization,
    });
    assert.deepEqual(await submittedCrash.json(), { status: "submitted", submitted: 1 });
    const checked = await fetch(`${baseUrl}/api/diagnostics/update-check`, {
      method: "POST",
      headers: authorization,
    });
    assert.deepEqual(await checked.json(), { status: "available", latestVersion: "0.2.0" });
    assert.equal(crashSubmissions.length, 1);
    assert.equal(updateChecks.length, 1);
  });
});

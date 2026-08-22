import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createDiagnostics,
  type DiagnosticTransport,
} from "../src/diagnostics.js";

class RecordingTransport implements DiagnosticTransport {
  public readonly submissions: unknown[] = [];

  async submit(payload: unknown): Promise<void> {
    this.submissions.push(payload);
  }
}

describe("Instance diagnostics", () => {
  it("keeps diagnostics local by default and exposes their schema and pending payload", async () => {
    const transport = new RecordingTransport();
    const diagnostics = createDiagnostics({ transport, instanceVersion: "0.1.0" });

    diagnostics.record({ kind: "instance_started", occurredAt: "2026-08-22T10:00:00.000Z" });

    assert.deepEqual(diagnostics.settings(), {
      diagnosticSubmissions: false,
      crashReportSubmissions: false,
      updateChecks: false,
    });
    assert.deepEqual(diagnostics.schema(), {
      id: "stash.instance-diagnostics.v1",
      description: "Content-free operational diagnostics for a Stash Instance.",
      fields: {
        schema: { type: "string", constant: "stash.instance-diagnostics.v1" },
        instanceVersion: { type: "string", content: false },
        kind: { type: "string", values: ["instance_started", "instance_stopped"] },
        occurredAt: { type: "string", format: "date-time", content: false },
      },
    });
    assert.deepEqual(diagnostics.pending(), [
      {
        schema: "stash.instance-diagnostics.v1",
        instanceVersion: "0.1.0",
        kind: "instance_started",
        occurredAt: "2026-08-22T10:00:00.000Z",
      },
    ]);

    assert.deepEqual(await diagnostics.submitPending(), { status: "disabled", submitted: 0 });
    assert.deepEqual(transport.submissions, []);
  });

  it("submits only after explicit diagnostic opt-in and keeps independent choices independent", async () => {
    const transport = new RecordingTransport();
    const diagnostics = createDiagnostics({ transport, instanceVersion: "0.1.0" });
    diagnostics.record({ kind: "instance_started", occurredAt: "2026-08-22T10:00:00.000Z" });

    diagnostics.configure({
      diagnosticSubmissions: true,
      crashReportSubmissions: false,
      updateChecks: true,
    });

    assert.deepEqual(diagnostics.settings(), {
      diagnosticSubmissions: true,
      crashReportSubmissions: false,
      updateChecks: true,
    });
    assert.deepEqual(await diagnostics.submitPending(), { status: "submitted", submitted: 1 });
    assert.equal(transport.submissions.length, 1);
    assert.deepEqual(diagnostics.pending(), []);
  });

  it("keeps an unsent payload visible after a recoverable transport failure", async () => {
    const diagnostics = createDiagnostics({
      instanceVersion: "0.1.0",
      transport: { async submit() { throw new Error("offline"); } },
    });
    diagnostics.configure({
      diagnosticSubmissions: true,
      crashReportSubmissions: false,
      updateChecks: false,
    });
    diagnostics.record({ kind: "instance_stopped", occurredAt: "2026-08-22T10:05:00.000Z" });

    assert.deepEqual(await diagnostics.submitPending(), {
      status: "failed",
      submitted: 0,
      error: "transport_unavailable",
    });
    assert.equal(diagnostics.pending().length, 1);
  });
});

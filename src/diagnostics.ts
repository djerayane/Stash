export const diagnosticSchemaId = "stash.instance-diagnostics.v1" as const;

export interface DiagnosticTransport {
  submit(payload: DiagnosticPayload): Promise<void>;
  submitCrashReport?(payload: CrashReportPayload): Promise<void>;
  checkForUpdates?(payload: UpdateCheckPayload): Promise<{ latestVersion: string }>;
}

export interface DiagnosticSettings {
  diagnosticSubmissions: boolean;
  crashReportSubmissions: boolean;
  updateChecks: boolean;
}

export interface DiagnosticEvent {
  kind: "instance_started" | "instance_stopped";
  occurredAt: string;
}

export interface DiagnosticPayload extends DiagnosticEvent {
  schema: typeof diagnosticSchemaId;
  instanceVersion: string;
}

export interface CrashReportEvent {
  id: string;
  occurredAt: string;
  component: string;
  errorCode: string;
}

export interface CrashReportPayload extends CrashReportEvent {
  schema: "stash.crash-report.v1";
  instanceVersion: string;
}

export interface UpdateCheckPayload {
  schema: "stash.update-check.v1";
  instanceVersion: string;
  channel: "stable";
}

export interface Diagnostics {
  schema(): object;
  schemas(): object[];
  settings(): DiagnosticSettings;
  configure(settings: DiagnosticSettings): void;
  record(event: DiagnosticEvent): void;
  pending(): DiagnosticPayload[];
  recordCrashReport(event: CrashReportEvent): void;
  pendingCrashReports(): CrashReportPayload[];
  crashReport(id: string): CrashReportPayload | undefined;
  updateCheckPayload(): UpdateCheckPayload;
  submitPending(): Promise<
    | { status: "disabled"; submitted: 0 }
    | { status: "submitted"; submitted: number }
    | { status: "failed"; submitted: number; error: "transport_unavailable" }
  >;
  submitPendingCrashReports(): Promise<
    | { status: "disabled"; submitted: 0 }
    | { status: "submitted"; submitted: number }
    | { status: "failed"; submitted: number; error: "transport_unavailable" }
  >;
  checkForUpdates(): Promise<
    | { status: "disabled" }
    | { status: "available"; latestVersion: string }
    | { status: "failed"; error: "transport_unavailable" }
  >;
}

const publishedSchema = Object.freeze({
  id: diagnosticSchemaId,
  description: "Content-free operational diagnostics for a Stash Instance.",
  fields: {
    schema: { type: "string", constant: diagnosticSchemaId },
    instanceVersion: { type: "string", content: false },
    kind: { type: "string", values: ["instance_started", "instance_stopped"] },
    occurredAt: { type: "string", format: "date-time", content: false },
  },
});

const crashReportSchema = Object.freeze({
  id: "stash.crash-report.v1",
  description: "Content-free local crash metadata for a Stash Instance.",
  fields: {
    schema: { type: "string", constant: "stash.crash-report.v1" },
    instanceVersion: { type: "string", content: false },
    id: { type: "string", content: false },
    occurredAt: { type: "string", format: "date-time", content: false },
    component: { type: "string", content: false },
    errorCode: { type: "string", content: false },
  },
});

const updateCheckSchema = Object.freeze({
  id: "stash.update-check.v1",
  description: "Content-free request used to check for Stash updates.",
  fields: {
    schema: { type: "string", constant: "stash.update-check.v1" },
    instanceVersion: { type: "string", content: false },
    channel: { type: "string", constant: "stable", content: false },
  },
});

export function createDiagnostics(options: {
  transport: DiagnosticTransport;
  instanceVersion: string;
}): Diagnostics {
  let currentSettings: DiagnosticSettings = {
    diagnosticSubmissions: false,
    crashReportSubmissions: false,
    updateChecks: false,
  };
  const queue: DiagnosticPayload[] = [];
  const crashReports: CrashReportPayload[] = [];
  const updateCheckPayload: UpdateCheckPayload = {
    schema: "stash.update-check.v1",
    instanceVersion: options.instanceVersion,
    channel: "stable",
  };

  return {
    schema: () => publishedSchema,
    schemas: () => [publishedSchema, crashReportSchema, updateCheckSchema],
    settings: () => ({ ...currentSettings }),
    configure(settings) {
      currentSettings = { ...settings };
    },
    record(event) {
      queue.push({
        schema: diagnosticSchemaId,
        instanceVersion: options.instanceVersion,
        ...event,
      });
    },
    pending: () => queue.map((payload) => ({ ...payload })),
    recordCrashReport(event) {
      crashReports.push({
        schema: "stash.crash-report.v1",
        instanceVersion: options.instanceVersion,
        ...event,
      });
    },
    pendingCrashReports: () => crashReports.map((payload) => ({ ...payload })),
    crashReport: (id) => {
      const report = crashReports.find((candidate) => candidate.id === id);
      return report ? { ...report } : undefined;
    },
    updateCheckPayload: () => ({ ...updateCheckPayload }),
    async submitPending() {
      if (!currentSettings.diagnosticSubmissions) {
        return { status: "disabled", submitted: 0 };
      }

      let submitted = 0;
      try {
        while (queue.length > 0) {
          await options.transport.submit(queue[0]!);
          queue.shift();
          submitted += 1;
        }
        return { status: "submitted", submitted };
      } catch {
        return { status: "failed", submitted, error: "transport_unavailable" };
      }
    },
    async submitPendingCrashReports() {
      if (!currentSettings.crashReportSubmissions) {
        return { status: "disabled", submitted: 0 };
      }
      if (!options.transport.submitCrashReport) {
        return { status: "failed", submitted: 0, error: "transport_unavailable" };
      }
      let submitted = 0;
      try {
        while (crashReports.length > 0) {
          await options.transport.submitCrashReport(crashReports[0]!);
          crashReports.shift();
          submitted += 1;
        }
        return { status: "submitted", submitted };
      } catch {
        return { status: "failed", submitted, error: "transport_unavailable" };
      }
    },
    async checkForUpdates() {
      if (!currentSettings.updateChecks) return { status: "disabled" };
      if (!options.transport.checkForUpdates) {
        return { status: "failed", error: "transport_unavailable" };
      }
      try {
        const result = await options.transport.checkForUpdates(updateCheckPayload);
        return { status: "available", latestVersion: result.latestVersion };
      } catch {
        return { status: "failed", error: "transport_unavailable" };
      }
    },
  };
}

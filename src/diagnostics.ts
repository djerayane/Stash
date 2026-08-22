export const diagnosticSchemaId = "stash.instance-diagnostics.v1" as const;

export interface DiagnosticTransport {
  submit(payload: DiagnosticPayload): Promise<void>;
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

export interface Diagnostics {
  schema(): object;
  settings(): DiagnosticSettings;
  configure(settings: DiagnosticSettings): void;
  record(event: DiagnosticEvent): void;
  pending(): DiagnosticPayload[];
  submitPending(): Promise<
    | { status: "disabled"; submitted: 0 }
    | { status: "submitted"; submitted: number }
    | { status: "failed"; submitted: number; error: "transport_unavailable" }
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

  return {
    schema: () => publishedSchema,
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
  };
}

import type { DiagnosticSettings, Diagnostics } from "./diagnostics.js";
import { json, readJson, type HttpRoute } from "./http-routing.js";

export function diagnosticsSchemaRoute(diagnostics: Diagnostics): HttpRoute {
  return {
    matches: (request, url) =>
      request.method === "GET"
      && (url.pathname === "/api/diagnostics/schemas" || url.pathname === "/api/diagnostics/schema"),
    handle(_request, response, url) {
      json(
        response,
        200,
        url.pathname.endsWith("/schemas") ? { schemas: diagnostics.schemas() } : diagnostics.schema(),
      );
      return true;
    },
  };
}

export function diagnosticsAdminRoute(diagnostics: Diagnostics): HttpRoute {
  return {
    matches: (_request, url) => url.pathname.startsWith("/api/diagnostics"),
    async handle(request, response, url) {
      if (request.method === "GET" && url.pathname === "/api/diagnostics") {
        json(response, 200, {
          settings: diagnostics.settings(),
          pending: diagnostics.pending(),
          pendingCrashReports: diagnostics.pendingCrashReports(),
          updateCheckPayload: diagnostics.updateCheckPayload(),
        });
        return true;
      }

      const crashReportMatch = url.pathname.match(/^\/api\/diagnostics\/crash-reports\/([^/]+)$/);
      if (request.method === "GET" && crashReportMatch) {
        const report = diagnostics.crashReport(decodeURIComponent(crashReportMatch[1]!));
        if (!report) {
          json(response, 404, { error: "crash_report_not_found" });
          return true;
        }
        json(response, 200, report);
        return true;
      }

      if (request.method === "PUT" && url.pathname === "/api/diagnostics/settings") {
        try {
          const body = await readJson(request);
          if (!isDiagnosticSettings(body)) throw new Error("invalid_settings");
          diagnostics.configure(body);
          json(response, 200, { settings: diagnostics.settings() });
        } catch (error) {
          const tooLarge = error instanceof Error && error.message === "body_too_large";
          json(response, tooLarge ? 413 : 400, {
            error: tooLarge ? "body_too_large" : "invalid_settings",
            message: tooLarge
              ? "Request body exceeds the 64 KiB limit."
              : "Diagnostic settings must contain three boolean choices.",
          });
        }
        return true;
      }

      if (request.method === "POST" && url.pathname === "/api/diagnostics/submit") {
        const result = await diagnostics.submitPending();
        json(response, result.status === "failed" ? 503 : 200, result);
        return true;
      }

      if (request.method === "POST" && url.pathname === "/api/diagnostics/crash-reports/submit") {
        const result = await diagnostics.submitPendingCrashReports();
        json(response, result.status === "failed" ? 503 : 200, result);
        return true;
      }

      if (request.method === "POST" && url.pathname === "/api/diagnostics/update-check") {
        const result = await diagnostics.checkForUpdates();
        json(response, result.status === "failed" ? 503 : 200, result);
        return true;
      }

      return false;
    },
  };
}

function isDiagnosticSettings(value: unknown): value is DiagnosticSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const settings = value as Record<string, unknown>;
  return Object.keys(settings).length === 3
    && typeof settings.diagnosticSubmissions === "boolean"
    && typeof settings.crashReportSubmissions === "boolean"
    && typeof settings.updateChecks === "boolean";
}

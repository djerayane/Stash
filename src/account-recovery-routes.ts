import { json, readJson, type HttpRoute } from "./http-routing.js";
import { EmailRecoveryUnavailable, InvalidRecoveryInput, RecoveryCredentialsRejected, type AccountRecoveryService } from "./account-recovery.js";

export function accountRecoveryRoute(service: AccountRecoveryService): HttpRoute {
  const paths = new Set(["/api/auth/passkeys/options", "/api/auth/passkeys", "/api/auth/passkey-sessions/options", "/api/auth/passkey-sessions", "/api/auth/recovery-codes", "/api/auth/recovery-code-sessions", "/api/auth/email-recovery", "/api/auth/email-recovery-sessions"]);
  return { matches: (_request, url) => paths.has(url.pathname), async handle(request, response, url) {
    try {
      const body = async () => readJson(request);
      if (request.method === "POST" && url.pathname === "/api/auth/passkey-sessions/options") { json(response, 200, await service.authenticationOptions(await body())); return true; }
      if (request.method === "POST" && url.pathname === "/api/auth/passkey-sessions") { json(response, 201, await service.signInWithPasskey(await body(), request.headers["user-agent"])); return true; }
      if (request.method === "POST" && url.pathname === "/api/auth/recovery-code-sessions") { json(response, 201, await service.signInWithRecoveryCode(await body(), request.headers["user-agent"])); return true; }
      if (request.method === "POST" && url.pathname === "/api/auth/email-recovery") { await service.requestEmailRecovery(await body()); json(response, 202, { status: "accepted" }); return true; }
      if (request.method === "POST" && url.pathname === "/api/auth/email-recovery-sessions") { json(response, 201, await service.signInWithEmailRecovery(await body(), request.headers["user-agent"])); return true; }
      const member = await service.authenticateMember(request.headers.authorization);
      if (!member) { json(response, 401, { error: "unauthorized", message: "A valid Member session is required." }); return true; }
      if (request.method === "POST" && url.pathname === "/api/auth/passkeys/options") { json(response, 200, await service.registrationOptions(member)); return true; }
      if (request.method === "POST" && url.pathname === "/api/auth/passkeys") { json(response, 201, await service.registerPasskey(member, await body())); return true; }
      if (request.method === "POST" && url.pathname === "/api/auth/recovery-codes") { json(response, 201, { codes: await service.generateRecoveryCodes(member) }); return true; }
      return false;
    } catch (error) {
      if (error instanceof InvalidRecoveryInput || error instanceof SyntaxError) json(response, 422, { error: "invalid_input", message: "The submitted recovery input is invalid." });
      else if (error instanceof RecoveryCredentialsRejected) json(response, 401, { error: "invalid_recovery_credentials", message: "The recovery credentials are invalid or expired." });
      else if (error instanceof EmailRecoveryUnavailable) json(response, 503, { error: "email_recovery_unavailable", message: "Email recovery is not configured for this Instance." });
      else json(response, 503, { error: "account_recovery_unavailable", message: "Account recovery is temporarily unavailable. Try again." });
      return true;
    }
  } };
}

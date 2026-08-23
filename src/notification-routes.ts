import { InvalidNotificationInput, type NotificationService } from "./notifications.js";
import { json, readJson, type HttpRoute } from "./http-routing.js";
import type { MemberAccessResolver } from "./workspaces-projects.js";

export function notificationRoutes(service: NotificationService, memberAccess: MemberAccessResolver): HttpRoute {
  return {
    matches: (request, url) => request.method === "GET" && (url.pathname === "/api/notifications" || url.pathname === "/api/notifications/digest")
      || request.method === "POST" && /^\/api\/notifications\/[^/]+\/read$/.test(url.pathname)
      || request.method === "POST" && /^\/api\/projects\/[^/]+\/(discussion-mentions|review-requests|automation-failures|followed-changes)$/.test(url.pathname)
      || ["GET", "PUT"].includes(request.method ?? "") && /^\/api\/projects\/[^/]+\/notification-settings$/.test(url.pathname),
    async handle(request, response, url) {
      const access = await memberAccess.authenticateBearer(request.headers.authorization);
      if (!access) { json(response, 401, { error: "unauthorized", message: "A valid Member session is required." }); return true; }
      try {
        const parts = url.pathname.split("/");
        if (request.method === "POST" && parts[2] === "projects" && parts.length === 5) {
          const projectId = decodeURIComponent(parts[3]!);
          const value = await readJson(request) as Record<string, unknown>;
          const source = parts[4];
          const trigger = source === "discussion-mentions" ? "direct_mention" : source === "review-requests" ? "requested_review"
            : source === "automation-failures" ? "automation_failure" : "followed_change";
          const allowed = trigger === "direct_mention" ? ["memberId", "discussionId"]
            : trigger === "requested_review" ? ["reviewerId", "taskId"]
            : trigger === "automation_failure" ? ["memberId", "taskId", "automationId"] : ["memberId", "taskId", "followed"];
          if (!value || typeof value !== "object" || !Object.keys(value).every((key) => allowed.includes(key)) || Object.keys(value).length !== allowed.length)
            throw new InvalidNotificationInput();
          const memberId = (trigger === "requested_review" ? value.reviewerId : value.memberId) as string;
          const object = trigger === "direct_mention" ? { kind: "Discussion" as const, id: value.discussionId as string }
            : { kind: "Task" as const, id: value.taskId as string };
          const summary = trigger === "direct_mention" ? "You were mentioned in a Discussion" : trigger === "requested_review" ? "Your review was requested"
            : trigger === "automation_failure" ? "An Automation failed" : "A followed Task changed";
          const result = await service.recordSource(access.accountId, { projectId, trigger, memberId, object, summary,
            ...(trigger === "followed_change" ? { followed: value.followed as boolean } : {}),
            ...(trigger === "automation_failure" ? { automationId: value.automationId as string } : {}) });
          if (result.status === "created") json(response, 201, { notification: result.notification });
          else json(response, 404, { error: "notification_source_not_found", message: "The Project, source, or recipient is unavailable." });
          return true;
        }
        if (url.pathname === "/api/notifications") {
          const unread = url.searchParams.get("unread");
          if (unread !== null && unread !== "true" && unread !== "false") throw new InvalidNotificationInput();
          json(response, 200, { notifications: await service.list(access.accountId, unread === "true") }); return true;
        }
        if (url.pathname === "/api/notifications/digest") { json(response, 200, { notifications: await service.digest(access.accountId) }); return true; }
        if (url.pathname.startsWith("/api/notifications/")) {
          const notification = await service.markRead(access.accountId, decodeURIComponent(parts[3]!));
          if (notification) json(response, 200, { notification });
          else json(response, 404, { error: "notification_not_found", message: "This notification is unavailable." });
          return true;
        }
        const projectId = decodeURIComponent(parts[3]!);
        if (request.method === "GET") {
          const result = await service.getPreferences(access.accountId, projectId);
          if (result.status === "found") json(response, 200, { settings: result.preferences });
          else json(response, 404, { error: "project_not_found", message: "This Project notification configuration is unavailable." });
        } else {
          const result = await service.setPreferences(access.accountId, projectId, await readJson(request));
          if (result.status === "saved") json(response, 200, { settings: result.preferences });
          else json(response, 404, { error: "project_not_found", message: "This Project notification configuration is unavailable." });
        }
      } catch (error) {
        if (error instanceof InvalidNotificationInput) json(response, 422, { error: "invalid_input", message: "Valid notification filters or Project settings are required." });
        else if (error instanceof SyntaxError || (error instanceof Error && error.message === "body_too_large")) json(response, 400, { error: "invalid_json", message: "Request body must be valid JSON." });
        else json(response, 503, { error: "notifications_unavailable", message: "Notifications are temporarily unavailable. Try again." });
      }
      return true;
    },
  };
}

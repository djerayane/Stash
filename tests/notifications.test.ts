import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { startInstance, type DatabaseProbe } from "../src/instance.js";
import {
  NotificationService,
  type NotificationDelivery,
  type NotificationPreferences,
  type NotificationRepository,
  type NotificationTrigger,
} from "../src/notifications.js";
import type { ActivityRecord } from "../src/activity.js";
import type { MemberAccessResolver } from "../src/workspaces-projects.js";

const memberId = "11111111-1111-4111-8111-111111111111";
const otherMemberId = "22222222-2222-4222-8222-222222222222";
const workspaceId = "33333333-3333-4333-8333-333333333333";
const projectId = "44444444-4444-4444-8444-444444444444";
const otherProjectId = "55555555-5555-4555-8555-555555555555";
const activity: ActivityRecord = {
  schema: "stash.activity.v1", id: "66666666-6666-4666-8666-666666666666", workspaceId,
  object: { kind: "Task", id: "77777777-7777-4777-8777-777777777777" }, action: "task_assigned",
  actor: { localAccountId: otherMemberId, displayName: "Grace Hopper" }, cause: { kind: "member" },
  occurredAt: "2026-08-23T12:00:00.000Z", before: { assigneeIds: [] }, after: { assigneeIds: [memberId] },
};

class NotificationFake implements DatabaseProbe, NotificationRepository {
  readonly deliveries: NotificationDelivery[] = [];
  readonly preferences = new Map<string, NotificationPreferences>();
  readonly visibleProjects = new Set([`${memberId}:${projectId}`]);
  fail = false;
  async verifyConnection() {} async close() {}
  async saveNotification(delivery: NotificationDelivery) { if (this.fail) throw new Error("offline"); this.deliveries.push(structuredClone(delivery)); return delivery; }
  async listNotifications(requestedMemberId: string) { if (this.fail) throw new Error("offline"); return this.deliveries.filter(({ memberId }) => memberId === requestedMemberId && this.visibleProjects.has(`${requestedMemberId}:${projectId}`)); }
  async markNotificationRead(requestedMemberId: string, id: string, readAt: string) {
    const item = this.deliveries.find((entry) => entry.id === id && entry.memberId === requestedMemberId);
    if (!item || !this.visibleProjects.has(`${requestedMemberId}:${projectId}`)) return undefined;
    Object.assign(item, { readAt }); return structuredClone(item);
  }
  async getNotificationPreferences(requestedMemberId: string, requestedProjectId: string) {
    if (!this.visibleProjects.has(`${requestedMemberId}:${requestedProjectId}`)) return undefined;
    return this.preferences.get(`${requestedMemberId}:${requestedProjectId}`) ?? { activity: "followed", digest: "off" };
  }
  async saveNotificationPreferences(requestedMemberId: string, requestedProjectId: string, value: NotificationPreferences) {
    if (!this.visibleProjects.has(`${requestedMemberId}:${requestedProjectId}`)) return undefined;
    this.preferences.set(`${requestedMemberId}:${requestedProjectId}`, structuredClone(value)); return value;
  }
}

const access: MemberAccessResolver = { async authenticateBearer(value) {
  return value === "Bearer member-token" ? { accountId: memberId, sessionId: "member-session" }
    : value === "Bearer other-token" ? { accountId: otherMemberId, sessionId: "other-session" } : undefined;
} };

describe("Member notifications", () => {
  const database = new NotificationFake();
  const service = new NotificationService(database, () => new Date("2026-08-23T12:30:00.000Z"));
  let server: Awaited<ReturnType<typeof startInstance>>; let baseUrl: string;
  before(async () => { server = await startInstance({ database, host: "127.0.0.1", port: 0, instanceAdminToken: "admin", memberAccess: access, notifications: service }); baseUrl = server.url; });
  after(async () => server.close());
  const request = (path: string, method = "GET", body?: unknown, token = "member-token") => fetch(`${baseUrl}${path}`, {
    method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}),
  });

  it("delivers only relevant Activity and suppresses self-authored or disabled changes", async () => {
    const triggers: NotificationTrigger[] = ["direct_mention", "assignment", "requested_review", "automation_failure", "followed_change"];
    for (const [index, trigger] of triggers.entries()) await service.notify({ activity: { ...activity, id: `66666666-6666-4666-8666-66666666666${index}` }, projectId, memberId, trigger, summary: trigger });
    await service.notify({ activity, projectId, memberId: otherMemberId, trigger: "direct_mention", summary: "self mention" });
    await service.setPreferences(memberId, projectId, { activity: "muted", digest: "daily", quietHours: { start: "22:00", end: "07:00", timeZone: "Europe/Paris" } });
    assert.equal((await service.notify({ activity: { ...activity, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }, projectId, memberId, trigger: "followed_change", summary: "noise" })).status, "suppressed");
    assert.equal((await service.notify({ activity: { ...activity, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }, projectId, memberId, trigger: "assignment", summary: "still relevant" })).status, "created");
    assert.equal(database.deliveries.length, 6);
    const quietService = new NotificationService(database, () => new Date("2026-08-23T22:30:00.000Z"));
    const deferred = await quietService.notify({ activity: { ...activity, id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }, projectId, memberId, trigger: "assignment", summary: "quiet assignment" });
    assert.equal(deferred.status === "created" && deferred.notification.delivery, "quiet_hours");
  });

  it("exposes a permission-filtered inbox, digest, and read state through both API prefixes", async () => {
    const inbox = await request("/api/notifications?unread=true");
    assert.equal(inbox.status, 200); const listed = await inbox.json() as { notifications: NotificationDelivery[] };
    assert.equal(listed.notifications.length, 7); assert.ok(listed.notifications.every(({ activity: item }) => item.before !== undefined && item.after !== undefined));
    const digest = await request("/api/v1/notifications/digest");
    assert.equal(digest.status, 200); assert.equal((await digest.json() as { notifications: NotificationDelivery[] }).notifications.length, 7);
    const read = await request(`/api/v1/notifications/${listed.notifications[0]!.id}/read`, "POST", {});
    assert.equal(read.status, 200); assert.equal((await read.json() as { notification: NotificationDelivery }).notification.readAt, "2026-08-23T12:30:00.000Z");
    assert.equal((await request(`/api/notifications/${listed.notifications[0]!.id}/read`, "POST", {}, "other-token")).status, 404);
    database.visibleProjects.clear();
    assert.deepEqual((await (await request("/api/notifications")).json() as { notifications: unknown[] }).notifications, []);
    database.visibleProjects.add(`${memberId}:${projectId}`);
  });

  it("validates and persists per-Project activity, digest, and quiet-hour controls", async () => {
    const settings = { activity: "followed" as const, digest: "weekly" as const, quietHours: { start: "21:30", end: "06:15", timeZone: "Europe/Paris" } };
    assert.equal((await request(`/api/projects/${projectId}/notification-settings`, "PUT", settings)).status, 200);
    assert.deepEqual((await (await request(`/api/v1/projects/${projectId}/notification-settings`)).json() as { settings: NotificationPreferences }).settings, settings);
    assert.equal((await request(`/api/projects/${projectId}/notification-settings`, "PUT", { ...settings, quietHours: { ...settings.quietHours, start: "25:00" } })).status, 422);
    assert.equal((await request(`/api/projects/${otherProjectId}/notification-settings`)).status, 404);
  });

  it("surfaces recoverable repository failures without silently losing state", async () => {
    database.fail = true;
    const response = await request("/api/notifications");
    assert.equal(response.status, 503); assert.equal((await response.json() as { error: string }).error, "notifications_unavailable");
    database.fail = false;
  });
});

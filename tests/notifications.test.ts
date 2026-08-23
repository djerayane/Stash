import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { startInstance, type DatabaseProbe } from "../src/instance.js";
import {
  assignmentNotificationInputs,
  NotificationService,
  type NotificationDelivery,
  type NotificationPreferences,
  type NotificationRepository,
  type NotificationTrigger,
} from "../src/notifications.js";
import { TaskService, type TaskPlanningReadModel, type TaskPlanningRepository, type TaskPlanningUpdate } from "../src/tasks.js";
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

class NotificationFake implements DatabaseProbe, NotificationRepository, TaskPlanningRepository {
  readonly deliveries: NotificationDelivery[] = [];
  readonly preferences = new Map<string, NotificationPreferences>();
  readonly visibleProjects = new Set([`${memberId}:${projectId}`]);
  fail = false;
  task: TaskPlanningReadModel = { schema: "stash.task.v1", id: "77777777-7777-4777-8777-777777777777", workspaceId, projectId,
    key: "STASH-33", title: "Review notification delivery", status: { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", name: "Ready", category: "unstarted" },
    assigneeIds: [], priority: "none", labelNames: [], sourceNoteIds: [], linkedNoteIds: [], dependencies: [], developmentLinks: [],
    createdAt: "2026-08-23T11:00:00.000Z", createdBy: { localAccountId: otherMemberId, displayName: "Grace Hopper" }, revision: 1,
    dependencyWarnings: [] };
  async verifyConnection() {} async close() {}
  async saveNotification(delivery: NotificationDelivery) {
    if (this.fail) throw new Error("offline");
    const existing = this.deliveries.find((entry) => entry.memberId === delivery.memberId
      && entry.activity.id === delivery.activity.id && entry.trigger === delivery.trigger);
    if (existing) return structuredClone(existing);
    this.deliveries.push(structuredClone(delivery)); return delivery;
  }
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
  async claimDigestNotifications(requestedMemberId: string, cadence: "daily" | "weekly", since: string, until: string, claimedAt: string) {
    const claimed = this.deliveries.filter((entry) => entry.memberId === requestedMemberId && !entry.readAt && !entry.digestedAt
      && entry.createdAt >= since && entry.createdAt <= until
      && this.visibleProjects.has(`${requestedMemberId}:${entry.projectId}`)
      && this.preferences.get(`${requestedMemberId}:${entry.projectId}`)?.digest === cadence);
    claimed.forEach((entry) => { entry.digestedAt = claimedAt; }); return structuredClone(claimed);
  }
  async findTaskByKey(requestedMemberId: string, requestedProjectId: string, key: string) {
    return [memberId, otherMemberId].includes(requestedMemberId) && requestedProjectId === projectId && key === this.task.key
      ? { status: "found" as const, task: structuredClone(this.task) } : { status: "not_found" as const };
  }
  async updateTaskByKey(requestedMemberId: string, requestedProjectId: string, key: string, update: TaskPlanningUpdate) {
    const found = await this.findTaskByKey(requestedMemberId, requestedProjectId, key);
    if (found.status === "not_found") return found;
    const before = structuredClone(this.task);
    this.task = { ...this.task, ...(update.assigneeIds ? { assigneeIds: update.assigneeIds } : {}), revision: this.task.revision + 1 };
    const producedActivity: ActivityRecord = { schema: "stash.activity.v1", id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", workspaceId,
      object: { kind: "Task", id: this.task.id }, action: "task_planning_updated",
      actor: { localAccountId: requestedMemberId, displayName: "Grace Hopper" }, cause: { kind: "member" },
      occurredAt: "2026-08-23T12:00:00.000Z", before: { ...before }, after: { ...structuredClone(this.task) } };
    for (const input of assignmentNotificationInputs(producedActivity, requestedProjectId, before, this.task)) {
      const preferences = await this.getNotificationPreferences(input.memberId, input.projectId) ?? { activity: "followed" as const, digest: "off" as const };
      const delivery: NotificationDelivery = { schema: "stash.notification.v1", id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        ...input, workspaceId, createdAt: producedActivity.occurredAt,
        delivery: preferences.quietHours ? "quiet_hours" : "immediate" };
      await this.saveNotification(delivery);
    }
    return { status: "updated" as const, task: structuredClone(this.task) };
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
    for (const [index, trigger] of triggers.entries()) await service.notify({ activity: { ...activity, id: `66666666-6666-4666-8666-66666666666${index}` }, projectId, memberId, trigger, summary: trigger, followed: true });
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
    assert.equal(digest.status, 200); assert.equal((await digest.json() as { notifications: NotificationDelivery[] }).notifications.length, 6,
      "digest excludes entries timestamped after the delivery window");
    assert.deepEqual((await (await request("/api/v1/notifications/digest")).json() as { notifications: NotificationDelivery[] }).notifications, [],
      "a cadence window must be claimed only once");
    const read = await request(`/api/v1/notifications/${listed.notifications[0]!.id}/read`, "POST", {});
    assert.equal(read.status, 200); assert.equal((await read.json() as { notification: NotificationDelivery }).notification.readAt, "2026-08-23T12:30:00.000Z");
    assert.equal((await request(`/api/notifications/${listed.notifications[0]!.id}/read`, "POST", {}, "other-token")).status, 404);
    database.visibleProjects.clear();
    assert.deepEqual((await (await request("/api/notifications")).json() as { notifications: unknown[] }).notifications, []);
    database.visibleProjects.add(`${memberId}:${projectId}`);
  });

  it("accepts notification events only from trusted domain adapters and honors all/followed/muted", async () => {
    database.deliveries.length = 0; database.preferences.clear();
    const forged = await request(`/api/projects/${projectId}/notification-events`, "POST", {
      memberId, trigger: "direct_mention", summary: "forged",
      activity: { ...activity, actor: { localAccountId: memberId, displayName: "Ada Lovelace" } },
    });
    assert.equal(forged.status, 404, "a Member cannot submit even a same-actor fabricated Activity");
    assert.equal(database.deliveries.length, 0);

    const event = (trigger: NotificationTrigger, id: string, followed?: boolean) => service.notify({
      activity: { ...activity, id }, projectId, memberId, trigger, summary: trigger,
      ...(followed === undefined ? {} : { followed }),
    });
    for (const [index, trigger] of (["direct_mention", "requested_review", "automation_failure"] as NotificationTrigger[]).entries())
      assert.equal((await event(trigger, `10000000-0000-4000-8000-00000000000${index}`)).status, "created");

    await service.setPreferences(memberId, projectId, { activity: "followed", digest: "off" });
    assert.equal((await event("followed_change", "20000000-0000-4000-8000-000000000001", false)).status, "suppressed");
    assert.equal((await event("followed_change", "20000000-0000-4000-8000-000000000002", true)).status, "created");
    await service.setPreferences(memberId, projectId, { activity: "all", digest: "off" });
    assert.equal((await event("followed_change", "20000000-0000-4000-8000-000000000003", false)).status, "created");
    await service.setPreferences(memberId, projectId, { activity: "muted", digest: "off" });
    assert.equal((await event("followed_change", "20000000-0000-4000-8000-000000000004", true)).status, "suppressed");
    assert.equal(database.deliveries.length, 5);
  });

  it("uses distinct daily and weekly windows and does not redeliver a claimed digest", async () => {
    database.deliveries.length = 0; database.preferences.clear();
    await service.setPreferences(memberId, projectId, { activity: "all", digest: "daily" });
    await service.notify({ activity: { ...activity, id: "30000000-0000-4000-8000-000000000001" }, projectId, memberId, trigger: "assignment", summary: "today" });
    const older = { ...database.deliveries[0]!, id: "30000000-0000-4000-8000-000000000002",
      activity: { ...activity, id: "30000000-0000-4000-8000-000000000002" }, createdAt: "2026-08-22T12:00:00.000Z" };
    delete older.digestedAt; database.deliveries.push(older);
    assert.equal((await service.digest(memberId)).length, 1, "daily includes only the current UTC day");
    assert.equal((await service.digest(memberId)).length, 0);
    database.deliveries.forEach((entry) => { delete entry.digestedAt; });
    await service.setPreferences(memberId, projectId, { activity: "all", digest: "weekly" });
    assert.equal((await service.digest(memberId)).length, 2, "weekly includes entries since Monday");
  });

  it("keeps the first trusted notification immutable when delivery is retried", async () => {
    database.deliveries.length = 0; database.preferences.clear();
    const first = await service.notify({ activity, projectId, memberId, trigger: "direct_mention", summary: "Canonical mention" });
    const retry = await service.notify({ activity, projectId, memberId, trigger: "direct_mention", summary: "Changed retry" });
    assert.equal(first.status, "created"); assert.equal(retry.status, "created");
    assert.equal(database.deliveries.length, 1);
    assert.equal(retry.status === "created" && retry.notification.summary, "Canonical mention");
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

  it("creates an assignment notification through the real Task boundary without manually notifying", async () => {
    database.deliveries.length = 0;
    database.task.assigneeIds = [];
    const assignmentServer = await startInstance({ database, host: "127.0.0.1", port: 0, instanceAdminToken: "admin",
      memberAccess: access, notifications: service, tasks: new TaskService(database, { async findPortableMemberIdentity() { return undefined; } }) });
    try {
      const assigned = await fetch(`${assignmentServer.url}/api/projects/${projectId}/tasks/${database.task.key}`, { method: "PATCH",
        headers: { authorization: "Bearer other-token", "content-type": "application/json" }, body: JSON.stringify({ assigneeIds: [memberId] }) });
      assert.equal(assigned.status, 200);
      const inbox = await fetch(`${assignmentServer.url}/api/notifications`, { headers: { authorization: "Bearer member-token" } });
      assert.equal(inbox.status, 200);
      const body = await inbox.json() as { notifications: NotificationDelivery[] };
      assert.equal(body.notifications.length, 1);
      assert.equal(body.notifications[0]?.trigger, "assignment");
      assert.equal(body.notifications[0]?.activity.object.id, database.task.id);
      const repeated = await fetch(`${assignmentServer.url}/api/projects/${projectId}/tasks/${database.task.key}`, { method: "PATCH",
        headers: { authorization: "Bearer other-token", "content-type": "application/json" }, body: JSON.stringify({ assigneeIds: [memberId] }) });
      assert.equal(repeated.status, 200);
      assert.equal(database.deliveries.length, 1, "repeating an unchanged assignment must not create noise");
      await fetch(`${assignmentServer.url}/api/projects/${projectId}/tasks/${database.task.key}`, { method: "PATCH",
        headers: { authorization: "Bearer other-token", "content-type": "application/json" }, body: JSON.stringify({ assigneeIds: [] }) });
      await fetch(`${assignmentServer.url}/api/projects/${projectId}/tasks/${database.task.key}`, { method: "PATCH",
        headers: { authorization: "Bearer member-token", "content-type": "application/json" }, body: JSON.stringify({ assigneeIds: [memberId] }) });
      assert.equal(database.deliveries.length, 1, "self-assignment must be suppressed");
    } finally { await assignmentServer.close(); }
  });

  it("does not expose stand-alone commands that can forge notification source events", async () => {
    database.deliveries.length = 0; database.preferences.clear();
    const objectId = "77777777-7777-4777-8777-777777777777";
    const sources = [
      ["discussion-mentions", { memberId, discussionId: objectId }],
      ["review-requests", { reviewerId: memberId, taskId: objectId }],
      ["automation-failures", { memberId, taskId: objectId, automationId: "88888888-8888-4888-8888-888888888888" }],
      ["followed-changes", { memberId, taskId: objectId, followed: true }],
    ] as const;
    for (const [source, body] of sources) {
      const response = await request(`/api/v1/projects/${projectId}/${source}`, "POST", body, "other-token");
      assert.equal(response.status, 404, source);
    }
    const inbox = await request("/api/v1/notifications");
    assert.equal(inbox.status, 200);
    assert.deepEqual((await inbox.json() as { notifications: NotificationDelivery[] }).notifications, []);
    const forgedActivity = await request(`/api/projects/${projectId}/discussion-mentions`, "POST", {
      memberId, discussionId: objectId, activity,
    }, "other-token");
    assert.equal(forgedActivity.status, 404, "source adapters must remain unreachable from the public Member API");
  });
});

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { startInstance, type DatabaseProbe } from "../src/instance.js";
import {
  assignmentNotificationInputs,
  directMentionMemberIds,
  directMentionNotificationInputs,
  NotificationService,
  type NotificationDelivery,
  type NotificationPreferences,
  type NotificationRepository,
  type NotificationTrigger,
} from "../src/notifications.js";
import { TaskService, type TaskPlanningReadModel, type TaskPlanningRepository, type TaskPlanningUpdate } from "../src/tasks.js";
import { DiscussionService, type DiscussionDraft, type DiscussionMessage, type DiscussionRecord, type DiscussionRepository } from "../src/discussions.js";
import type { ActivityRecord } from "../src/activity.js";
import type { MemberAccessResolver } from "../src/workspaces-projects.js";

const memberId = "11111111-1111-4111-8111-111111111111";
const otherMemberId = "22222222-2222-4222-8222-222222222222";
const inaccessibleMemberId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const workspaceId = "33333333-3333-4333-8333-333333333333";
const projectId = "44444444-4444-4444-8444-444444444444";
const otherProjectId = "55555555-5555-4555-8555-555555555555";
const activity: ActivityRecord = {
  schema: "stash.activity.v1", id: "66666666-6666-4666-8666-666666666666", workspaceId,
  object: { kind: "Task", id: "77777777-7777-4777-8777-777777777777" }, action: "task_assigned",
  actor: { localAccountId: otherMemberId, displayName: "Grace Hopper" }, cause: { kind: "member" },
  occurredAt: "2026-08-23T12:00:00.000Z", before: { assigneeIds: [] }, after: { assigneeIds: [memberId] },
};

class NotificationFake implements DatabaseProbe, NotificationRepository, TaskPlanningRepository, DiscussionRepository {
  readonly deliveries: NotificationDelivery[] = [];
  readonly preferences = new Map<string, NotificationPreferences>();
  readonly follows = new Set<string>();
  readonly visibleProjects = new Set([`${memberId}:${projectId}`]);
  fail = false;
  task: TaskPlanningReadModel = { schema: "stash.task.v1", id: "77777777-7777-4777-8777-777777777777", workspaceId, projectId,
    key: "STASH-33", title: "Review notification delivery", status: { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", name: "Ready", category: "unstarted" },
    assigneeIds: [], priority: "none", labelNames: [], sourceNoteIds: [], linkedNoteIds: [], dependencies: [], developmentLinks: [],
    createdAt: "2026-08-23T11:00:00.000Z", createdBy: { localAccountId: otherMemberId, displayName: "Grace Hopper" }, revision: 1,
    dependencyWarnings: [] };
  discussion: DiscussionRecord = { id: "88888888-8888-4888-8888-888888888888", workspaceId,
    target: { kind: "task", taskId: "77777777-7777-4777-8777-777777777777" }, messages: [],
    createdAt: "2026-08-23T11:30:00.000Z" };
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
  async getProjectFollow(requestedMemberId: string, requestedProjectId: string) {
    if (!this.visibleProjects.has(`${requestedMemberId}:${requestedProjectId}`)) return undefined;
    return this.follows.has(`${requestedMemberId}:${requestedProjectId}`);
  }
  async saveProjectFollow(requestedMemberId: string, requestedProjectId: string, followed: boolean) {
    if (!this.visibleProjects.has(`${requestedMemberId}:${requestedProjectId}`)) return undefined;
    const key = `${requestedMemberId}:${requestedProjectId}`;
    if (followed) this.follows.add(key); else this.follows.delete(key);
    return followed;
  }
  async listProjectNotificationAudience(requestedProjectId: string, actorId: string) {
    if (requestedProjectId !== projectId) return [];
    return [memberId].filter((id) => id !== actorId && this.visibleProjects.has(`${id}:${requestedProjectId}`))
      .map((id) => ({ memberId: id, followed: this.follows.has(`${id}:${requestedProjectId}`) }));
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
  async findPortableMemberIdentity(requestedMemberId: string) {
    return requestedMemberId === memberId ? { localAccountId: memberId, displayName: "Ada Lovelace" }
      : requestedMemberId === otherMemberId ? { localAccountId: otherMemberId, displayName: "Grace Hopper" } : undefined;
  }
  async createDiscussion(requestedMemberId: string, draft: DiscussionDraft) {
    if (requestedMemberId !== otherMemberId || draft.target.kind !== "task" || draft.target.taskId !== this.task.id)
      return { status: "target_not_found" as const };
    this.discussion = { ...structuredClone(draft), workspaceId,
      target: { kind: "task", taskId: draft.target.taskId } };
    await this.recordMentionNotifications(requestedMemberId, this.discussion.messages[0]!);
    return { status: "created" as const, discussion: structuredClone(this.discussion),
      projection: { schema: "stash.discussion.v1" as const, id: this.discussion.id, workspaceId,
        target: this.discussion.target, messages: structuredClone(this.discussion.messages), createdAt: this.discussion.createdAt } };
  }
  async findDiscussion(requestedMemberId: string, requestedDiscussionId: string) {
    return [memberId, otherMemberId].includes(requestedMemberId) && requestedDiscussionId === this.discussion.id
      ? { status: "found" as const, discussion: structuredClone(this.discussion) } : { status: "not_found" as const };
  }
  async listNoteDiscussions() { return { status: "not_found" as const }; }
  async listBlockDiscussions() { return { status: "not_found" as const }; }
  async listTaskDiscussions() { return { status: "not_found" as const }; }
  async addMessage(requestedMemberId: string, requestedDiscussionId: string, message: DiscussionMessage) {
    const found = await this.findDiscussion(requestedMemberId, requestedDiscussionId);
    if (found.status === "not_found") return found;
    this.discussion.messages.push(structuredClone(message));
    await this.recordMentionNotifications(requestedMemberId, message);
    return { status: "updated" as const, discussion: structuredClone(this.discussion),
      projection: { schema: "stash.discussion.v1" as const, id: this.discussion.id, workspaceId,
        target: this.discussion.target, messages: structuredClone(this.discussion.messages), createdAt: this.discussion.createdAt } };
  }
  private async recordMentionNotifications(requestedMemberId: string, message: DiscussionMessage) {
    const recipients = directMentionMemberIds(message.content).filter((id) => id === memberId && id !== requestedMemberId);
    if (recipients.length) {
      const mentionActivity: ActivityRecord = { schema: "stash.activity.v1", id: message.id, workspaceId,
        object: { kind: "Discussion", id: this.discussion.id }, action: "discussion_message_mentioned_members",
        actor: message.author, cause: { kind: "member" }, occurredAt: message.createdAt, before: {},
        after: { messageId: message.id, mentionedMemberIds: recipients } };
      for (const input of directMentionNotificationInputs(mentionActivity, projectId, recipients)) {
        await this.saveNotification({ schema: "stash.notification.v1", id: "99999999-9999-4999-8999-999999999999",
          ...input, workspaceId, createdAt: message.createdAt, delivery: "immediate" });
      }
    }
  }
  async resolveDiscussion() { return { status: "not_found" as const }; }
  async createWorkFromMessages() { return { status: "not_found" as const }; }
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

  it("derives stable, unique, non-self Discussion mention recipients", () => {
    assert.deepEqual(directMentionMemberIds(`Hi <@${memberId}> and <@${memberId.toUpperCase()}>; email @member is inert`), [memberId]);
    assert.deepEqual(directMentionMemberIds("<@not-a-member>"), []);
    assert.deepEqual(directMentionNotificationInputs(activity, projectId, [memberId, memberId, otherMemberId])
      .map(({ memberId: recipient }) => recipient), [memberId]);
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

  it("derives followed Project recipients from persisted follow state", async () => {
    database.deliveries.length = 0; database.preferences.clear(); database.follows.clear();
    await service.setPreferences(memberId, projectId, { activity: "followed", digest: "off" });
    assert.deepEqual(await service.publishProjectActivity(projectId, activity, "Task planning changed"), { created: 0, suppressed: 1 });
    assert.deepEqual(await service.setProjectFollow(memberId, projectId, { followed: true }), { status: "saved", followed: true });
    assert.deepEqual(await service.publishProjectActivity(projectId, activity, "Task planning changed"), { created: 1, suppressed: 0 });
    assert.equal(database.deliveries[0]?.activity.actor.displayName, "Grace Hopper");
    assert.equal(database.deliveries[0]?.summary, "Task planning changed");
    assert.deepEqual(await service.publishProjectActivity(projectId, activity, "Tampered retry"), { created: 1, suppressed: 0 });
    assert.equal(database.deliveries.length, 1, "the canonical Activity identity makes delivery idempotent");
    assert.equal(database.deliveries[0]?.summary, "Task planning changed", "a retry cannot replace immutable attribution or summary");
  });

  it("delivers canonical Project-scoped Note and relationship Activity with preserved attribution", async () => {
    database.deliveries.length = 0; database.preferences.clear(); database.follows.add(`${memberId}:${projectId}`);
    const noteActivity: ActivityRecord = { ...activity, id: "21000000-0000-4000-8000-000000000001",
      object: { kind: "Note", id: "22000000-0000-4000-8000-000000000001" }, action: "note_edited",
      before: { revision: 1 }, after: { revision: 2 } };
    const linkActivity: ActivityRecord = { ...activity, id: "21000000-0000-4000-8000-000000000002",
      object: { kind: "NoteLink", id: "22000000-0000-4000-8000-000000000002" }, action: "note_link_repaired",
      before: { target: "old" }, after: { target: "new" } };
    assert.deepEqual(await service.publishProjectActivity(projectId, noteActivity, "Grace Hopper changed a Note"), { created: 1, suppressed: 0 });
    assert.deepEqual(await service.publishProjectActivity(projectId, linkActivity, "Grace Hopper changed Project content"), { created: 1, suppressed: 0 });
    assert.deepEqual(database.deliveries.map(({ activity: delivered }) => [delivered.object.kind, delivered.actor.displayName]),
      [["Note", "Grace Hopper"], ["NoteLink", "Grace Hopper"]]);
  });

  it("persists follow state through a running authenticated Instance", async () => {
    database.follows.clear();
    const saved = await request(`/api/projects/${projectId}/follow`, "PUT", { followed: true });
    assert.equal(saved.status, 200); assert.deepEqual(await saved.json(), { followed: true });
    assert.deepEqual(await (await request(`/api/projects/${projectId}/follow`)).json(), { followed: true });
    assert.equal((await request(`/api/projects/${otherProjectId}/follow`, "PUT", { followed: true })).status, 404);
    assert.equal((await request(`/api/projects/${projectId}/follow`, "PUT", { followed: "yes" })).status, 422);
    assert.equal((await request(`/api/projects/${projectId}/follow`, "PUT", { followed: true }, "other-token")).status, 404);
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

  it("creates only accessible, non-self direct-mention delivery through the real Discussion reply boundary", async () => {
    database.deliveries.length = 0;
    const discussionServer = await startInstance({ database, host: "127.0.0.1", port: 0, instanceAdminToken: "admin",
      memberAccess: access, notifications: service, discussions: new DiscussionService(database) });
    try {
      const reply = (content: string) => fetch(`${discussionServer.url}/api/discussions/${database.discussion.id}/messages`, {
        method: "POST", headers: { authorization: "Bearer other-token", "content-type": "application/json" },
        body: JSON.stringify({ content }),
      });
      assert.equal((await reply(`Please review <@${memberId}> <@${memberId}> and ignore <@${otherMemberId}> <@${inaccessibleMemberId}>`)).status, 201);
      const inbox = await fetch(`${discussionServer.url}/api/notifications`, { headers: { authorization: "Bearer member-token" } });
      const body = await inbox.json() as { notifications: NotificationDelivery[] };
      assert.equal(body.notifications.length, 1);
      assert.equal(body.notifications[0]?.trigger, "direct_mention");
      assert.equal(body.notifications[0]?.activity.object.id, database.discussion.id);
      assert.equal(body.notifications[0]?.activity.actor.localAccountId, otherMemberId);
      assert.deepEqual(body.notifications[0]?.activity.after.mentionedMemberIds, [memberId]);
      assert.equal((await reply(`Self only <@${otherMemberId}>`)).status, 201);
      assert.equal(database.deliveries.length, 1, "duplicate and self mentions must not create noise");
    } finally { await discussionServer.close(); }
  });

  it("creates direct-mention delivery from the first canonical Discussion message", async () => {
    database.deliveries.length = 0;
    const discussionServer = await startInstance({ database, host: "127.0.0.1", port: 0, instanceAdminToken: "admin",
      memberAccess: access, notifications: service, discussions: new DiscussionService(database) });
    try {
      const created = await fetch(`${discussionServer.url}/api/discussions`, { method: "POST",
        headers: { authorization: "Bearer other-token", "content-type": "application/json" },
        body: JSON.stringify({ target: { kind: "task", taskId: database.task.id }, message: `Heads up <@${memberId}>` }),
      });
      assert.equal(created.status, 201);
      const inbox = await fetch(`${discussionServer.url}/api/notifications`, { headers: { authorization: "Bearer member-token" } });
      const body = await inbox.json() as { notifications: NotificationDelivery[] };
      assert.equal(body.notifications.length, 1);
      assert.equal(body.notifications[0]?.activity.action, "discussion_message_mentioned_members");
    } finally { await discussionServer.close(); }
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

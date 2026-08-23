import { randomUUID } from "node:crypto";

import type { ActivityRecord } from "./activity.js";

export type NotificationTrigger = "direct_mention" | "assignment" | "requested_review" | "automation_failure" | "followed_change";
export type ProjectActivityPreference = "all" | "followed" | "muted";
export type DigestCadence = "off" | "daily" | "weekly";

export interface NotificationPreferences {
  activity: ProjectActivityPreference;
  digest: DigestCadence;
  quietHours?: { start: string; end: string; timeZone: string };
}

export interface NotificationDelivery {
  schema: "stash.notification.v1";
  id: string;
  memberId: string;
  workspaceId: string;
  projectId: string;
  trigger: NotificationTrigger;
  summary: string;
  activity: ActivityRecord;
  createdAt: string;
  delivery: "immediate" | "quiet_hours";
  readAt?: string;
  digestedAt?: string;
}

export interface NotificationRepository {
  saveNotification(delivery: NotificationDelivery): Promise<NotificationDelivery>;
  listNotifications(memberId: string): Promise<NotificationDelivery[]>;
  markNotificationRead(memberId: string, id: string, readAt: string): Promise<NotificationDelivery | undefined>;
  getNotificationPreferences(memberId: string, projectId: string): Promise<NotificationPreferences | undefined>;
  saveNotificationPreferences(memberId: string, projectId: string, preferences: NotificationPreferences): Promise<NotificationPreferences | undefined>;
  claimDigestNotifications(memberId: string, cadence: Exclude<DigestCadence, "off">, since: string, until: string, claimedAt: string): Promise<NotificationDelivery[]>;
}

export class InvalidNotificationInput extends Error {}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const clockTime = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const defaultPreferences: NotificationPreferences = { activity: "followed", digest: "off" };
const triggers = new Set<NotificationTrigger>(["direct_mention", "assignment", "requested_review", "automation_failure", "followed_change"]);

export function assignmentNotificationInputs(activity: ActivityRecord, projectId: string,
  before: { assigneeIds?: string[] }, after: { assigneeIds?: string[]; key?: string; title?: string }) {
  const previous = new Set(before.assigneeIds ?? []);
  return (after.assigneeIds ?? []).filter((memberId) => !previous.has(memberId) && memberId !== activity.actor.localAccountId)
    .map((memberId) => ({ memberId, projectId, trigger: "assignment" as const,
      summary: after.key && after.title ? `Assigned to ${after.key}: ${after.title}` : "A Task was assigned to you", activity }));
}

function isTimeZone(value: string): boolean {
  try { new Intl.DateTimeFormat("en", { timeZone: value }).format(); return true; } catch { return false; }
}

export function notificationDeliveryMode(now: Date, preferences: NotificationPreferences): NotificationDelivery["delivery"] {
  const quiet = preferences.quietHours;
  if (!quiet) return "immediate";
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: quiet.timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(now);
  const current = `${parts.find(({ type }) => type === "hour")!.value}:${parts.find(({ type }) => type === "minute")!.value}`;
  const quietNow = quiet.start < quiet.end ? current >= quiet.start && current < quiet.end : current >= quiet.start || current < quiet.end;
  return quietNow ? "quiet_hours" : "immediate";
}

export class NotificationService {
  constructor(private readonly repository: NotificationRepository, private readonly now = () => new Date()) {}

  async publish(actorId: string, projectId: string, value: unknown) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new InvalidNotificationInput();
    const event = value as Record<string, unknown>; const activity = event.activity as ActivityRecord | undefined;
    if (!uuid.test(projectId) || !uuid.test(String(event.memberId)) || !triggers.has(event.trigger as NotificationTrigger)
      || typeof event.summary !== "string" || !activity || activity.schema !== "stash.activity.v1"
      || activity.actor.localAccountId !== actorId || activity.workspaceId.length === 0
      || typeof event.followed !== "undefined" && typeof event.followed !== "boolean"
      || !Object.keys(event).every((key) => ["memberId", "trigger", "summary", "activity", "followed"].includes(key)))
      throw new InvalidNotificationInput();
    return this.notify({ activity, projectId, memberId: event.memberId as string, trigger: event.trigger as NotificationTrigger,
      summary: event.summary, ...(typeof event.followed === "boolean" ? { followed: event.followed } : {}) });
  }

  async notify(input: { activity: ActivityRecord; projectId: string; memberId: string; trigger: NotificationTrigger; summary: string; followed?: boolean }) {
    if (!uuid.test(input.projectId) || !uuid.test(input.memberId) || !input.summary.trim() || input.summary.length > 500) throw new InvalidNotificationInput();
    if (input.activity.actor.localAccountId === input.memberId) return { status: "suppressed" as const };
    const preferences = await this.repository.getNotificationPreferences(input.memberId, input.projectId) ?? defaultPreferences;
    if (input.trigger === "followed_change" && (preferences.activity === "muted"
      || preferences.activity === "followed" && input.followed !== true)) return { status: "suppressed" as const };
    const now = this.now();
    const delivery: NotificationDelivery = {
      schema: "stash.notification.v1", id: randomUUID(), memberId: input.memberId, workspaceId: input.activity.workspaceId,
      projectId: input.projectId, trigger: input.trigger, summary: input.summary.trim(), activity: structuredClone(input.activity),
      createdAt: now.toISOString(), delivery: notificationDeliveryMode(now, preferences),
    };
    return { status: "created" as const, notification: await this.repository.saveNotification(delivery) };
  }

  async list(memberId: string, unreadOnly: boolean) {
    const notifications = await this.repository.listNotifications(memberId);
    return notifications.filter((entry) => !unreadOnly || !entry.readAt).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async digest(memberId: string) {
    const now = this.now();
    const daily = new Date(now); daily.setUTCHours(0, 0, 0, 0);
    const weekly = new Date(daily); weekly.setUTCDate(weekly.getUTCDate() - (weekly.getUTCDay() + 6) % 7);
    const claimedAt = now.toISOString();
    const [dailyEntries, weeklyEntries] = await Promise.all([
      this.repository.claimDigestNotifications(memberId, "daily", daily.toISOString(), claimedAt, claimedAt),
      this.repository.claimDigestNotifications(memberId, "weekly", weekly.toISOString(), claimedAt, claimedAt),
    ]);
    return [...dailyEntries, ...weeklyEntries].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async markRead(memberId: string, id: string) {
    if (!uuid.test(id)) throw new InvalidNotificationInput();
    return this.repository.markNotificationRead(memberId, id, this.now().toISOString());
  }

  async getPreferences(memberId: string, projectId: string) {
    if (!uuid.test(projectId)) throw new InvalidNotificationInput();
    const value = await this.repository.getNotificationPreferences(memberId, projectId);
    return value ? { status: "found" as const, preferences: value } : { status: "not_found" as const };
  }

  async setPreferences(memberId: string, projectId: string, value: unknown) {
    if (!uuid.test(projectId) || value === null || typeof value !== "object" || Array.isArray(value)) throw new InvalidNotificationInput();
    const object = value as Record<string, unknown>;
    if (!(["all", "followed", "muted"] as unknown[]).includes(object.activity)
      || !(["off", "daily", "weekly"] as unknown[]).includes(object.digest)
      || !Object.keys(object).every((key) => ["activity", "digest", "quietHours"].includes(key))) throw new InvalidNotificationInput();
    let quietHours: NotificationPreferences["quietHours"];
    if (object.quietHours !== undefined) {
      if (object.quietHours === null || typeof object.quietHours !== "object" || Array.isArray(object.quietHours)) throw new InvalidNotificationInput();
      const quiet = object.quietHours as Record<string, unknown>;
      if (typeof quiet.start !== "string" || !clockTime.test(quiet.start) || typeof quiet.end !== "string" || !clockTime.test(quiet.end)
        || typeof quiet.timeZone !== "string" || !isTimeZone(quiet.timeZone) || Object.keys(quiet).length !== 3) throw new InvalidNotificationInput();
      quietHours = { start: quiet.start, end: quiet.end, timeZone: quiet.timeZone };
    }
    const preferences: NotificationPreferences = { activity: object.activity as ProjectActivityPreference, digest: object.digest as DigestCadence, ...(quietHours ? { quietHours } : {}) };
    const saved = await this.repository.saveNotificationPreferences(memberId, projectId, preferences);
    return saved ? { status: "saved" as const, preferences: saved } : { status: "not_found" as const };
  }
}

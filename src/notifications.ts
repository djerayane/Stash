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
}

export interface NotificationRepository {
  saveNotification(delivery: NotificationDelivery): Promise<NotificationDelivery>;
  listNotifications(memberId: string): Promise<NotificationDelivery[]>;
  markNotificationRead(memberId: string, id: string, readAt: string): Promise<NotificationDelivery | undefined>;
  getNotificationPreferences(memberId: string, projectId: string): Promise<NotificationPreferences | undefined>;
  saveNotificationPreferences(memberId: string, projectId: string, preferences: NotificationPreferences): Promise<NotificationPreferences | undefined>;
}

export class InvalidNotificationInput extends Error {}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const clockTime = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const defaultPreferences: NotificationPreferences = { activity: "followed", digest: "off" };

function isTimeZone(value: string): boolean {
  try { new Intl.DateTimeFormat("en", { timeZone: value }).format(); return true; } catch { return false; }
}

function isQuiet(now: Date, quiet: NonNullable<NotificationPreferences["quietHours"]>): boolean {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: quiet.timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(now);
  const current = `${parts.find(({ type }) => type === "hour")!.value}:${parts.find(({ type }) => type === "minute")!.value}`;
  return quiet.start < quiet.end ? current >= quiet.start && current < quiet.end : current >= quiet.start || current < quiet.end;
}

export class NotificationService {
  constructor(private readonly repository: NotificationRepository, private readonly now = () => new Date()) {}

  async notify(input: { activity: ActivityRecord; projectId: string; memberId: string; trigger: NotificationTrigger; summary: string }) {
    if (!uuid.test(input.projectId) || !uuid.test(input.memberId) || !input.summary.trim() || input.summary.length > 500) throw new InvalidNotificationInput();
    if (input.activity.actor.localAccountId === input.memberId) return { status: "suppressed" as const };
    const preferences = await this.repository.getNotificationPreferences(input.memberId, input.projectId) ?? defaultPreferences;
    if (input.trigger === "followed_change" && preferences.activity === "muted") return { status: "suppressed" as const };
    const now = this.now();
    const delivery: NotificationDelivery = {
      schema: "stash.notification.v1", id: randomUUID(), memberId: input.memberId, workspaceId: input.activity.workspaceId,
      projectId: input.projectId, trigger: input.trigger, summary: input.summary.trim(), activity: structuredClone(input.activity),
      createdAt: now.toISOString(), delivery: preferences.quietHours && isQuiet(now, preferences.quietHours) ? "quiet_hours" : "immediate",
    };
    return { status: "created" as const, notification: await this.repository.saveNotification(delivery) };
  }

  async list(memberId: string, unreadOnly: boolean) {
    const notifications = await this.repository.listNotifications(memberId);
    return notifications.filter((entry) => !unreadOnly || !entry.readAt).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async digest(memberId: string) {
    const notifications = await this.list(memberId, true); const included: NotificationDelivery[] = [];
    for (const notification of notifications) {
      const preferences = await this.repository.getNotificationPreferences(memberId, notification.projectId) ?? defaultPreferences;
      if (preferences.digest !== "off") included.push(notification);
    }
    return included;
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

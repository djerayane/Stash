export interface ValidationResult<T> {
  readonly ok: boolean;
  readonly value?: T;
  readonly message?: string;
}

export function nonEmptyText(value: unknown, label = "Value"): ValidationResult<string> {
  if (typeof value !== "string" || value.trim().length === 0) return { ok: false, message: `${label} is required` };
  return { ok: true, value: value.trim() };
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function canonicalUuid(value: string): string {
  return isUuid(value) ? value.toLowerCase() : value;
}

export function validPortableFilename(value: string): boolean {
  return Boolean(value && value.length <= 255 && value === value.trim() && !/[\/\\\u0000-\u001f\u007f]/.test(value)
    && !/[. ]$/.test(value) && value !== "." && value !== ".."
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value));
}

export function validMobilePairingOrigin(value: string, allowLoopbackHttp = false): boolean {
  try {
    const url = new URL(value);
    const loopback = allowLoopbackHttp && url.protocol === "http:"
      && (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1");
    return (url.protocol === "https:" || loopback) && !url.username && !url.password
      && url.origin === url.href.replace(/\/$/, "");
  } catch {
    return false;
  }
}

export type ProjectActivityPreference = "all" | "followed" | "muted";
export type NotificationDigestCadence = "off" | "daily" | "weekly";
export interface ProjectNotificationSettings {
  readonly activity: ProjectActivityPreference;
  readonly digest: NotificationDigestCadence;
  readonly quietHours?: { readonly start: string; readonly end: string; readonly timeZone: string };
}

const clockTime = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
export function projectNotificationSettings(value: unknown): ValidationResult<ProjectNotificationSettings> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, message: "Notification settings are invalid" };
  const item = value as Record<string, unknown>;
  if (!["all", "followed", "muted"].includes(String(item.activity)) || !["off", "daily", "weekly"].includes(String(item.digest)))
    return { ok: false, message: "Notification settings are invalid" };
  let quietHours: ProjectNotificationSettings["quietHours"];
  if (item.quietHours !== undefined) {
    if (!item.quietHours || typeof item.quietHours !== "object" || Array.isArray(item.quietHours)) return { ok: false, message: "Quiet hours are invalid" };
    const quiet = item.quietHours as Record<string, unknown>;
    if (typeof quiet.start !== "string" || !clockTime.test(quiet.start) || typeof quiet.end !== "string" || !clockTime.test(quiet.end)
      || typeof quiet.timeZone !== "string" || !quiet.timeZone.trim()) return { ok: false, message: "Quiet hours are invalid" };
    quietHours = { start: quiet.start, end: quiet.end, timeZone: quiet.timeZone };
  }
  return { ok: true, value: { activity: item.activity as ProjectActivityPreference, digest: item.digest as NotificationDigestCadence,
    ...(quietHours ? { quietHours } : {}) } };
}

export function projectFollowState(value: unknown): ValidationResult<boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof (value as { followed?: unknown }).followed !== "boolean")
    return { ok: false, message: "Project follow state is invalid" };
  return { ok: true, value: (value as { followed: boolean }).followed };
}

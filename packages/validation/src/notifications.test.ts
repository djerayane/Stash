import { describe, expect, it } from "vitest";
import { projectFollowState, projectNotificationSettings } from "./index";

describe("Project notification protocol validation", () => {
  it("accepts complete settings and rejects malformed quiet hours", () => {
    expect(projectNotificationSettings({ activity: "followed", digest: "weekly", quietHours: { start: "22:00", end: "07:00", timeZone: "Europe/Paris" } }).ok).toBe(true);
    expect(projectNotificationSettings({ activity: "followed", digest: "weekly", quietHours: { start: "29:00", end: "07:00", timeZone: "Europe/Paris" } }).ok).toBe(false);
    expect(projectFollowState({ followed: true })).toEqual({ ok: true, value: true });
  });
});

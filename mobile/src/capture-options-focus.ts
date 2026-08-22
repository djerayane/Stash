import type { MobileCaptureClient, MobileCaptureOptions } from "../../src/mobile-capture-client";

export function loadCachedOptionsOnFocus(client: MobileCaptureClient, onOptions: (options: MobileCaptureOptions) => void): () => void {
  let active = true;
  void client.options().then((options) => { if (active) onOptions(options); });
  return () => { active = false; };
}

export type CaptureSelections = { projectId?: string; tag?: string; reminderOffset?: number };

export function reconcileCaptureSelections(options: MobileCaptureOptions, selections: CaptureSelections): CaptureSelections {
  return {
    ...(selections.projectId && options.projects.some(({ id }) => id === selections.projectId)
      ? { projectId: selections.projectId } : {}),
    ...(selections.tag && options.tags.includes(selections.tag) ? { tag: selections.tag } : {}),
    ...(selections.reminderOffset !== undefined
      && options.reminders.some(({ offsetMinutes }) => offsetMinutes === selections.reminderOffset)
      ? { reminderOffset: selections.reminderOffset } : {}),
  };
}

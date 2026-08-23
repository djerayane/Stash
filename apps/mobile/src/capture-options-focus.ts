import type { MobileCaptureClient, MobileCaptureOptions } from "@stash/sync";

export const captureOptionsLoadingMessage = "Loading options for this pairing before capture.";
export const captureOptionsErrorMessage = "Capture options could not be loaded. Retry before saving.";

export function ensureCaptureOptionsReady(ready: boolean): void {
  if (!ready) throw new Error(captureOptionsLoadingMessage);
}

export function loadCachedOptionsOnFocus(
  client: MobileCaptureClient,
  onOptions: (options: MobileCaptureOptions) => void,
  onLoading: () => void = () => undefined,
  onError: (error: unknown) => void = () => undefined,
): () => void {
  let active = true;
  onLoading();
  void client.options().then(
    (options) => { if (active) onOptions(options); },
    (error: unknown) => { if (active) onError(error); },
  );
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

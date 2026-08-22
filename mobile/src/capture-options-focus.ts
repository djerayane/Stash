import type { MobileCaptureClient, MobileCaptureOptions } from "../../src/mobile-capture-client";

export function loadCachedOptionsOnFocus(client: MobileCaptureClient, onOptions: (options: MobileCaptureOptions) => void): () => void {
  let active = true;
  void client.options().then((options) => { if (active) onOptions(options); });
  return () => { active = false; };
}

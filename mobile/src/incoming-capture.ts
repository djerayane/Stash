export interface IncomingCapture { content: string; source: "share_sheet" | "widget" }
export type IncomingCaptureParseResult = { kind: "ignored" } | { kind: "error"; message: string }
  | { kind: "capture"; capture: IncomingCapture };

export function parseIncomingCapture(url: string): IncomingCaptureParseResult {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return { kind: "ignored" }; }
  if (parsed.protocol !== "stash:" || (parsed.hostname !== "capture" && parsed.pathname !== "capture" && parsed.pathname !== "/capture")) return { kind: "ignored" };
  const source = parsed.searchParams.get("source");
  const content = parsed.searchParams.get("content")?.trim();
  if (source !== "share_sheet" && source !== "widget") return { kind: "error", message: "This capture source is not supported." };
  if (!content) return { kind: "error", message: "Shared and widget captures require content." };
  if (content.length > 20_000) return { kind: "error", message: "Shared and widget captures cannot exceed 20,000 characters." };
  return { kind: "capture", capture: { content, source } };
}

export class IncomingCaptureDeliveryGate {
  #candidates = new Map<string, { delivery: "initial" | "event"; at: number }>();
  constructor(readonly duplicateWindowMs = 2_000, readonly maxCandidates = 32) {}
  accept(url: string, delivery: "initial" | "event", now = Date.now()): boolean {
    for (const [candidateUrl, candidate] of this.#candidates) {
      if (now - candidate.at > this.duplicateWindowMs) this.#candidates.delete(candidateUrl);
    }
    const candidate = this.#candidates.get(url);
    if (candidate && candidate.delivery !== delivery) {
      this.#candidates.delete(url);
      return false;
    }
    this.#candidates.delete(url);
    this.#candidates.set(url, { delivery, at: now });
    while (this.#candidates.size > this.maxCandidates) this.#candidates.delete(this.#candidates.keys().next().value!);
    return true;
  }
  pendingCount(): number { return this.#candidates.size; }
}

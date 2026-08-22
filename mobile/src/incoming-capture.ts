export interface IncomingCapture { content: string; source: "share_sheet" | "widget" }

export function parseIncomingCapture(url: string): IncomingCapture | undefined {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return undefined; }
  if (parsed.protocol !== "stash:" || (parsed.hostname !== "capture" && parsed.pathname !== "capture" && parsed.pathname !== "/capture")) return undefined;
  const source = parsed.searchParams.get("source");
  const content = parsed.searchParams.get("content")?.trim();
  if ((source !== "share_sheet" && source !== "widget") || !content || content.length > 20_000) return undefined;
  return { content, source };
}

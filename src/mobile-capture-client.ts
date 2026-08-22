export interface MobileCapturePairing {
  instanceUrl: string;
  memberToken: string;
  workspaceId: string;
}

export interface MobileCaptureOptions {
  projects: { id: string; name: string }[];
  tags: string[];
  reminders: { id: string; label: string; offsetMinutes: number }[];
}

export interface MobileCapture {
  id: string;
  kind: "text" | "checklist";
  content: string;
  checklist?: { text: string; checked: boolean }[];
  projectId?: string;
  tags?: string[];
  reminder?: { at: string };
  createdAt: string;
  attempts: number;
  lastError?: string;
}

export interface EncryptedMobileCaptureStore {
  loadPairing(): Promise<MobileCapturePairing | undefined>;
  savePairing(pairing: MobileCapturePairing): Promise<void>;
  listCaptures(): Promise<MobileCapture[]>;
  saveCapture(capture: MobileCapture): Promise<void>;
  removeCapture(id: string): Promise<void>;
  loadOptions(): Promise<MobileCaptureOptions>;
  saveOptions(options: MobileCaptureOptions): Promise<void>;
}

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type MobileSyncResult =
  | { status: "synced"; count: number }
  | { status: "offline" | "retry_pending"; count: number }
  | { status: "attention_required"; count: number; error: string };

export class MobileCaptureClient {
  readonly #store: EncryptedMobileCaptureStore;
  readonly #fetch: Fetch;
  readonly #allowInsecureInstanceForTest: boolean;
  #activeRequest: AbortController | undefined;

  constructor(store: EncryptedMobileCaptureStore, fetchImplementation: Fetch, options: { allowInsecureInstanceForTest?: boolean } = {}) {
    this.#store = store;
    this.#fetch = fetchImplementation;
    this.#allowInsecureInstanceForTest = options.allowInsecureInstanceForTest ?? false;
  }

  async pair(pairing: MobileCapturePairing): Promise<void> {
    let url: URL;
    try { url = new URL(pairing.instanceUrl); } catch { throw new Error("Instance URL must be a valid HTTPS origin."); }
    const testLoopback = this.#allowInsecureInstanceForTest && url.protocol === "http:"
      && (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1");
    if ((url.protocol !== "https:" && !testLoopback)
      || url.username || url.password || url.origin !== url.href.replace(/\/$/, "")) {
      throw new Error("Instance URL must be a valid HTTPS origin.");
    }
    if (!pairing.memberToken.trim() || !isUuid(pairing.workspaceId)) throw new Error("Pairing requires a Member token and Workspace.");
    await this.#store.savePairing({ ...pairing, instanceUrl: url.origin });
  }

  outbox() { return this.#store.listCaptures(); }
  options() { return this.#store.loadOptions(); }
  cacheOptions(options: MobileCaptureOptions) { return this.#store.saveOptions(options); }

  watchConnectivity(
    subscribe: (listener: (online: boolean) => void) => () => void,
    onResult: (result: MobileSyncResult) => void = () => undefined,
    schedule: (task: () => void, delayMs: number) => () => void = (task, delayMs) => {
      const timer = setTimeout(task, delayMs);
      return () => clearTimeout(timer);
    },
  ): () => void {
    let online = false;
    let cancelRetry: (() => void) | undefined;
    let retryNumber = 0;
    const synchronize = () => {
      if (!online) return;
      void this.sync().then((result) => {
        if (!online) return;
        onResult(result);
        if (result.status === "retry_pending" && online) {
          const delay = Math.min(1_000 * 2 ** retryNumber, 60_000);
          retryNumber += 1;
          cancelRetry = schedule(synchronize, delay);
        } else retryNumber = 0;
      });
    };
    const unsubscribe = subscribe((isOnline) => {
      online = isOnline;
      cancelRetry?.();
      cancelRetry = undefined;
      if (online) synchronize(); else this.cancelRequests();
    });
    return () => { online = false; cancelRetry?.(); this.cancelRequests(); unsubscribe(); };
  }

  cancelRequests(): void { this.#activeRequest?.abort(new DOMException("Request cancelled", "AbortError")); }

  async refreshOptions(signal?: AbortSignal): Promise<MobileCaptureOptions> {
    const controller = this.#beginRequest(signal);
    const pairing = await this.#store.loadPairing();
    if (!pairing) throw new Error("Pair the app before refreshing capture options.");
    const response = await this.#fetch(`${pairing.instanceUrl}/api/mobile/v1/workspaces/${pairing.workspaceId}/capture-options`, {
      headers: { authorization: `Bearer ${pairing.memberToken}` },
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({})) as MobileCaptureOptions & { message?: string };
    if (!response.ok) throw new Error(body.message ?? "Capture options could not be refreshed.");
    const options = { projects: body.projects, tags: body.tags, reminders: body.reminders };
    await this.#store.saveOptions(options);
    return options;
  }

  async captureText(content: string, structure: Pick<MobileCapture, "projectId" | "tags" | "reminder"> = {}): Promise<MobileCapture> {
    return this.#enqueue("text", content, undefined, structure);
  }

  async captureChecklist(title: string, items: string[], structure: Pick<MobileCapture, "projectId" | "tags" | "reminder"> = {}): Promise<MobileCapture> {
    if (!items.length || items.some((item) => !item.trim())) throw new Error("A checklist requires at least one non-empty item.");
    return this.#enqueue("checklist", title, items.map((text) => ({ text: text.trim(), checked: false })), structure);
  }

  async #enqueue(kind: MobileCapture["kind"], content: string, checklist: MobileCapture["checklist"], structure: Pick<MobileCapture, "projectId" | "tags" | "reminder">) {
    if (!content.trim()) throw new Error("A capture requires content.");
    const capture: MobileCapture = {
      id: crypto.randomUUID(), kind, content: content.trim(), createdAt: new Date().toISOString(), attempts: 0,
      ...(checklist ? { checklist } : {}), ...(structure.projectId ? { projectId: structure.projectId } : {}),
      ...(structure.tags ? { tags: structure.tags } : {}), ...(structure.reminder ? { reminder: structure.reminder } : {}),
    };
    await this.#store.saveCapture(capture);
    return capture;
  }

  async sync(signal?: AbortSignal): Promise<MobileSyncResult> {
    const controller = this.#beginRequest(signal);
    const pairing = await this.#store.loadPairing();
    if (!pairing) return { status: "attention_required", count: 0, error: "not_paired" };
    let count = 0;
    let attentionError: string | undefined;
    for (const capture of await this.#store.listCaptures()) {
      let response: Response;
      try {
        response = await this.#fetch(`${pairing.instanceUrl}/api/mobile/v1/workspaces/${pairing.workspaceId}/captures`, {
          method: "POST",
          headers: { authorization: `Bearer ${pairing.memberToken}`, "content-type": "application/json" },
          body: JSON.stringify({ protocol: "stash.mobile-capture.v1", ...capture, lastError: undefined, attempts: undefined }),
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted) return { status: "offline", count };
        return { status: "offline", count };
      }
      const body = await response.json().catch(() => ({})) as { error?: string; message?: string };
      if (response.ok) {
        await this.#store.removeCapture(capture.id);
        count += 1;
        continue;
      }
      const failed = { ...capture, attempts: capture.attempts + 1, lastError: body.message ?? "Synchronization failed." };
      await this.#store.saveCapture(failed);
      if (response.status >= 500 || response.status === 429) return { status: "retry_pending", count };
      attentionError ??= body.error ?? "sync_rejected";
    }
    return attentionError ? { status: "attention_required", count, error: attentionError } : { status: "synced", count };
  }

  #beginRequest(externalSignal?: AbortSignal): AbortController {
    this.cancelRequests();
    const controller = new AbortController();
    this.#activeRequest = controller;
    if (externalSignal?.aborted) controller.abort(externalSignal.reason);
    else externalSignal?.addEventListener("abort", () => controller.abort(externalSignal.reason), { once: true });
    return controller;
  }
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

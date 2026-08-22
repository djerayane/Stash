export interface MobileCapturePairing {
  instanceUrl: string;
  memberToken: string;
  workspaceId: string;
  memberId?: string;
}

export interface MobileCaptureOptions {
  projects: { id: string; name: string }[];
  tags: string[];
  reminders: { id: string; label: string; offsetMinutes: number }[];
}

export interface MobileCapture {
  id: string;
  kind: "text" | "checklist" | "photo" | "file" | "voice";
  content: string;
  checklist?: { text: string; checked: boolean }[];
  projectId?: string;
  tags?: string[];
  reminder?: { at: string };
  createdAt: string;
  origin?: { instanceUrl: string; workspaceId: string; memberId?: string };
  attempts: number;
  nextRetryAt?: string;
  lastError?: string;
  source?: "app" | "share_sheet" | "widget";
  attachment?: {
    filename: string;
    contentType: string;
    base64: string;
    remote?: { id: string; portableLink: string };
  };
}

export interface EncryptedMobileCaptureStore {
  loadPairing(): Promise<MobileCapturePairing | undefined>;
  savePairing(pairing: MobileCapturePairing): Promise<void>;
  listCaptures(): Promise<MobileCapture[]>;
  saveCapture(capture: MobileCapture): Promise<void>;
  removeCapture(id: string): Promise<void>;
  loadOptions(scope: string): Promise<MobileCaptureOptions>;
  saveOptions(scope: string, options: MobileCaptureOptions): Promise<void>;
}

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type MobileSyncResult =
  | { status: "synced"; count: number }
  | { status: "offline" | "retry_pending"; count: number }
  | { status: "cancelled"; count: number }
  | { status: "attention_required"; count: number; error: string; retryPending?: boolean };

export class LegacyRecoveryRequired extends Error {
  constructor() { super("Export the legacy captures before replacing this pairing."); this.name = "LegacyRecoveryRequired"; }
}

export class MobileCaptureClient {
  readonly #store: EncryptedMobileCaptureStore;
  readonly #fetch: Fetch;
  readonly #allowInsecureInstanceForTest: boolean;
  readonly #now: () => number;
  #syncController: AbortController | undefined;
  #refreshControllers = new Set<AbortController>();
  #inFlightSync: Promise<MobileSyncResult> | undefined;
  #legacyExportAcknowledged = false;

  constructor(store: EncryptedMobileCaptureStore, fetchImplementation: Fetch, options: { allowInsecureInstanceForTest?: boolean; now?: () => number } = {}) {
    this.#store = store;
    this.#fetch = fetchImplementation;
    this.#allowInsecureInstanceForTest = options.allowInsecureInstanceForTest ?? false;
    this.#now = options.now ?? Date.now;
  }

  async pair(pairing: MobileCapturePairing, signal?: AbortSignal, options: { replaceLegacy?: boolean } = {}): Promise<void> {
    const acknowledgedLegacyExport = options.replaceLegacy && this.#legacyExportAcknowledged;
    if (options.replaceLegacy) this.#legacyExportAcknowledged = false;
    let url: URL;
    try { url = new URL(pairing.instanceUrl); } catch { throw new Error("Instance URL must be a valid HTTPS origin."); }
    const testLoopback = this.#allowInsecureInstanceForTest && url.protocol === "http:"
      && (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1");
    if ((url.protocol !== "https:" && !testLoopback)
      || url.username || url.password || url.origin !== url.href.replace(/\/$/, "")) {
      throw new Error("Instance URL must be a valid HTTPS origin.");
    }
    if (!pairing.memberToken.trim() || !isUuid(pairing.workspaceId)) throw new Error("Pairing requires a Member token and Workspace.");
    const controller = this.#controller(signal);
    this.#refreshControllers.add(controller);
    try {
      const response = await this.#fetch(`${url.origin}/api/mobile/v1/workspaces/${pairing.workspaceId}/capture-options`, {
        headers: { authorization: `Bearer ${pairing.memberToken}` }, signal: controller.signal,
      });
      const body = await response.json().catch(() => ({})) as MobileCaptureOptions & { memberId?: string; message?: string };
      if (!response.ok || !body.memberId) throw new Error(body.message ?? "The Member pairing could not be authenticated.");
      const previous = await this.#store.loadPairing();
      const authenticated = { ...pairing, instanceUrl: url.origin, memberId: body.memberId };
      const preservesLegacyIdentity = previous?.instanceUrl === authenticated.instanceUrl
        && previous.workspaceId === authenticated.workspaceId && previous.memberToken === authenticated.memberToken;
      const replacingLegacy = previous && !previous.memberId && !preservesLegacyIdentity
        && (await this.#legacyCaptures(previous)).length > 0;
      if (replacingLegacy && (!options.replaceLegacy || !acknowledgedLegacyExport)) throw new LegacyRecoveryRequired();
      if (previous?.instanceUrl === authenticated.instanceUrl && previous.workspaceId === authenticated.workspaceId
        && previous.memberToken === authenticated.memberToken) {
        for (const capture of await this.#store.listCaptures()) {
          if (!capture.origin || (!capture.origin.memberId && capture.origin.instanceUrl === authenticated.instanceUrl
            && capture.origin.workspaceId === authenticated.workspaceId)) {
            await this.#store.saveCapture({ ...capture, origin: { instanceUrl: authenticated.instanceUrl,
              workspaceId: authenticated.workspaceId, memberId: authenticated.memberId } });
          }
        }
      }
      await this.#store.savePairing(authenticated);
      await this.#store.saveOptions(pairingScope(authenticated), { projects: body.projects, tags: body.tags, reminders: body.reminders });
    } finally { this.#refreshControllers.delete(controller); }
  }

  async outbox() {
    const pairing = await this.#store.loadPairing();
    if (!pairing?.memberId) return [];
    return (await this.#store.listCaptures()).filter((capture) => capture.origin?.instanceUrl === pairing.instanceUrl
      && capture.origin.workspaceId === pairing.workspaceId && capture.origin.memberId === pairing.memberId);
  }
  async legacyRecoveryStatus(): Promise<{ available: boolean; count: number }> {
    const pairing = await this.#store.loadPairing();
    if (!pairing || pairing.memberId) return { available: false, count: 0 };
    const captures = await this.#legacyCaptures(pairing);
    return { available: captures.length > 0, count: captures.length };
  }
  async exportLegacyCaptures(): Promise<string> {
    const pairing = await this.#store.loadPairing();
    if (!pairing || pairing.memberId) throw new Error("Legacy capture export is available only from an unverified legacy pairing.");
    const captures = await this.#legacyCaptures(pairing);
    if (!captures.length) throw new Error("No legacy captures are available for this destination.");
    return JSON.stringify({ protocol: "stash.mobile-capture-recovery.v1",
      instanceUrl: pairing.instanceUrl, workspaceId: pairing.workspaceId, captures }, null, 2);
  }
  acknowledgeLegacyRecoveryExport(shared: boolean): void { this.#legacyExportAcknowledged = shared; }
  async options() {
    const pairing = await this.#store.loadPairing();
    return pairing?.memberId ? this.#store.loadOptions(pairingScope(pairing)) : emptyOptions();
  }
  async cacheOptions(options: MobileCaptureOptions) {
    const pairing = await this.#store.loadPairing();
    if (!pairing) throw new Error("Pair the app before caching capture options.");
    if (!pairing.memberId) throw new Error("Pair the app again before caching capture options.");
    return this.#store.saveOptions(pairingScope(pairing), options);
  }

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
        if (result.status === "cancelled") return;
        onResult(result);
        if ((result.status === "retry_pending" || (result.status === "attention_required" && result.retryPending)) && online) {
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

  cancelRequests(): void {
    const reason = new DOMException("Request cancelled", "AbortError");
    this.#syncController?.abort(reason);
    for (const controller of this.#refreshControllers) controller.abort(reason);
  }

  async refreshOptions(signal?: AbortSignal): Promise<MobileCaptureOptions> {
    const controller = this.#controller(signal);
    this.#refreshControllers.add(controller);
    try {
      const pairing = await this.#store.loadPairing();
      if (!pairing) throw new Error("Pair the app before refreshing capture options.");
      const response = await this.#fetch(`${pairing.instanceUrl}/api/mobile/v1/workspaces/${pairing.workspaceId}/capture-options`, {
        headers: { authorization: `Bearer ${pairing.memberToken}` }, signal: controller.signal,
      });
      const body = await response.json().catch(() => ({})) as MobileCaptureOptions & { memberId?: string; message?: string };
      if (!response.ok) throw new Error(body.message ?? "Capture options could not be refreshed.");
      const options = { projects: body.projects, tags: body.tags, reminders: body.reminders };
      if (!body.memberId || body.memberId !== pairing.memberId) throw new Error("The Member token belongs to a different pairing.");
      await this.#store.saveOptions(pairingScope(pairing), options); return options;
    } finally { this.#refreshControllers.delete(controller); }
  }

  async captureText(content: string, structure: Pick<MobileCapture, "projectId" | "tags" | "reminder"> = {}): Promise<MobileCapture> {
    return this.#enqueue("text", content, undefined, structure);
  }

  async captureChecklist(title: string, items: string[], structure: Pick<MobileCapture, "projectId" | "tags" | "reminder"> = {}): Promise<MobileCapture> {
    if (!items.length || items.some((item) => !item.trim())) throw new Error("A checklist requires at least one non-empty item.");
    return this.#enqueue("checklist", title, items.map((text) => ({ text: text.trim(), checked: false })), structure);
  }

  async captureMedia(
    media: { kind: "photo" | "file" | "voice"; filename: string; contentType: string; base64: string },
    caption = "",
    structure: Pick<MobileCapture, "projectId" | "tags" | "reminder"> = {},
    captureId: string = crypto.randomUUID(),
  ): Promise<MobileCapture> {
    if (!validPortableFilename(media.filename)) throw new Error("The original filename is invalid.");
    const contentType = media.kind === "file" && !supportedAttachmentType.test(media.contentType)
      ? "application/octet-stream" : media.contentType;
    if (!supportedAttachmentType.test(contentType)) {
      throw new Error("The original file type is not supported.");
    }
    if (!validBase64(media.base64)) throw new Error("The original file is empty or invalid.");
    const pairing = await this.#pairingForCapture();
    const capture: MobileCapture = {
      id: requireUuid(captureId), kind: media.kind, content: caption.trim() || media.filename,
      createdAt: new Date().toISOString(), attempts: 0, source: "app",
      origin: { instanceUrl: pairing.instanceUrl, workspaceId: pairing.workspaceId, memberId: pairing.memberId },
      attachment: { filename: media.filename, contentType, base64: media.base64 },
      ...(structure.projectId ? { projectId: structure.projectId } : {}),
      ...(structure.tags ? { tags: structure.tags } : {}), ...(structure.reminder ? { reminder: structure.reminder } : {}),
    };
    await this.#store.saveCapture(capture);
    return capture;
  }

  async captureSharedContent(content: string, source: "share_sheet" | "widget", structure: Pick<MobileCapture, "projectId" | "tags" | "reminder"> = {}, captureId?: string) {
    const capture = await this.#enqueue("text", content, undefined, structure, captureId);
    const sourced = { ...capture, source };
    await this.#store.saveCapture(sourced);
    return sourced;
  }

  async #enqueue(kind: MobileCapture["kind"], content: string, checklist: MobileCapture["checklist"], structure: Pick<MobileCapture, "projectId" | "tags" | "reminder">, captureId: string = crypto.randomUUID()) {
    if (!content.trim()) throw new Error("A capture requires content.");
    const pairing = await this.#pairingForCapture();
    const capture: MobileCapture = {
      id: requireUuid(captureId), kind, content: content.trim(), createdAt: new Date().toISOString(), attempts: 0,
      origin: { instanceUrl: pairing.instanceUrl, workspaceId: pairing.workspaceId, memberId: pairing.memberId },
      ...(checklist ? { checklist } : {}), ...(structure.projectId ? { projectId: structure.projectId } : {}),
      ...(structure.tags ? { tags: structure.tags } : {}), ...(structure.reminder ? { reminder: structure.reminder } : {}),
    };
    await this.#store.saveCapture(capture);
    return capture;
  }

  async #pairingForCapture() {
    const pairing = await this.#store.loadPairing();
    if (!pairing) throw new Error("Pair the app before saving a capture.");
    if (!pairing.memberId) throw new Error("Pair the app again before saving a capture.");
    return pairing as MobileCapturePairing & { memberId: string };
  }

  sync(signal?: AbortSignal): Promise<MobileSyncResult> {
    if (this.#inFlightSync) return this.#inFlightSync;
    const controller = this.#controller(signal);
    this.#syncController = controller;
    const running = this.#performSync(controller).finally(() => {
      if (this.#inFlightSync === running) this.#inFlightSync = undefined;
      if (this.#syncController === controller) this.#syncController = undefined;
    });
    this.#inFlightSync = running;
    return running;
  }

  async #performSync(controller: AbortController): Promise<MobileSyncResult> {
    const pairing = await this.#store.loadPairing();
    if (!pairing) return { status: "attention_required", count: 0, error: "not_paired" };
    if (!pairing.memberId) return { status: "attention_required", count: 0, error: "pairing_identity_unknown" };
    let count = 0;
    let attentionError: string | undefined;
    let retryPending = false;
    const activeMemberId = pairing.memberId;
    for (const capture of await this.#store.listCaptures()) {
      if (capture.origin?.memberId && (capture.origin.instanceUrl !== pairing.instanceUrl
        || capture.origin.workspaceId !== pairing.workspaceId || capture.origin.memberId !== activeMemberId)) continue;
      if (!capture.origin?.memberId) {
        attentionError ??= "capture_origin_unknown";
        continue;
      }
      if (capture.nextRetryAt && Date.parse(capture.nextRetryAt) > this.#now()) { retryPending = true; continue; }
      let response: Response;
      let currentCapture = capture;
      try {
        if (currentCapture.attachment && !currentCapture.attachment.remote) {
          const upload = await this.#fetch(`${pairing.instanceUrl}/api/workspaces/${pairing.workspaceId}/attachments`, {
            method: "POST",
            headers: { authorization: `Bearer ${pairing.memberToken}`, "content-type": currentCapture.attachment.contentType,
              "x-stash-filename": encodePortableFilename(currentCapture.attachment.filename), "x-stash-source": "upload",
              "x-stash-operation-key": currentCapture.id },
            body: decodeBase64(currentCapture.attachment.base64), signal: controller.signal,
          });
          const uploaded = await upload.json().catch(() => ({})) as { id?: string; portableLink?: string; error?: string; message?: string };
          if (!upload.ok || !uploaded.id || !uploaded.portableLink) {
            response = new Response(JSON.stringify(uploaded), { status: upload.status, headers: upload.headers });
            throw new UploadRejected(response);
          }
          currentCapture = { ...currentCapture, attachment: { ...currentCapture.attachment,
            remote: { id: uploaded.id, portableLink: uploaded.portableLink } } };
          await this.#store.saveCapture(currentCapture);
        }
        const noteContent = currentCapture.attachment?.remote
          ? `${currentCapture.content}\n\n${currentCapture.attachment.remote.portableLink}` : currentCapture.content;
        response = await this.#fetch(`${pairing.instanceUrl}/api/mobile/v1/workspaces/${pairing.workspaceId}/captures`, {
          method: "POST",
          headers: { authorization: `Bearer ${pairing.memberToken}`, "content-type": "application/json" },
          body: JSON.stringify(mobileProtocolPayload(currentCapture, noteContent)),
          signal: controller.signal,
        });
      } catch (error) {
        if (error instanceof UploadRejected) response = error.response;
        else {
          if (controller.signal.aborted) return { status: "cancelled", count };
          if (attentionError) return { status: "attention_required", count, error: attentionError, retryPending: true };
          return { status: "offline", count };
        }
      }
      const body = await response.json().catch(() => ({})) as { error?: string; message?: string };
      if (response.ok) {
        await this.#store.removeCapture(capture.id);
        count += 1;
        continue;
      }
      const attempts = currentCapture.attempts + 1;
      const retriable = response.status >= 500 || response.status === 429;
      const { nextRetryAt: _staleRetryAt, ...captureWithoutRetry } = currentCapture;
      const failed = { ...captureWithoutRetry, attempts, lastError: body.message ?? "Synchronization failed.",
        ...(retriable ? { nextRetryAt: new Date(this.#now()
          + retryDelay(response.headers.get("retry-after"), attempts, this.#now())).toISOString() } : {}) };
      await this.#store.saveCapture(failed);
      if (retriable) retryPending = true; else attentionError ??= body.error ?? "sync_rejected";
    }
    return attentionError ? { status: "attention_required", count, error: attentionError,
      ...(retryPending ? { retryPending: true } : {}) }
      : retryPending ? { status: "retry_pending", count } : { status: "synced", count };
  }

  #controller(externalSignal?: AbortSignal): AbortController {
    const controller = new AbortController();
    if (externalSignal?.aborted) controller.abort(externalSignal.reason);
    else externalSignal?.addEventListener("abort", () => controller.abort(externalSignal.reason), { once: true });
    return controller;
  }

  async #legacyCaptures(pairing: MobileCapturePairing): Promise<MobileCapture[]> {
    return (await this.#store.listCaptures()).filter((capture) => !capture.origin
      || (!capture.origin.memberId && capture.origin.instanceUrl === pairing.instanceUrl
        && capture.origin.workspaceId === pairing.workspaceId));
  }
}

class UploadRejected extends Error { constructor(readonly response: Response) { super("upload_rejected"); } }

function mobileProtocolPayload(capture: MobileCapture, content: string) {
  return {
    protocol: "stash.mobile-capture.v1", id: capture.id, kind: capture.kind === "checklist" ? "checklist" : "text",
    content, createdAt: capture.createdAt,
    ...(capture.checklist ? { checklist: capture.checklist } : {}), ...(capture.projectId ? { projectId: capture.projectId } : {}),
    ...(capture.tags ? { tags: capture.tags } : {}), ...(capture.reminder ? { reminder: capture.reminder } : {}),
  };
}

function validPortableFilename(value: string) {
  return Boolean(value && value.length <= 255 && value === value.trim() && !/[\/\\\u0000-\u001f\u007f]/.test(value)
    && !/[. ]$/.test(value) && value !== "." && value !== ".." && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value));
}
const supportedAttachmentType = /^(?:image\/(?:png|jpeg|gif|webp|heic|heif)|audio\/(?:mp4|m4a|mpeg|wav|x-wav|aac|3gpp|ogg)|application\/(?:pdf|octet-stream)|text\/plain)$/;
function validBase64(value: string) {
  if (!value.length || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) return false;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return value.length * 3 / 4 - padding <= 10 * 1024 * 1024;
}

function requireUuid(value: string): string {
  if (!isUuid(value)) throw new Error("Capture delivery ID must be a UUID.");
  return value;
}
function decodeBase64(value: string) { const binary = atob(value); return Uint8Array.from(binary, (character) => character.charCodeAt(0)); }
function encodePortableFilename(value: string) { return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`); }

function emptyOptions(): MobileCaptureOptions { return { projects: [], tags: [], reminders: [] }; }
function pairingScope(pairing: MobileCapturePairing): string { return `${pairing.instanceUrl}\n${pairing.workspaceId}\n${pairing.memberId}`; }

function retryDelay(retryAfter: string | null, attempts: number, now: number): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.max(1_000, seconds * 1_000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(1_000, date - now);
  }
  return Math.min(1_000 * 2 ** Math.max(0, attempts - 1), 60_000);
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

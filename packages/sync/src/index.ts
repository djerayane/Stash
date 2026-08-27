import { createMobileProtocolClient } from "@stash/api-client";
import type {
  IncomingShareDelivery, MobileCapture, MobileCaptureOptions, MobileCapturePairing, MobileSyncMutation,
  MobileSyncResult, NoteEditOperation, TaskPlanningUpdate,
  MobileWorkspaceSnapshot,
} from "@stash/domain-types";
import { normalizeMobileWorkspaceSnapshot } from "@stash/domain-types";
import { canonicalUuid, isUuid, validMobilePairingOrigin, validPortableFilename } from "@stash/validation";

export type {
  IncomingShareDelivery, MobileCapture, MobileCaptureOptions, MobileCapturePairing, MobileSyncMutation,
  MobileSyncResult, NoteEditOperation, RichTextBlock, RichTextMark, RichTextSpan, TaskPlanningUpdate,
} from "@stash/domain-types";

export interface EncryptedMobileCaptureStore {
  loadPairing(): Promise<MobileCapturePairing | undefined>;
  savePairing(pairing: MobileCapturePairing): Promise<void>;
  listCaptures(): Promise<MobileCapture[]>;
  saveCapture(capture: MobileCapture): Promise<void>;
  removeCapture(id: string): Promise<void>;
  listMutations(): Promise<MobileSyncMutation[]>;
  saveMutation(mutation: MobileSyncMutation): Promise<void>;
  removeMutation(mutation: Pick<MobileSyncMutation, "id" | "origin">): Promise<void>;
  loadOptions(scope: string): Promise<MobileCaptureOptions>;
  saveOptions(scope: string, options: MobileCaptureOptions): Promise<void>;
  stageIncomingShares(fingerprint: string, deliveries: IncomingShareDelivery[]): Promise<IncomingShareDelivery[]>;
  acknowledgeNativeShares(fingerprint?: string): Promise<void>;
  listIncomingShares(): Promise<IncomingShareDelivery[]>;
  removeIncomingShare(id: string): Promise<void>;
  saveIncomingShare(delivery: IncomingShareDelivery): Promise<void>;
  loadWorkspaceSnapshot?(scope: string): Promise<MobileWorkspaceSnapshot | undefined>;
  saveWorkspaceSnapshot?(scope: string, snapshot: MobileWorkspaceSnapshot): Promise<void>;
}

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

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
    if (!validMobilePairingOrigin(pairing.instanceUrl, this.#allowInsecureInstanceForTest)) {
      throw new Error("Instance URL must be a valid HTTPS origin.");
    }
    const url = new URL(pairing.instanceUrl);
    if (!pairing.memberToken.trim() || !isUuid(pairing.workspaceId)) throw new Error("Pairing requires a Member token and Workspace.");
    const controller = this.#controller(signal);
    this.#refreshControllers.add(controller);
    try {
      const response = await createMobileProtocolClient({ instanceUrl: url.origin, memberToken: pairing.memberToken,
        fetch: this.#fetch }).captureOptions(pairing.workspaceId, controller.signal);
      const body = await response.json().catch(() => ({})) as MobileCaptureOptions & { memberId?: string; message?: string };
      if (!response.ok || !body.memberId) throw new Error(body.message ?? "The Member pairing could not be authenticated.");
      const previous = await this.#store.loadPairing();
      const authenticated = { ...pairing, instanceUrl: url.origin, workspaceId: canonicalUuid(pairing.workspaceId),
        memberId: canonicalUuid(body.memberId) };
      const preservesLegacyIdentity = previous && sameDestination(previous, authenticated)
        && previous.memberToken === authenticated.memberToken;
      const replacingLegacy = previous && !previous.memberId && !preservesLegacyIdentity
        && (await this.#legacyCaptures(previous)).length > 0;
      if (replacingLegacy && (!options.replaceLegacy || !acknowledgedLegacyExport)) throw new LegacyRecoveryRequired();
      if (previous && sameDestination(previous, authenticated) && previous.memberToken === authenticated.memberToken) {
        for (const capture of await this.#store.listCaptures()) {
          if (!capture.origin || (!capture.origin.memberId && sameDestination(capture.origin, authenticated))) {
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
    return (await this.#store.listCaptures()).filter((capture) => capture.origin && samePairingIdentity(capture.origin, pairing));
  }
  async pendingMutations() {
    const pairing = await this.#store.loadPairing();
    if (!pairing?.memberId) return [];
    return (await this.#store.listMutations()).filter((mutation) => samePairingIdentity(mutation.origin, pairing));
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
      const response = await createMobileProtocolClient({ instanceUrl: pairing.instanceUrl, memberToken: pairing.memberToken,
        fetch: this.#fetch }).captureOptions(pairing.workspaceId, controller.signal);
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

  async queueNoteEdit(noteId: string, baseRevision: number, operations: NoteEditOperation[], mutationId = crypto.randomUUID()) {
    if (!isUuid(noteId) || !Number.isSafeInteger(baseRevision) || baseRevision < 1 || !operations.length
      || operations.some(({ id }) => !isUuid(id))) throw new Error("A mobile Note edit requires a valid Note, revision, and operations.");
    const pairing = await this.#pairingForCapture();
    const mutation: MobileSyncMutation = { id: canonicalUuid(requireUuid(mutationId)), kind: "note_edit",
      noteId: canonicalUuid(noteId), baseRevision, operations: operations.map(canonicalNoteOperation),
      attempts: 0, origin: pairingOrigin(pairing) };
    await this.#store.saveMutation(mutation);
    return mutation;
  }

  async queueTaskEdit(projectId: string, taskKey: string, baseRevision: number, changes: TaskPlanningUpdate,
    mutationId = crypto.randomUUID()) {
    if (!isUuid(projectId) || !/^[A-Za-z][A-Za-z0-9-]{1,19}-[1-9][0-9]*$/.test(taskKey)
      || !Number.isSafeInteger(baseRevision) || baseRevision < 1 || !changes || typeof changes !== "object"
      || Array.isArray(changes) || !Object.keys(changes).length) throw new Error("A mobile Task edit requires a valid Task, revision, and changes.");
    const pairing = await this.#pairingForCapture();
    const mutation: MobileSyncMutation = { id: canonicalUuid(requireUuid(mutationId)), kind: "task_edit",
      projectId: canonicalUuid(projectId), taskKey: taskKey.toUpperCase(), baseRevision,
      changes: canonicalTaskChanges(changes), attempts: 0, origin: pairingOrigin(pairing) };
    await this.#store.saveMutation(mutation);
    return mutation;
  }

  async queueCanonicalTaskEdit(taskId: string, baseRevision: number, changes: TaskPlanningUpdate,
    mutationId = crypto.randomUUID()) {
    if (!isUuid(taskId) || !Number.isSafeInteger(baseRevision) || baseRevision < 1 || !changes || typeof changes !== "object"
      || Array.isArray(changes) || !Object.keys(changes).length) throw new Error("A mobile Task edit requires a valid canonical Task, revision, and changes.");
    const pairing = await this.#pairingForCapture();
    const mutation: MobileSyncMutation = { id: canonicalUuid(requireUuid(mutationId)), kind: "canonical_task_edit",
      taskId: canonicalUuid(taskId), baseRevision, changes: canonicalTaskChanges(changes), attempts: 0,
      origin: pairingOrigin(pairing) };
    await this.#store.saveMutation(mutation); return mutation;
  }

  async cachedWorkspace(): Promise<MobileWorkspaceSnapshot | undefined> {
    const pairing = await this.#store.loadPairing();
    if (!pairing?.memberId || !this.#store.loadWorkspaceSnapshot) return undefined;
    const snapshot = await this.#store.loadWorkspaceSnapshot(pairingScope(pairing));
    if (!snapshot) return undefined;
    const pending = (await this.#store.listMutations()).filter((mutation): mutation is Extract<MobileSyncMutation,
      { kind: "canonical_task_edit" }> => mutation.kind === "canonical_task_edit" && samePairingIdentity(mutation.origin, pairing));
    return pending.reduce((current, mutation) => ({ ...current, tasks: current.tasks.map((task) => {
      if (task.id !== mutation.taskId) return task;
      const status = mutation.changes.statusId
        ? current.workflow.statuses.find(({ id }) => id === mutation.changes.statusId) ?? task.status : task.status;
      return { ...task, status,
        ...(mutation.changes.title !== undefined ? { title: mutation.changes.title } : {}),
        ...(mutation.changes.assigneeIds !== undefined ? { assigneeIds: [...mutation.changes.assigneeIds] } : {}) };
    }) }), structuredClone(snapshot));
  }

  async refreshWorkspace(signal?: AbortSignal): Promise<MobileWorkspaceSnapshot> {
    const pairing = await this.#pairingForCapture();
    if (!this.#store.saveWorkspaceSnapshot) throw new Error("This store does not support offline workspace reads.");
    const controller = this.#controller(signal); this.#refreshControllers.add(controller);
    try {
      const protocol = createMobileProtocolClient({ instanceUrl: pairing.instanceUrl, memberToken: pairing.memberToken, fetch: this.#fetch });
      const [treeResponse, taskResponse] = await Promise.all([
        protocol.noteTree(pairing.workspaceId, controller.signal), protocol.canonicalTasks(pairing.workspaceId, controller.signal),
      ]);
      const treeBody = await responseJson(treeResponse); const taskBody = await responseJson(taskResponse);
      const noteTree = requiredArray(treeBody.nodes, "Note Tree");
      const noteBodies = await Promise.all(noteTree.map(async (node: any) => responseJson(await protocol.note(String(node.id), controller.signal))));
      const collectionBodies = await Promise.all(noteTree.map(async (node: any) => responseJson(await protocol.noteCollections(String(node.id), controller.signal))));
      const notes = noteBodies.map((body: any) => { const note = body.note ?? body; return { id: note.id, workspaceId: note.workspaceId,
        title: note.title ?? note.content?.split("\n")[0] ?? "Untitled", content: note.content, revision: note.revision,
        ...(note.document ? { document: note.document } : {}) }; });
      const collections = collectionBodies.flatMap((body: any) => requiredArray(body.collections, "Collections"));
      const viewBlocks = collectionBodies.flatMap((body: any) => requiredArray(body.views, "View Blocks"));
      const tasks = requiredArray(taskBody.tasks, "Tasks").map((task: any) => ({ schema: task.schema, id: task.id,
        workspaceId: task.workspaceId, title: task.title, description: task.description ?? "", status: task.status,
        assigneeIds: task.assigneeIds ?? [], projectKeys: task.projectKeys ?? [], sourceNoteIds: task.sourceNoteIds ?? [],
        ...(task.revision === undefined ? {} : { revision: task.revision }) })); const workflow = taskBody.workflow;
      if (!workflow || typeof workflow !== "object") throw new Error("Workspace refresh returned an invalid Workflow.");
      const snapshot = normalizeMobileWorkspaceSnapshot({ schema: "stash.mobile-workspace.v1", workspaceId: pairing.workspaceId,
        refreshedAt: new Date(this.#now()).toISOString(), noteTree, notes, tasks, workflow, collections, viewBlocks,
        search: [...notes.map((note: any) => ({ id: String(note.id), kind: "note" as const, title: String(note.title ?? note.content?.split("\n")[0] ?? "Untitled"), excerpt: String(note.content ?? "").slice(0, 240) })),
          ...tasks.map((task: any) => ({ id: String(task.id), kind: "task" as const, title: String(task.title), excerpt: String(task.description ?? "").slice(0, 240) })),
          ...collections.map((collection: any) => ({ id: String(collection.id), kind: "collection" as const, title: String(collection.title) }))] });
      await this.#store.saveWorkspaceSnapshot(pairingScope(pairing), snapshot); return snapshot;
    } finally { this.#refreshControllers.delete(controller); }
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
    const protocol = createMobileProtocolClient({ instanceUrl: pairing.instanceUrl, memberToken: pairing.memberToken,
      fetch: this.#fetch });
    let count = 0;
    let attentionError: string | undefined;
    let retryPending = false;
    for (const capture of await this.#store.listCaptures()) {
      if (capture.origin?.memberId && !samePairingIdentity(capture.origin, pairing)) continue;
      if (!capture.origin?.memberId) {
        attentionError ??= "capture_origin_unknown";
        continue;
      }
      if (capture.nextRetryAt && Date.parse(capture.nextRetryAt) > this.#now()) { retryPending = true; continue; }
      let response: Response;
      let currentCapture = capture;
      try {
        if (currentCapture.attachment && !currentCapture.attachment.remote) {
          const upload = await protocol.uploadAttachment(pairing.workspaceId, {
            captureId: currentCapture.id, filename: currentCapture.attachment.filename,
            contentType: currentCapture.attachment.contentType, body: decodeBase64(currentCapture.attachment.base64),
          }, controller.signal);
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
        response = await protocol.createCapture(pairing.workspaceId,
          mobileProtocolPayload(currentCapture, noteContent), controller.signal);
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
    for (const mutation of await this.#store.listMutations()) {
      if (!samePairingIdentity(mutation.origin, pairing)) continue;
      if (mutation.nextRetryAt && Date.parse(mutation.nextRetryAt) > this.#now()) { retryPending = true; continue; }
      let response: Response;
      try {
        response = mutation.kind === "note_edit"
          ? await protocol.applyNoteEdit(mutation.noteId,
            { baseRevision: mutation.baseRevision, operations: mutation.operations }, controller.signal)
          : mutation.kind === "canonical_task_edit"
            ? await protocol.applyCanonicalTaskEdit(mutation.taskId,
              { operationId: mutation.id, baseRevision: mutation.baseRevision, changes: mutation.changes }, controller.signal)
          : await protocol.applyTaskEdit(mutation.projectId, mutation.taskKey,
            { operationId: mutation.id, baseRevision: mutation.baseRevision, changes: mutation.changes }, controller.signal);
      } catch {
        if (controller.signal.aborted) return { status: "cancelled", count };
        if (attentionError) return { status: "attention_required", count, error: attentionError, retryPending: true };
        return { status: "offline", count };
      }
      const body = await response.json().catch(() => ({})) as { error?: string; message?: string };
      const preservedConflict = response.status === 409 && (body.error === "revision_conflict" || body.error === "task_edit_conflict");
      if (response.ok || preservedConflict) {
        await this.#store.removeMutation(mutation);
        count += 1;
        if (preservedConflict) attentionError ??= "conflicts_preserved";
        continue;
      }
      const attempts = mutation.attempts + 1;
      const retriable = response.status >= 500 || response.status === 429;
      const { nextRetryAt: _staleRetryAt, ...mutationWithoutRetry } = mutation;
      await this.#store.saveMutation({ ...mutationWithoutRetry, attempts, lastError: body.message ?? "Synchronization failed.",
        ...(retriable ? { nextRetryAt: new Date(this.#now()
          + retryDelay(response.headers.get("retry-after"), attempts, this.#now())).toISOString() } : {}) });
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
      || (!capture.origin.memberId && sameDestination(capture.origin, pairing)));
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

function emptyOptions(): MobileCaptureOptions { return { projects: [], tags: [], reminders: [] }; }
function pairingScope(pairing: MobileCapturePairing): string {
  return `${new URL(pairing.instanceUrl).origin}\n${canonicalUuid(pairing.workspaceId)}\n${pairing.memberId ? canonicalUuid(pairing.memberId) : ""}`;
}
function pairingOrigin(pairing: MobileCapturePairing & { memberId: string }) {
  return { instanceUrl: new URL(pairing.instanceUrl).origin, workspaceId: canonicalUuid(pairing.workspaceId),
    memberId: canonicalUuid(pairing.memberId) };
}

function sameDestination(left: Pick<MobileCapturePairing, "instanceUrl" | "workspaceId">,
  right: Pick<MobileCapturePairing, "instanceUrl" | "workspaceId">) {
  return new URL(left.instanceUrl).origin === new URL(right.instanceUrl).origin
    && canonicalUuid(left.workspaceId) === canonicalUuid(right.workspaceId);
}
function samePairingIdentity(left: Pick<MobileCapturePairing, "instanceUrl" | "workspaceId" | "memberId">,
  right: Pick<MobileCapturePairing, "instanceUrl" | "workspaceId" | "memberId">) {
  return sameDestination(left, right) && Boolean(left.memberId && right.memberId)
    && canonicalUuid(left.memberId!) === canonicalUuid(right.memberId!);
}
function canonicalNoteOperation(operation: NoteEditOperation): NoteEditOperation {
  const normalized = structuredClone(operation);
  normalized.id = canonicalUuid(normalized.id); normalized.blockKey = canonicalUuid(normalized.blockKey);
  if (normalized.type === "insert_block" && normalized.afterBlockKey) normalized.afterBlockKey = canonicalUuid(normalized.afterBlockKey);
  if (normalized.type !== "delete_block") {
    if (normalized.block.blockKey) normalized.block.blockKey = canonicalUuid(normalized.block.blockKey);
    if (normalized.block.id) normalized.block.id = canonicalUuid(normalized.block.id);
  }
  return normalized;
}
function canonicalTaskChanges(changes: TaskPlanningUpdate): TaskPlanningUpdate {
  const normalized = structuredClone(changes);
  if (normalized.statusId) normalized.statusId = canonicalUuid(normalized.statusId);
  if (normalized.assigneeIds) normalized.assigneeIds = normalized.assigneeIds.map(canonicalUuid);
  if (normalized.linkedNoteIds) normalized.linkedNoteIds = normalized.linkedNoteIds.map(canonicalUuid);
  if (normalized.dependencies) normalized.dependencies = normalized.dependencies.map((dependency) => ({ ...dependency,
    taskId: canonicalUuid(dependency.taskId) }));
  return normalized;
}

function retryDelay(retryAfter: string | null, attempts: number, now: number): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.max(1_000, seconds * 1_000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(1_000, date - now);
  }
  return Math.min(1_000 * 2 ** Math.max(0, attempts - 1), 60_000);
}

async function responseJson(response: Response): Promise<any> {
  const body = await response.json().catch(() => undefined) as any;
  if (!response.ok) throw new Error(typeof body?.message === "string" ? body.message : `Workspace refresh failed with ${response.status}.`);
  return body;
}
function requiredArray(value: unknown, label: string): any[] {
  if (!Array.isArray(value)) throw new Error(`Workspace refresh returned invalid ${label}.`); return value;
}

export { isUuid } from "@stash/validation";

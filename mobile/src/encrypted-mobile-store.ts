import type { EncryptedMobileCaptureStore, IncomingShareDelivery, MobileCapture, MobileCaptureOptions, MobileCapturePairing, MobileSyncMutation } from "../../src/mobile-capture-client";

export interface MobileCipher { encrypt(plaintext: string): Promise<string>; decrypt(ciphertext: string): Promise<string> }
export interface CiphertextStateRepository { read(key: string): Promise<string | undefined>; write(key: string, ciphertext: string): Promise<void> }
const pairingKey = "pairing"; const outboxKey = "outbox"; const optionsKey = "options";
const incomingSharesKey = "incoming-shares";
const mutationOutboxKey = "mutation-outbox";
type IncomingShareState = { pending: IncomingShareDelivery[]; native?: { fingerprint: string; ids: string[] } };

export class EncryptedStateMobileCaptureStore implements EncryptedMobileCaptureStore {
  #writeBarrier: Promise<void> = Promise.resolve();
  constructor(readonly repository: CiphertextStateRepository, readonly cipher: MobileCipher) {}
  loadPairing() { return this.#read<MobileCapturePairing | undefined>(pairingKey, undefined); }
  savePairing(pairing: MobileCapturePairing) { return this.#write(pairingKey, pairing); }
  async listCaptures() { await this.#writeBarrier; return this.#read<MobileCapture[]>(outboxKey, []); }
  async saveCapture(capture: MobileCapture) { await this.#mutate((items) => [...items.filter(({ id }) => id !== capture.id), capture]); }
  async removeCapture(id: string) { await this.#mutate((items) => items.filter((capture) => capture.id !== id)); }
  async listMutations() { await this.#writeBarrier; return this.#read<MobileSyncMutation[]>(mutationOutboxKey, []); }
  async saveMutation(mutation: MobileSyncMutation) {
    await this.#mutateMutations((items) => {
      const key = mutationKey(mutation);
      const existing = items.find((item) => mutationKey(item) === key);
      if (existing && mutationContribution(existing) !== mutationContribution(mutation)) {
        throw new Error("This mobile synchronization identity is already used for a different contribution.");
      }
      return [...items.filter((item) => mutationKey(item) !== key), mutation];
    });
  }
  async removeMutation(mutation: Pick<MobileSyncMutation, "id" | "origin">) {
    await this.#mutateMutations((items) => items.filter((item) => mutationKey(item) !== mutationKey(mutation)));
  }
  async loadOptions(scope: string) {
    await this.#writeBarrier;
    return (await this.#read<Record<string, MobileCaptureOptions>>(optionsKey, {}))[scope]
      ?? { projects: [], tags: [], reminders: [] };
  }
  async saveOptions(scope: string, options: MobileCaptureOptions) {
    const write = this.#writeBarrier.then(async () => {
      const scoped = await this.#read<Record<string, MobileCaptureOptions>>(optionsKey, {});
      await this.#write(optionsKey, { ...scoped, [scope]: options });
    });
    this.#writeBarrier = write.catch(() => undefined); await write;
  }
  async stageIncomingShares(fingerprint: string, deliveries: IncomingShareDelivery[]) {
    return this.#mutateIncoming((state) => {
      if (state.native?.fingerprint === fingerprint) return state;
      return { pending: [...state.pending, ...deliveries], native: { fingerprint, ids: deliveries.map(({ id }) => id) } };
    }).then((state) => state.native?.fingerprint === fingerprint
      ? state.pending.filter(({ id }) => state.native!.ids.includes(id)) : deliveries);
  }
  async acknowledgeNativeShares(fingerprint?: string) {
    await this.#mutateIncoming((state) => !fingerprint || state.native?.fingerprint === fingerprint ? { pending: state.pending } : state);
  }
  async listIncomingShares() { await this.#writeBarrier; return (await this.#read<IncomingShareState>(incomingSharesKey, { pending: [] })).pending; }
  async removeIncomingShare(id: string) { await this.#mutateIncoming((state) => ({ ...state, pending: state.pending.filter((item) => item.id !== id) })); }
  async saveIncomingShare(delivery: IncomingShareDelivery) {
    await this.#mutateIncoming((state) => ({ ...state,
      pending: [...state.pending.filter(({ id }) => id !== delivery.id), delivery] }));
  }
  async #read<T>(key: string, fallback: T): Promise<T> {
    const ciphertext = await this.repository.read(key);
    return ciphertext ? JSON.parse(await this.cipher.decrypt(ciphertext)) as T : fallback;
  }
  async #write(key: string, value: unknown) { await this.repository.write(key, await this.cipher.encrypt(JSON.stringify(value))); }
  async #mutate(change: (captures: MobileCapture[]) => MobileCapture[]) {
    const write = this.#writeBarrier.then(async () => this.#write(outboxKey, change(await this.#read(outboxKey, []))));
    this.#writeBarrier = write.catch(() => undefined); await write;
  }
  async #mutateMutations(change: (mutations: MobileSyncMutation[]) => MobileSyncMutation[]) {
    const write = this.#writeBarrier.then(async () => this.#write(mutationOutboxKey, change(await this.#read(mutationOutboxKey, []))));
    this.#writeBarrier = write.catch(() => undefined); await write;
  }
  async #mutateIncoming(change: (state: IncomingShareState) => IncomingShareState) {
    let result: IncomingShareState = { pending: [] };
    const write = this.#writeBarrier.then(async () => {
      result = change(await this.#read(incomingSharesKey, { pending: [] }));
      await this.#write(incomingSharesKey, result);
    });
    this.#writeBarrier = write.catch(() => undefined); await write; return result;
  }
}

function mutationKey(mutation: Pick<MobileSyncMutation, "id" | "origin">) {
  return `${new URL(mutation.origin.instanceUrl).origin}\n${canonicalUuid(mutation.origin.workspaceId)}\n${canonicalUuid(mutation.origin.memberId)}\n${canonicalUuid(mutation.id)}`;
}

function mutationContribution(mutation: MobileSyncMutation) {
  const { attempts: _, nextRetryAt: __, lastError: ___, ...contribution } = mutation;
  const canonical = contribution.kind === "note_edit" ? { ...contribution, id: canonicalUuid(contribution.id),
    noteId: canonicalUuid(contribution.noteId), operations: contribution.operations.map((operation) => {
      const normalized = { ...operation, id: canonicalUuid(operation.id), blockKey: canonicalUuid(operation.blockKey) };
      if (normalized.type === "insert_block" && normalized.afterBlockKey) normalized.afterBlockKey = canonicalUuid(normalized.afterBlockKey);
      if (normalized.type !== "delete_block") normalized.block = { ...normalized.block,
        ...(normalized.block.blockKey ? { blockKey: canonicalUuid(normalized.block.blockKey) } : {}),
        ...(normalized.block.id ? { id: canonicalUuid(normalized.block.id) } : {}) };
      return normalized;
    }) }
    : { ...contribution, id: canonicalUuid(contribution.id), projectId: canonicalUuid(contribution.projectId),
      changes: canonicalTaskChanges(contribution.changes) };
  return JSON.stringify(canonicalJson({ ...canonical, origin: { ...canonical.origin,
    instanceUrl: new URL(canonical.origin.instanceUrl).origin, workspaceId: canonicalUuid(canonical.origin.workspaceId),
    memberId: canonicalUuid(canonical.origin.memberId) } }));
}

function canonicalUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value.toLowerCase() : value;
}
function canonicalTaskChanges(changes: Extract<MobileSyncMutation, { kind: "task_edit" }>["changes"]) {
  return { ...changes,
    ...(changes.statusId ? { statusId: canonicalUuid(changes.statusId) } : {}),
    ...(changes.assigneeIds ? { assigneeIds: changes.assigneeIds.map(canonicalUuid) } : {}),
    ...(changes.linkedNoteIds ? { linkedNoteIds: changes.linkedNoteIds.map(canonicalUuid) } : {}),
    ...(changes.dependencies ? { dependencies: changes.dependencies.map((dependency) => ({ ...dependency,
      taskId: canonicalUuid(dependency.taskId) })) } : {}) };
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right)).map(([key, nested]) => [key, canonicalJson(nested)]));
  return value;
}

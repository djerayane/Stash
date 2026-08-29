import type { MobileSyncMutation } from "@stash/domain-types";
import { describe, expect, it } from "vitest";

import {
  EncryptedStateMobileCaptureStore,
  type CiphertextStateRepository,
  type MobileCipher,
} from "./encrypted-mobile-store";

const origin = {
  instanceUrl: "https://stash.example",
  workspaceId: "11111111-1111-4111-8111-111111111111",
  memberId: "22222222-2222-4222-8222-222222222222",
};
const firstMutation: MobileSyncMutation = {
  id: "33333333-3333-4333-8333-333333333333",
  kind: "canonical_task_edit",
  taskId: "44444444-4444-4444-8444-444444444444",
  baseRevision: 1,
  changes: { title: "First" },
  attempts: 0,
  origin,
};
const secondMutation: MobileSyncMutation = {
  id: "55555555-5555-4555-8555-555555555555",
  kind: "canonical_task_edit",
  taskId: "66666666-6666-4666-8666-666666666666",
  baseRevision: 1,
  changes: { title: "Second" },
  attempts: 0,
  origin,
};

const identityCipher: MobileCipher = {
  async encrypt(value) { return value; },
  async decrypt(value) { return value; },
};

class DelayedSharedRepository implements CiphertextStateRepository {
  readonly state = new Map<string, string>([["mutation-outbox", JSON.stringify([firstMutation])]]);

  async read(key: string) { return this.state.get(key); }
  async write(key: string, ciphertext: string) {
    // Make the stale append finish last when two independent store barriers race.
    await new Promise((resolve) => setTimeout(resolve, ciphertext.includes(secondMutation.id) ? 20 : 1));
    this.state.set(key, ciphertext);
  }
}

describe("encrypted mobile state write serialization", () => {
  it("does not lose an update across independent stores sharing one repository", async () => {
    const repository = new DelayedSharedRepository();
    const first = new EncryptedStateMobileCaptureStore(repository, identityCipher);
    const second = new EncryptedStateMobileCaptureStore(repository, identityCipher);

    await Promise.all([
      first.removeMutation(firstMutation),
      second.saveMutation(secondMutation),
    ]);

    await expect(second.listMutations()).resolves.toEqual([secondMutation]);
  });

  it("persists permanent Collection rejection as mutable recovery metadata", async () => {
    const repository = new DelayedSharedRepository();
    const store = new EncryptedStateMobileCaptureStore(repository, identityCipher);
    const mutation: MobileSyncMutation = { id: "77777777-7777-4777-8777-777777777777", kind: "collection_record_edit",
      collectionId: "88888888-8888-4888-8888-888888888888", recordId: "99999999-9999-4999-8999-999999999999",
      baseRevision: 1, values: { "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa": "Draft" }, attempts: 0, origin };
    await store.saveMutation(mutation);
    await expect(store.saveMutation({ ...mutation, attempts: 1, permanentFailure: true,
      lastError: "This record is unavailable." })).resolves.toBeUndefined();
    await expect(store.listMutations()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: mutation.id, permanentFailure: true, attempts: 1 }),
    ]));
  });
});

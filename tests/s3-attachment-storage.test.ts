import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand } from "@aws-sdk/client-s3";

import type { AttachmentStorage } from "../src/attachments.js";
import { PostgresLocalInstanceBackupSource, PostgresLocalInstanceRestoreTarget } from "../src/instance-backup-system.js";
import { UnsafeAttachmentRollbackError } from "../src/instance-backup.js";
import { S3AttachmentStorage, s3AttachmentStorageFromEnvironment } from "../src/s3-attachment-storage.js";

class S3ProtocolFake {
  readonly objects = new Map<string, Buffer>();
  failPutFor?: string;
  readonly failPutKeys = new Set<string>();
  omitContentLength = false;
  destroyedBodies = 0;
  async send(command: object): Promise<any> {
    if (command instanceof PutObjectCommand) {
      const key = command.input.Key!;
      if (key === this.failPutFor || this.failPutKeys.has(key)) throw new Error("provider unavailable");
      this.objects.set(key, Buffer.from(command.input.Body as Uint8Array));
      return {};
    }
    if (command instanceof GetObjectCommand) {
      const content = this.objects.get(command.input.Key!);
      if (!content) throw new Error("NoSuchKey");
      const protocol = this;
      return { ...(this.omitContentLength ? {} : { ContentLength: content.length }), Body: {
        async *[Symbol.asyncIterator]() { for (let offset = 0; offset < content.length; offset += 2) yield content.subarray(offset, offset + 2); },
        destroy() { protocol.destroyedBodies += 1; },
      } };
    }
    if (command instanceof DeleteObjectCommand) { this.objects.delete(command.input.Key!); return {}; }
    if (command instanceof ListObjectsV2Command) {
      const keys = [...this.objects.keys()].filter((key) => key.startsWith(command.input.Prefix ?? "")).sort();
      const offset = Number(command.input.ContinuationToken ?? "0");
      return { Contents: keys.slice(offset, offset + 1).map((Key) => ({ Key })), IsTruncated: offset + 1 < keys.length,
        NextContinuationToken: offset + 1 < keys.length ? String(offset + 1) : undefined };
    }
    throw new Error("unexpected command");
  }
}

describe("S3-compatible Attachment storage", () => {
  it("stores, retrieves, lists, bounds, and deletes Attachment bytes through the S3 protocol", async () => {
    const protocol = new S3ProtocolFake();
    const storage = new S3AttachmentStorage({ bucket: "stash-attachments", prefix: "production", client: protocol });
    const first = "11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
    const second = "11111111-1111-4111-8111-111111111111/33333333-3333-4333-8333-333333333333";
    await storage.put(second, Buffer.from("second")); await storage.put(first, Buffer.from("first"));
    assert.deepEqual(await storage.listKeys(), [first, second]);
    assert.deepEqual(await storage.get(first), Buffer.from("first"));
    await assert.rejects(() => storage.getBounded(first, 4), /attachment_size_limit/);
    await storage.delete(first); assert.equal(protocol.objects.has(`production/${first}`), false);
  });

  it("requires complete, safe operator configuration and otherwise retains the local default", () => {
    assert.equal(s3AttachmentStorageFromEnvironment({}), undefined);
    assert.throws(() => s3AttachmentStorageFromEnvironment({ S3_BUCKET: "stash-attachments" }), /S3_ENDPOINT.*must be configured/);
    assert.throws(() => s3AttachmentStorageFromEnvironment({ S3_ENDPOINT: "https://user:secret@example.test", S3_REGION: "eu-west-1",
      S3_BUCKET: "stash-attachments", S3_ACCESS_KEY_ID: "key", S3_SECRET_ACCESS_KEY: "secret" }), /without credentials/);
    assert.ok(s3AttachmentStorageFromEnvironment({ S3_ENDPOINT: "https://objects.example.test", S3_REGION: "eu-west-1",
      S3_BUCKET: "stash-attachments", S3_ACCESS_KEY_ID: "key", S3_SECRET_ACCESS_KEY: "secret" }));
  });

  it("stops and cancels an oversized stream when the provider omits Content-Length", async () => {
    const protocol = new S3ProtocolFake(); protocol.omitContentLength = true;
    const storage = new S3AttachmentStorage({ bucket: "stash-attachments", client: protocol });
    const key = "11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
    await storage.put(key, Buffer.from("oversized remote body"));
    await assert.rejects(() => storage.getBounded(key, 3), /attachment_size_limit/);
    assert.equal(protocol.destroyedBodies, 1);
  });

  it("includes remote objects in coordinated backups and restores them with rollback on provider failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "stash-s3-backup-"));
    try {
      const protocol = new S3ProtocolFake(); const storage = new S3AttachmentStorage({ bucket: "stash-attachments", client: protocol });
      const oldKey = "11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
      const newKey = "11111111-1111-4111-8111-111111111111/33333333-3333-4333-8333-333333333333";
      await storage.put(oldKey, Buffer.from("old"));
      const source = new PostgresLocalInstanceBackupSource({ databaseUrl: "postgres://localhost/stash", attachmentRoot: join(root, "unused"),
        attachmentStorage: storage, attachmentStorageKind: "s3", publicOrigin: "https://stash.example" });
      const captured = join(root, "captured"); assert.deepEqual(await source.captureAttachments(captured), [oldKey]);
      assert.deepEqual(await readFile(join(captured, ...oldKey.split("/"))), Buffer.from("old"));
      assert.equal((await source.captureConfiguration()).attachmentStorage, "s3");

      const verified = join(root, "verified"); await mkdir(dirname(join(verified, ...newKey.split("/"))), { recursive: true });
      await writeFile(join(verified, ...newKey.split("/")), "new");
      const target = new PostgresLocalInstanceRestoreTarget({ databaseUrl: "postgres://localhost/stash", attachmentRoot: join(root, "staging"),
        attachmentStorage: storage, attachmentStorageKind: "s3", publicOrigin: "https://stash.example" });
      await target.validateConfiguration({ attachmentStorage: "s3", masterKeyRequired: true, publicOrigin: "https://stash.example" });
      const prepared = await target.prepareAttachments(verified, [newKey]); protocol.failPutFor = newKey;
      await assert.rejects(() => target.commitAttachments(prepared), /provider unavailable/);
      assert.deepEqual(await storage.get(oldKey), Buffer.from("old")); assert.deepEqual(await storage.listKeys(), [oldKey]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("marks a remote restore unsafe when applying and rolling back both fail", async () => {
    const root = await mkdtemp(join(tmpdir(), "stash-s3-unsafe-"));
    try {
      const protocol = new S3ProtocolFake(); const storage = new S3AttachmentStorage({ bucket: "stash-attachments", client: protocol });
      const oldKey = "11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
      const newKey = "11111111-1111-4111-8111-111111111111/33333333-3333-4333-8333-333333333333";
      await storage.put(oldKey, Buffer.from("old"));
      const verified = join(root, "verified"); await mkdir(dirname(join(verified, ...newKey.split("/"))), { recursive: true });
      await writeFile(join(verified, ...newKey.split("/")), "new");
      const target = new PostgresLocalInstanceRestoreTarget({ databaseUrl: "postgres://localhost/stash", attachmentRoot: join(root, "staging"),
        attachmentStorage: storage, attachmentStorageKind: "s3", publicOrigin: "https://stash.example" });
      const prepared = await target.prepareAttachments(verified, [newKey]); protocol.failPutKeys.add(newKey); protocol.failPutKeys.add(oldKey);
      await assert.rejects(() => target.commitAttachments(prepared), UnsafeAttachmentRollbackError);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

export const instanceBackupSchema = "stash.instance-backup.v1" as const;

export interface InstanceBackupSource {
  /** A transactionally consistent representation containing all PostgreSQL state. */
  captureDatabase(destination: string): Promise<void>;
  /** Attachment keys are immutable once committed, so copying after the DB snapshot is safe. */
  captureAttachments(destination: string): Promise<ReadonlyArray<string>>;
  /** Only non-secret runtime configuration belongs here. */
  captureConfiguration(): Promise<Record<string, string | number | boolean | null>>;
}
export interface InstanceBackupRestoreTarget {
  validateConfiguration(configuration: Record<string, unknown>): Promise<void>;
  restoreDatabase(source: string): Promise<void>;
  restoreAttachments(source: string): Promise<void>;
}

interface BackupFile { path: string; bytes: number; sha256: string; kind: "database" | "attachment" | "configuration" }
interface BackupManifest {
  schema: typeof instanceBackupSchema;
  createdAt: string;
  instanceVersion: string;
  consistency: "coordinated";
  database: { format: "postgresql-custom"; path: "database.dump" };
  masterKey: { required: true; verification: string; included: false };
  files: BackupFile[];
}
export type BackupHealth =
  | { status: "never_created" }
  | { status: "failed"; error: "backup_failed" }
  | { status: "unverified"; createdAt: string; schema: typeof instanceBackupSchema }
  | { status: "verified"; createdAt: string; verifiedAt: string; schema: typeof instanceBackupSchema };

async function fileIntegrity(path: string): Promise<{ bytes: number; sha256: string }> {
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error("Instance Backup payload must contain regular files only");
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk as Buffer);
  return { bytes: metadata.size, sha256: digest.digest("hex") };
}
function stableJson(value: unknown): string { return `${JSON.stringify(value, Object.keys(value as object).sort(), 2)}\n`; }
function keyVerification(key: Buffer): string {
  return createHmac("sha256", key).update("stash-instance-backup-master-key-v1").digest("hex");
}
function parseMasterKey(encoded: string): Buffer {
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32 || key.toString("base64") !== encoded) throw new Error("INSTANCE_MASTER_KEY must be a base64-encoded 32-byte key");
  return key;
}
function safeRelativePath(path: string): string {
  if (!path || path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("invalid backup file path");
  }
  return path;
}
function childPath(root: string, relative: string): string {
  const target = resolve(root, safeRelativePath(relative));
  const prefix = resolve(root) + sep;
  if (!target.startsWith(prefix)) throw new Error("invalid backup file path");
  return target;
}

export class InstanceBackupService {
  #health: BackupHealth = { status: "never_created" };
  #running = false;
  readonly #key: Buffer;
  readonly #now: () => Date;
  readonly #instanceVersion: string;

  constructor(private readonly source: InstanceBackupSource, options: { masterKey: string; now?: () => Date; instanceVersion?: string }) {
    this.#key = parseMasterKey(options.masterKey);
    this.#now = options.now ?? (() => new Date());
    this.#instanceVersion = options.instanceVersion ?? "0.1.0";
  }

  health(): BackupHealth { return this.#health; }
  isRunning(): boolean { return this.#running; }

  async create(destination: string): Promise<{ status: "created"; manifest: BackupManifest }> {
    if (this.#running) throw new Error("an Instance Backup is already running");
    this.#running = true;
    const temporary = `${destination}.partial-${randomUUID()}`;
    try {
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await mkdir(temporary, { recursive: false, mode: 0o700 });
      const files: BackupFile[] = [];
      const record = async (path: string, kind: BackupFile["kind"]) => {
        const target = childPath(temporary, path);
        const integrity = await fileIntegrity(target);
        files.push({ path, ...integrity, kind });
      };

      // Order is part of the protocol: the authoritative DB snapshot defines the point in time;
      // immutable Attachment objects and non-secret configuration are then collected against it.
      const databasePath = childPath(temporary, "database.dump");
      await this.source.captureDatabase(databasePath);
      await record("database.dump", "database");
      const attachmentRoot = childPath(temporary, "attachments");
      await mkdir(attachmentRoot, { recursive: true, mode: 0o700 });
      const attachments = await this.source.captureAttachments(attachmentRoot);
      const seen = new Set<string>();
      for (const attachment of [...attachments].sort((left, right) => left.localeCompare(right))) {
        const path = `attachments/${safeRelativePath(attachment)}`;
        if (seen.has(path)) throw new Error("duplicate Attachment path in Instance Backup");
        seen.add(path); await record(path, "attachment");
      }
      const configuration = Buffer.from(stableJson(await this.source.captureConfiguration()));
      await writeFile(childPath(temporary, "configuration.json"), configuration, { mode: 0o600, flag: "wx" });
      await record("configuration.json", "configuration");
      const createdAt = this.#now().toISOString();
      const manifest: BackupManifest = { schema: instanceBackupSchema, createdAt, instanceVersion: this.#instanceVersion,
        consistency: "coordinated", database: { format: "postgresql-custom", path: "database.dump" },
        masterKey: { required: true, verification: keyVerification(this.#key), included: false },
        files: files.sort((left, right) => left.path.localeCompare(right.path)) };
      await writeFile(join(temporary, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      await rename(temporary, destination);
      this.#health = { status: "unverified", createdAt, schema: instanceBackupSchema };
      await this.verify(destination);
      return { status: "created", manifest };
    } catch (error) {
      await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
      this.#health = { status: "failed", error: "backup_failed" };
      throw error;
    } finally { this.#running = false; }
  }

  async verify(source: string): Promise<{ status: "verified"; schema: typeof instanceBackupSchema; files: number }> {
    let manifest: BackupManifest;
    try { manifest = JSON.parse(await readFile(join(source, "manifest.json"), "utf8")) as BackupManifest; }
    catch { throw new Error("Instance Backup manifest is missing or invalid"); }
    if (manifest.schema !== instanceBackupSchema) throw new Error(`unsupported Instance Backup version: ${String(manifest.schema)}`);
    if (manifest.consistency !== "coordinated" || manifest.database?.path !== "database.dump"
      || manifest.database?.format !== "postgresql-custom" || manifest.masterKey?.included !== false) {
      throw new Error("Instance Backup manifest is invalid");
    }
    const actualKey = Buffer.from(keyVerification(this.#key), "hex");
    const expectedKey = Buffer.from(manifest.masterKey.verification ?? "", "hex");
    if (expectedKey.length !== actualKey.length || !timingSafeEqual(expectedKey, actualKey)) throw new Error("Instance master key does not match this backup");
    if (!Array.isArray(manifest.files) || manifest.files.length < 2) throw new Error("Instance Backup manifest has no restorable payload");
    const paths = new Set<string>();
    for (const file of manifest.files) {
      if (paths.has(file.path)) throw new Error("Instance Backup manifest contains duplicate paths");
      paths.add(file.path);
      let integrity: { bytes: number; sha256: string };
      try { integrity = await fileIntegrity(childPath(source, file.path)); } catch { throw new Error(`Instance Backup file is missing or invalid: ${file.path}`); }
      if (integrity.bytes !== file.bytes || integrity.sha256 !== file.sha256) throw new Error(`Instance Backup checksum mismatch: ${file.path}`);
    }
    if (!paths.has("database.dump") || !paths.has("configuration.json")) throw new Error("Instance Backup required payload is missing");
    const verifiedAt = this.#now().toISOString();
    this.#health = { status: "verified", createdAt: manifest.createdAt, verifiedAt, schema: instanceBackupSchema };
    return { status: "verified", schema: instanceBackupSchema, files: manifest.files.length };
  }

  async restore(source: string, target: InstanceBackupRestoreTarget, options: { dryRun: boolean }): Promise<{ status: "verified" | "restored" }> {
    await this.verify(source);
    let configuration: Record<string, unknown>;
    try {
      const decoded: unknown = JSON.parse(await readFile(childPath(source, "configuration.json"), "utf8"));
      if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error();
      configuration = decoded as Record<string, unknown>;
    } catch { throw new Error("Instance Backup configuration is invalid"); }
    await target.validateConfiguration(configuration);
    if (options.dryRun) return { status: "verified" };
    await target.restoreDatabase(childPath(source, "database.dump"));
    await target.restoreAttachments(childPath(source, "attachments"));
    return { status: "restored" };
  }
}

import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, opendir, readFile, rename, rm, writeFile } from "node:fs/promises";
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
  prepareAttachments(source: string, paths: ReadonlyArray<string>): Promise<unknown>;
  snapshotDatabase(destination: string): Promise<void>;
  restoreDatabase(source: string): Promise<void>;
  commitAttachments(prepared: unknown): Promise<void>;
  discardPreparedAttachments(prepared: unknown): Promise<void>;
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
  verification?: { verifiedAt: string; proof: string };
}
export type BackupHealth =
  | { status: "never_created" }
  | { status: "failed"; error: "backup_failed" }
  | { status: "unverified"; createdAt: string; schema: typeof instanceBackupSchema }
  | { status: "verified"; createdAt: string; verifiedAt: string; schema: typeof instanceBackupSchema };

async function fileIntegrity(path: string): Promise<{ bytes: number; sha256: string }> {
  const metadata = await lstat(path);
  if (!metadata.isFile()) throw new Error("Instance Backup payload must contain regular files only");
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk as Buffer);
  return { bytes: metadata.size, sha256: digest.digest("hex") };
}
function stableJson(value: unknown): string { return `${JSON.stringify(value, Object.keys(value as object).sort(), 2)}\n`; }
function keyVerification(key: Buffer): string {
  return createHmac("sha256", key).update("stash-instance-backup-master-key-v1").digest("hex");
}
function verificationProof(key: Buffer, manifest: BackupManifest, verifiedAt: string): string {
  return createHmac("sha256", key).update(JSON.stringify({ schema: manifest.schema, createdAt: manifest.createdAt,
    instanceVersion: manifest.instanceVersion, consistency: manifest.consistency, database: manifest.database,
    masterKey: manifest.masterKey, files: manifest.files, verifiedAt })).digest("hex");
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
  #restartRequired = false;
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
  requiresRestart(): boolean { return this.#restartRequired; }

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
      if (attachments.length === 0) await rm(attachmentRoot, { recursive: true });
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
      this.#health = { status: "unverified", createdAt, schema: instanceBackupSchema };
      await this.verify(temporary);
      await rename(temporary, destination);
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
      || manifest.database?.format !== "postgresql-custom" || manifest.masterKey?.included !== false || manifest.masterKey?.required !== true) {
      throw new Error("Instance Backup manifest is invalid");
    }
    const actualKey = Buffer.from(keyVerification(this.#key), "hex");
    const expectedKey = Buffer.from(manifest.masterKey.verification ?? "", "hex");
    if (expectedKey.length !== actualKey.length || !timingSafeEqual(expectedKey, actualKey)) throw new Error("Instance master key does not match this backup");
    if (!Array.isArray(manifest.files) || manifest.files.length < 2) throw new Error("Instance Backup manifest has no restorable payload");
    const paths = new Set<string>();
    for (const file of manifest.files) {
      const kindMatchesPath = file.path === "database.dump" ? file.kind === "database"
        : file.path === "configuration.json" ? file.kind === "configuration"
        : file.path.startsWith("attachments/") && file.kind === "attachment";
      if (!kindMatchesPath || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[0-9a-f]{64}$/.test(file.sha256)) {
        throw new Error("Instance Backup manifest file entry is invalid");
      }
      if (paths.has(file.path)) throw new Error("Instance Backup manifest contains duplicate paths");
      paths.add(file.path);
      let integrity: { bytes: number; sha256: string };
      try { integrity = await fileIntegrity(childPath(source, file.path)); } catch { throw new Error(`Instance Backup file is missing or invalid: ${file.path}`); }
      if (integrity.bytes !== file.bytes || integrity.sha256 !== file.sha256) throw new Error(`Instance Backup checksum mismatch: ${file.path}`);
    }
    if (!paths.has("database.dump") || !paths.has("configuration.json")) throw new Error("Instance Backup required payload is missing");
    await verifyInventory(source, paths);
    const verifiedAt = this.#now().toISOString();
    manifest.verification = { verifiedAt, proof: verificationProof(this.#key, manifest, verifiedAt) };
    const temporaryManifest = join(source, `.manifest-${randomUUID()}.tmp`);
    await writeFile(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporaryManifest, join(source, "manifest.json"));
    this.#health = { status: "verified", createdAt: manifest.createdAt, verifiedAt, schema: instanceBackupSchema };
    return { status: "verified", schema: instanceBackupSchema, files: manifest.files.length };
  }

  async restore(source: string, target: InstanceBackupRestoreTarget, options: { dryRun: boolean }): Promise<{ status: "verified" | "restored" }> {
    if (this.#running) throw new Error("an Instance Backup operation is already running");
    this.#running = true;
    try {
    await this.verify(source);
    let configuration: Record<string, unknown>;
    try {
      const decoded: unknown = JSON.parse(await readFile(childPath(source, "configuration.json"), "utf8"));
      if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error();
      configuration = decoded as Record<string, unknown>;
    } catch { throw new Error("Instance Backup configuration is invalid"); }
    await target.validateConfiguration(configuration);
    if (options.dryRun) return { status: "verified" };
    const manifest = JSON.parse(await readFile(join(source, "manifest.json"), "utf8")) as BackupManifest;
    const attachmentPaths = manifest.files.filter((file) => file.kind === "attachment")
      .map((file) => file.path.slice("attachments/".length));
    const prepared = await target.prepareAttachments(childPath(source, "attachments"), attachmentPaths);
    const rollbackDatabase = join(dirname(source), `.stash-restore-rollback-${randomUUID()}.dump`);
    try {
      await target.snapshotDatabase(rollbackDatabase);
      await target.restoreDatabase(childPath(source, "database.dump"));
      try { await target.commitAttachments(prepared); }
      catch (error) {
        try { await target.restoreDatabase(rollbackDatabase); }
        catch (rollbackError) { throw new AggregateError([error, rollbackError], "Attachment restore failed and database rollback also failed"); }
        throw error;
      }
      this.#restartRequired = true;
      return { status: "restored" };
    } finally {
      await target.discardPreparedAttachments(prepared).catch(() => undefined);
      await rm(rollbackDatabase, { force: true }).catch(() => undefined);
    }
    } finally { this.#running = false; }
  }

  async refreshHealth(backupRoot: string): Promise<BackupHealth> {
    let newest: BackupHealth = { status: "never_created" };
    try {
      for await (const entry of await opendir(backupRoot)) {
        if (!entry.isDirectory()) continue;
        try {
          const manifest = JSON.parse(await readFile(join(backupRoot, entry.name, "manifest.json"), "utf8")) as BackupManifest;
          if (manifest.schema !== instanceBackupSchema || typeof manifest.createdAt !== "string") continue;
          if (newest.status !== "never_created" && manifest.createdAt <= newest.createdAt) continue;
          let verified = false;
          if (manifest.verification) {
            const expected = Buffer.from(verificationProof(this.#key, manifest, manifest.verification.verifiedAt), "hex");
            const actual = Buffer.from(manifest.verification.proof, "hex");
            verified = expected.length === actual.length && timingSafeEqual(expected, actual);
          }
          newest = verified ? { status: "verified", createdAt: manifest.createdAt,
            verifiedAt: manifest.verification!.verifiedAt, schema: instanceBackupSchema }
            : { status: "unverified", createdAt: manifest.createdAt, schema: instanceBackupSchema };
        } catch { /* An incomplete/corrupt directory is not published health. */ }
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    this.#health = newest;
    return newest;
  }
}

async function verifyInventory(root: string, expectedFiles: ReadonlySet<string>): Promise<void> {
  const expectedDirectories = new Set<string>([""]);
  for (const path of expectedFiles) {
    const parts = path.split("/");
    for (let length = 1; length < parts.length; length++) expectedDirectories.add(parts.slice(0, length).join("/"));
  }
  const actualFiles = new Set<string>(); const actualDirectories = new Set<string>([""]);
  const walk = async (directory: string, relativeDirectory: string) => {
    for await (const entry of await opendir(directory)) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const metadata = await lstat(join(directory, entry.name));
      if (metadata.isSymbolicLink()) throw new Error(`Instance Backup contains a symbolic link: ${relativePath}`);
      if (metadata.isDirectory()) { actualDirectories.add(relativePath); await walk(join(directory, entry.name), relativePath); }
      else if (metadata.isFile()) actualFiles.add(relativePath);
      else throw new Error(`Instance Backup contains an unsupported entry: ${relativePath}`);
    }
  };
  await walk(root, "");
  actualFiles.delete("manifest.json");
  if (actualFiles.size !== expectedFiles.size || [...actualFiles].some((path) => !expectedFiles.has(path))) throw new Error("Instance Backup file inventory does not match its manifest");
  if (actualDirectories.size !== expectedDirectories.size || [...actualDirectories].some((path) => !expectedDirectories.has(path))) throw new Error("Instance Backup directory inventory does not match its manifest");
}

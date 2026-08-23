import { spawn } from "node:child_process";
import { cp, lstat, mkdir, opendir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import { UnsafeAttachmentRollbackError, type InstanceBackupRestoreTarget, type InstanceBackupSource } from "./instance-backup.js";
import type { AttachmentStorage } from "./attachments.js";

async function command(program: string, arguments_: string[], environment: NodeJS.ProcessEnv): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(program, arguments_, { env: environment, stdio: ["ignore", "ignore", "pipe"] });
    const errors: Buffer[] = []; let size = 0;
    child.stderr.on("data", (chunk: Buffer) => { if (size < 16_384) { errors.push(chunk.subarray(0, 16_384 - size)); size += chunk.length; } });
    child.once("error", (error) => reject(error));
    child.once("exit", (code, signal) => code === 0 ? resolvePromise()
      : reject(new Error(`${program} failed${signal ? ` (${signal})` : ""}: ${Buffer.concat(errors).toString("utf8").trim() || `exit ${code}`}`)));
  });
}

function postgresEnvironment(databaseUrl: string): { environment: NodeJS.ProcessEnv; database: string } {
  const url = new URL(databaseUrl);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") throw new Error("DATABASE_URL must use PostgreSQL");
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!database) throw new Error("DATABASE_URL must name a database");
  const environment: NodeJS.ProcessEnv = { ...process.env, PGHOST: url.hostname, PGDATABASE: database };
  if (url.port) environment.PGPORT = url.port;
  if (url.username) environment.PGUSER = decodeURIComponent(url.username);
  if (url.password) environment.PGPASSWORD = decodeURIComponent(url.password);
  const sslmode = url.searchParams.get("sslmode"); if (sslmode) environment.PGSSLMODE = sslmode;
  return { environment, database };
}

async function regularFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  const walk = async (directory: string) => {
    const entries = [];
    for await (const entry of await opendir(directory)) entries.push(entry);
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) throw new Error("Attachment storage must not contain symbolic links");
      if (metadata.isDirectory()) await walk(path);
      else if (metadata.isFile()) result.push(relative(root, path).split("\\").join("/"));
      else throw new Error("Attachment storage contains an unsupported file type");
    }
  };
  try { await walk(root); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return result;
}

export class PostgresLocalInstanceBackupSource implements InstanceBackupSource {
  constructor(private readonly options: {
    databaseUrl: string;
    attachmentRoot: string;
    attachmentStorage?: AttachmentStorage;
    attachmentStorageKind?: "local" | "s3";
    publicOrigin: string;
  }) {}
  async captureDatabase(destination: string): Promise<void> {
    await mkdir(dirname(destination), { recursive: true });
    await command("pg_dump", ["--format=custom", "--serializable-deferrable", "--no-password", "--file", destination],
      postgresEnvironment(this.options.databaseUrl).environment);
  }
  async captureAttachments(destination: string): Promise<ReadonlyArray<string>> {
    if (this.options.attachmentStorage) {
      const storage = this.options.attachmentStorage;
      if (!storage.listKeys) throw new Error("Attachment storage does not support coordinated backup");
      const files = [...await storage.listKeys()].sort();
      for (const file of files) {
        const target = join(destination, ...file.split("/"));
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, await storage.get(file), { mode: 0o600 });
      }
      return files;
    }
    const files = await regularFiles(this.options.attachmentRoot);
    for (const file of files) {
      const target = join(destination, ...file.split("/"));
      await mkdir(dirname(target), { recursive: true });
      await cp(join(this.options.attachmentRoot, ...file.split("/")), target, { preserveTimestamps: true });
    }
    return files;
  }
  async captureConfiguration() {
    return { publicOrigin: this.options.publicOrigin, attachmentStorage: this.options.attachmentStorageKind ?? "local", masterKeyRequired: true, redisIncluded: false };
  }
}

export class PostgresLocalInstanceRestoreTarget implements InstanceBackupRestoreTarget {
  constructor(private readonly options: {
    databaseUrl: string;
    attachmentRoot: string;
    attachmentStorage?: AttachmentStorage;
    attachmentStorageKind?: "local" | "s3";
    publicOrigin: string;
  }) {}
  async validateConfiguration(configuration: Record<string, unknown>): Promise<void> {
    if (configuration.attachmentStorage !== (this.options.attachmentStorageKind ?? "local"))
      throw new Error("Instance Backup Attachment storage adapter does not match this restore environment");
    if (configuration.masterKeyRequired !== true) throw new Error("Instance Backup does not declare its master-key requirement");
    if (configuration.publicOrigin !== this.options.publicOrigin) throw new Error("Instance Backup PUBLIC_ORIGIN does not match this restore environment");
  }
  async prepareAttachments(source: string, paths: ReadonlyArray<string>): Promise<unknown> {
    const destination = resolve(this.options.attachmentRoot);
    const staged = `${destination}.restore-staged-${process.pid}`;
    await rm(staged, { recursive: true, force: true });
    await mkdir(staged, { recursive: false, mode: 0o700 });
    try {
      for (const path of paths) {
        const sourcePath = join(source, ...path.split("/"));
        const metadata = await lstat(sourcePath);
        if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`Invalid verified Attachment: ${path}`);
        const target = join(staged, ...path.split("/"));
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await cp(sourcePath, target, { errorOnExist: true, preserveTimestamps: true });
      }
      return staged;
    } catch (error) { await rm(staged, { recursive: true, force: true }); throw error; }
  }
  async snapshotDatabase(destination: string): Promise<void> {
    await mkdir(dirname(destination), { recursive: true });
    await command("pg_dump", ["--format=custom", "--serializable-deferrable", "--no-password", "--file", destination],
      postgresEnvironment(this.options.databaseUrl).environment);
  }
  async restoreDatabase(source: string): Promise<void> {
    const postgres = postgresEnvironment(this.options.databaseUrl);
    await command("pg_restore", ["--clean", "--if-exists", "--exit-on-error", "--single-transaction", "--no-owner", "--no-privileges", "--no-password", "--dbname", postgres.database, source], postgres.environment);
  }
  async commitAttachments(prepared: unknown): Promise<void> {
    if (typeof prepared !== "string") throw new Error("invalid prepared Attachment restore");
    if (this.options.attachmentStorage) {
      await this.commitStoredAttachments(prepared, this.options.attachmentStorage);
      return;
    }
    const destination = resolve(this.options.attachmentRoot);
    const staged = prepared;
    const previous = `${destination}.restore-previous-${process.pid}`;
    await rm(previous, { recursive: true, force: true });
    let movedPrevious = false;
    try {
      try { await rename(destination, previous); movedPrevious = true; } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await rename(staged, destination);
    } catch (error) {
      if (movedPrevious) await rename(previous, destination).catch(() => undefined);
      throw error;
    }
    await rm(previous, { recursive: true, force: true }).catch(() => undefined);
  }
  async discardPreparedAttachments(prepared: unknown): Promise<void> {
    if (typeof prepared === "string") await rm(prepared, { recursive: true, force: true });
  }

  private async commitStoredAttachments(staged: string, storage: AttachmentStorage): Promise<void> {
    if (!storage.listKeys) throw new Error("Attachment storage does not support coordinated restore");
    const previousKeys = [...await storage.listKeys()];
    const desiredKeys = await regularFiles(staged);
    const rollback = `${staged}-rollback`;
    await rm(rollback, { recursive: true, force: true }); await mkdir(rollback, { recursive: true, mode: 0o700 });
    try {
      for (const key of previousKeys) { const target = join(rollback, ...key.split("/")); await mkdir(dirname(target), { recursive: true });
        await writeFile(target, await storage.get(key), { mode: 0o600 }); }
      for (const key of desiredKeys) await storage.put(key, await readFile(join(staged, ...key.split("/"))));
      const desired = new Set(desiredKeys);
      for (const key of previousKeys) if (!desired.has(key)) await storage.delete(key);
    } catch (error) {
      const currentKeys = await storage.listKeys().catch(() => []);
      const rollbackErrors: unknown[] = [];
      for (const key of previousKeys) try { await storage.put(key, await readFile(join(rollback, ...key.split("/")))); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
      const previous = new Set(previousKeys);
      for (const key of currentKeys) if (!previous.has(key)) try { await storage.delete(key); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
      if (rollbackErrors.length) throw new UnsafeAttachmentRollbackError([error, ...rollbackErrors], "S3 Attachment restore and rollback both failed");
      throw error;
    } finally { await rm(staged, { recursive: true, force: true }).catch(() => undefined); await rm(rollback, { recursive: true, force: true }).catch(() => undefined); }
  }
}

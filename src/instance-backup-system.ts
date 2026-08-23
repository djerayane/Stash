import { spawn } from "node:child_process";
import { cp, lstat, mkdir, opendir, rename, rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import type { InstanceBackupRestoreTarget, InstanceBackupSource } from "./instance-backup.js";

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
  constructor(private readonly options: { databaseUrl: string; attachmentRoot: string; publicOrigin: string }) {}
  async captureDatabase(destination: string): Promise<void> {
    await mkdir(dirname(destination), { recursive: true });
    await command("pg_dump", ["--format=custom", "--serializable-deferrable", "--no-password", "--file", destination],
      postgresEnvironment(this.options.databaseUrl).environment);
  }
  async captureAttachments(destination: string): Promise<ReadonlyArray<string>> {
    const files = await regularFiles(this.options.attachmentRoot);
    for (const file of files) {
      const target = join(destination, ...file.split("/"));
      await mkdir(dirname(target), { recursive: true });
      await cp(join(this.options.attachmentRoot, ...file.split("/")), target, { preserveTimestamps: true });
    }
    return files;
  }
  async captureConfiguration() {
    return { publicOrigin: this.options.publicOrigin, attachmentStorage: "local", masterKeyRequired: true, redisIncluded: false };
  }
}

export class PostgresLocalInstanceRestoreTarget implements InstanceBackupRestoreTarget {
  constructor(private readonly options: { databaseUrl: string; attachmentRoot: string; publicOrigin: string }) {}
  async validateConfiguration(configuration: Record<string, unknown>): Promise<void> {
    if (configuration.attachmentStorage !== "local") throw new Error("Instance Backup requires an unsupported Attachment storage adapter");
    if (configuration.masterKeyRequired !== true) throw new Error("Instance Backup does not declare its master-key requirement");
    if (configuration.publicOrigin !== this.options.publicOrigin) throw new Error("Instance Backup PUBLIC_ORIGIN does not match this restore environment");
  }
  async restoreDatabase(source: string): Promise<void> {
    const postgres = postgresEnvironment(this.options.databaseUrl);
    await command("pg_restore", ["--clean", "--if-exists", "--exit-on-error", "--no-owner", "--no-privileges", "--no-password", "--dbname", postgres.database, source], postgres.environment);
  }
  async restoreAttachments(source: string): Promise<void> {
    const destination = resolve(this.options.attachmentRoot);
    const staged = `${destination}.restore-staged`;
    const previous = `${destination}.restore-previous`;
    await rm(staged, { recursive: true, force: true });
    await rm(previous, { recursive: true, force: true });
    await cp(source, staged, { recursive: true, errorOnExist: true });
    let movedPrevious = false;
    try {
      try { await rename(destination, previous); movedPrevious = true; } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await rename(staged, destination);
      await rm(previous, { recursive: true, force: true });
    } catch (error) {
      if (movedPrevious) await rename(previous, destination).catch(() => undefined);
      throw error;
    }
  }
}

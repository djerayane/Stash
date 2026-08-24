import { createHash } from "node:crypto";
import { cp, lstat, mkdir, opendir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Pool } from "pg";

import { createAuthenticationSecretCodec, verifyAuthenticationKeyCheck } from "./authentication-secrets.js";
import type { EmbeddedInstanceStore, EmbeddedTableSnapshot } from "./embedded-instance-store.js";

export type MigrationKeyInput =
  | { mode: "preserve"; sourceKeyFile: string; destinationKeyFile?: string }
  | { mode: "rotate"; sourceKeyFile: string; destinationKeyFile?: string };

async function readPrivateKey(path: string): Promise<string> {
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error("Migration key path must name a regular file");
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) throw new Error("Migration key file must have owner-only permissions (0600 or stricter)");
  const encoded = (await readFile(path, "utf8")).trim();
  createAuthenticationSecretCodec(encoded);
  return encoded;
}

export async function readMigrationKeys(input: MigrationKeyInput): Promise<{ source: string; destination: string; mode: "preserve" | "rotate" }> {
  const source = await readPrivateKey(input.sourceKeyFile);
  if (input.mode === "preserve") {
    if (input.destinationKeyFile) throw new Error("Preserve migration does not accept a destination key file");
    return { source, destination: source, mode: input.mode };
  }
  if (!input.destinationKeyFile) throw new Error("Rotate migration requires a destination key file");
  const destination = await readPrivateKey(input.destinationKeyFile);
  if (source === destination) throw new Error("Rotate migration source and destination keys must be different");
  return { source, destination, mode: input.mode };
}

function quote(identifier: string): string { return `"${identifier.replaceAll('"', '""')}"`; }
function destinationValue(value: unknown, dataType: string): unknown {
  return (dataType === "json" || dataType === "jsonb") && value !== null && typeof value === "object" ? JSON.stringify(value) : value;
}
function recoveryLookup(purpose: "recovery-code" | "email-recovery", value: string): string {
  return createHash("sha256").update(`stash:${purpose}:v1\0${value}`).digest("base64");
}

function orderedTables(tables: EmbeddedTableSnapshot[]): EmbeddedTableSnapshot[] {
  const remaining = new Map(tables.map((table) => [table.name, table])); const ordered: EmbeddedTableSnapshot[] = [];
  while (remaining.size) {
    const ready = [...remaining.values()].filter((table) => table.dependsOn.every((dependency) => !remaining.has(dependency))).sort((a, b) => a.name.localeCompare(b.name));
    if (!ready.length) throw new Error(`Embedded migration cannot order foreign-key dependencies: ${[...remaining.keys()].sort().join(", ")}`);
    for (const table of ready) { remaining.delete(table.name); ordered.push(table); }
  }
  return ordered;
}

function rotateRow(table: string, row: Record<string, unknown>, sourceKey: string, destinationKey: string): Record<string, unknown> {
  const source = createAuthenticationSecretCodec(sourceKey); const destination = createAuthenticationSecretCodec(destinationKey); const next = { ...row };
  const rotate = (column: string, purpose?: string) => { if (typeof next[column] === "string") next[column] = destination.encrypt(source.decrypt(next[column] as string, purpose), purpose); };
  const direct: Record<string, string[]> = {
    stash_accounts: ["password_hash"], stash_oidc_configurations: ["client_secret"], stash_oidc_identities: ["subject_secret"],
    stash_passkeys: ["public_key"], stash_recovery_codes: ["protected_secret"], stash_email_recoveries: ["protected_secret"],
    stash_email_recovery_delivery_jobs: ["protected_delivery"], stash_authentication_key_check: ["encrypted_check"],
  };
  for (const column of direct[table] ?? []) rotate(column);
  if (table === "stash_sessions" && typeof next.token_hash === "string") {
    const plain = source.decrypt(next.token_hash); next.token_hash = destination.encrypt(plain); next.token_lookup = destination.blindIndex(plain);
  }
  if (table === "stash_invitations" && typeof next.token_secret === "string") {
    const plain = source.decrypt(next.token_secret, "invitation-v1"); next.token_secret = destination.encrypt(plain, "invitation-v1"); next.token_lookup = destination.blindIndex(plain, "invitation-v1");
  }
  if (table === "stash_oidc_identities" && typeof next.subject_secret === "string") {
    const subject = destination.decrypt(next.subject_secret); next.subject_lookup = destination.blindIndex(`oidc-identity-v1:${JSON.stringify([next.organization_id, next.issuer, subject])}`);
  }
  if (table === "stash_email_recoveries" && typeof next.protected_secret === "string") {
    next.token_lookup = destination.blindIndex(recoveryLookup("email-recovery", destination.decrypt(next.protected_secret)));
  }
  if (table === "stash_recovery_codes" && typeof next.protected_secret === "string") {
    next.code_lookup = destination.blindIndex(recoveryLookup("recovery-code", destination.decrypt(next.protected_secret)));
  }
  return next;
}

async function attachmentFiles(root: string): Promise<Array<{ relative: string; digest: string }>> {
  const files: Array<{ relative: string; digest: string }> = [];
  const walk = async (directory: string, prefix: string) => {
    try {
      const entries = []; for await (const entry of await opendir(directory)) entries.push(entry); entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const path = join(directory, entry.name); const relative = prefix ? `${prefix}/${entry.name}` : entry.name; const metadata = await lstat(path);
        if (metadata.isSymbolicLink()) throw new Error("Embedded migration refuses symbolic links in Attachment storage");
        if (metadata.isDirectory()) await walk(path, relative);
        else if (metadata.isFile()) files.push({ relative, digest: createHash("sha256").update(await readFile(path)).digest("hex") });
        else throw new Error("Embedded migration found an unsupported Attachment file");
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  };
  await walk(root, ""); return files;
}

async function finalizeAttachments(staged: string, destination: string): Promise<void> {
  const existing = await attachmentFiles(destination);
  if (existing.length) throw new Error("Migration destination Attachment storage must be empty");
  await rm(destination, { recursive: true, force: true });
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await rename(staged, destination);
}

export async function migrateEmbeddedInstance(options: {
  source: EmbeddedInstanceStore; destinationDatabaseUrl: string; destinationAttachmentRoot: string;
  keys: { source: string; destination: string; mode: "preserve" | "rotate" };
}): Promise<{ tables: number; rows: number; attachments: number }> {
  if (!/^postgres(?:ql)?:\/\//.test(options.destinationDatabaseUrl)) throw new Error("Migration destination must be external PostgreSQL");
  const sourceCodec = createAuthenticationSecretCodec(options.keys.source);
  const keyCheck = await options.source.semanticSnapshot();
  const check = keyCheck.find((table) => table.name === "stash_authentication_key_check")?.rows[0]?.encrypted_check;
  if (typeof check !== "string") throw new Error("Embedded source has no authentication key check");
  verifyAuthenticationKeyCheck(sourceCodec, check);
  const tables = orderedTables(keyCheck);
  const destinationAttachments = resolve(options.destinationAttachmentRoot);
  const journalPath = `${destinationAttachments}.migration-journal.json`;
  try {
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as { staged: string; state: "committing" | "database_committed"; tables: number; rows: number; attachments: number; attachmentFiles?: Array<{ relative: string; digest: string }> };
    if (journal.state === "committing") {
      const recoveryPool = new Pool({ connectionString: options.destinationDatabaseUrl, connectionTimeoutMillis: 2_000, max: 1 });
      try {
        const counts = await Promise.all(tables.map(async (table) => Number((await recoveryPool.query(`SELECT count(*) count FROM ${quote(table.name)}`)).rows[0]?.count)));
        if (counts.reduce((sum, count) => sum + count, 0) !== journal.rows) throw new Error("Migration commit outcome is unknown and requires operator recovery");
      } finally { await recoveryPool.end(); }
    }
    const stagedExists = await stat(journal.staged).then((metadata) => metadata.isDirectory()).catch(() => false);
    const recovered = stagedExists ? await attachmentFiles(journal.staged) : [];
    if (!stagedExists || !journal.attachmentFiles || JSON.stringify(recovered) !== JSON.stringify(journal.attachmentFiles)) {
      const finalized = await attachmentFiles(destinationAttachments);
      if (!journal.attachmentFiles || JSON.stringify(finalized) !== JSON.stringify(journal.attachmentFiles)) throw new Error("Migration journal Attachment validation failed");
      await rm(journalPath); return { tables: journal.tables, rows: journal.rows, attachments: journal.attachments };
    }
    await finalizeAttachments(journal.staged, destinationAttachments); await rm(journalPath);
    return { tables: journal.tables, rows: journal.rows, attachments: journal.attachments };
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const existingAttachments = await attachmentFiles(destinationAttachments);
  if (existingAttachments.length) throw new Error("Migration destination Attachment storage must be empty");
  const stagedAttachments = join(dirname(destinationAttachments), `.stash-migration-${process.pid}-${Date.now()}`);
  await rm(stagedAttachments, { recursive: true, force: true }); await mkdir(stagedAttachments, { recursive: false, mode: 0o700 });
  await cp(options.source.paths.attachments, stagedAttachments, { recursive: true, force: false });
  const sourceAttachments = await attachmentFiles(options.source.paths.attachments); const staged = await attachmentFiles(stagedAttachments);
  if (JSON.stringify(sourceAttachments) !== JSON.stringify(staged)) { await rm(stagedAttachments, { recursive: true, force: true }); throw new Error("Attachment checksum validation failed"); }
  const preflightPool = new Pool({ connectionString: options.destinationDatabaseUrl, connectionTimeoutMillis: 2_000, max: 1 });
  try {
    const existingTables = (await preflightPool.query<{ table_name: string }>(`SELECT table_name FROM information_schema.tables
      WHERE table_schema=current_schema() AND table_type='BASE TABLE' AND table_name LIKE 'stash_%' ORDER BY table_name`)).rows.map(({ table_name }) => table_name);
    if (existingTables.includes("stash_authentication_key_check")) {
      const configured = await preflightPool.query<{ encrypted_check: string }>("SELECT encrypted_check FROM stash_authentication_key_check WHERE singleton=TRUE");
      if (configured.rowCount !== 1) throw new Error("Migration destination authentication key boundary is invalid");
      try { verifyAuthenticationKeyCheck(createAuthenticationSecretCodec(options.keys.destination), configured.rows[0]!.encrypted_check); }
      catch { throw new Error("Migration destination Instance master key does not match the configured destination key"); }
    } else throw new Error("Migration destination Instance must be prepared with its configured master key before migration");
    for (const table of existingTables.filter((name) => name !== "stash_authentication_key_check" && name !== "stash_instance_format")) {
      if (Number((await preflightPool.query(`SELECT count(*) count FROM ${quote(table)}`)).rows[0]?.count) !== 0) throw new Error("Migration destination PostgreSQL Instance must be empty");
    }
  } catch (error) { await rm(stagedAttachments, { recursive: true, force: true }); throw error; }
  finally { await preflightPool.end(); }
  const pool = new Pool({ connectionString: options.destinationDatabaseUrl, connectionTimeoutMillis: 2_000, max: 1 }); const client = await pool.connect();
  let commitAttempted = false;
  try {
    await client.query("BEGIN");
    const destinationCheck = await client.query<{ encrypted_check: string }>("SELECT encrypted_check FROM stash_authentication_key_check WHERE singleton=TRUE");
    if (destinationCheck.rowCount !== 1) throw new Error("Migration destination authentication key boundary is invalid");
    try { verifyAuthenticationKeyCheck(createAuthenticationSecretCodec(options.keys.destination), destinationCheck.rows[0]!.encrypted_check); }
    catch { throw new Error("Migration destination Instance master key does not match the configured destination key"); }
    for (const table of tables) {
      const targetColumnRecords = (await client.query<{ column_name: string; data_type: string }>(`SELECT column_name,data_type FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1 AND is_generated='NEVER' ORDER BY ordinal_position`, [table.name])).rows;
      const targetColumns = targetColumnRecords.map((row) => row.column_name);
      if (JSON.stringify(targetColumns) !== JSON.stringify(table.columns)) throw new Error(`Migration destination schema is incompatible at ${table.name}`);
      const targetCount = Number((await client.query(`SELECT count(*) count FROM ${quote(table.name)}`)).rows[0]?.count);
      if (table.name === "stash_authentication_key_check") {
        if (targetCount !== 1) throw new Error("Migration destination authentication key boundary is invalid");
        continue;
      }
      if (targetCount !== 0) throw new Error("Migration destination PostgreSQL Instance must be empty");
      for (const sourceRow of table.rows) {
        const row = options.keys.mode === "rotate" ? rotateRow(table.name, sourceRow, options.keys.source, options.keys.destination) : sourceRow;
        const placeholders = table.columns.map((_, index) => `$${index + 1}`).join(",");
        await client.query(`INSERT INTO ${quote(table.name)} (${table.columns.map(quote).join(",")}) VALUES (${placeholders})`,
          table.columns.map((column, index) => destinationValue(row[column], targetColumnRecords[index]!.data_type)));
      }
    }
    const copiedRows = tables.reduce((count, table) => count + table.rows.length, 0);
    const destinationRows = (await Promise.all(tables.map(async (table) => Number((await client.query(`SELECT count(*) count FROM ${quote(table.name)}`)).rows[0]?.count)))).reduce((sum, count) => sum + count, 0);
    if (destinationRows !== copiedRows) throw new Error("Migration post-copy semantic row-count validation failed");
    await writeFile(journalPath, JSON.stringify({ staged: stagedAttachments, state: "committing", tables: tables.length, rows: copiedRows,
      attachments: sourceAttachments.length, attachmentFiles: sourceAttachments }), { mode: 0o600, flag: "wx" });
    commitAttempted = true;
    await client.query("COMMIT");
    await writeFile(journalPath, JSON.stringify({ staged: stagedAttachments, state: "database_committed", tables: tables.length, rows: copiedRows,
      attachments: sourceAttachments.length, attachmentFiles: sourceAttachments }), { mode: 0o600 });
    await finalizeAttachments(stagedAttachments, destinationAttachments); await rm(journalPath);
    return { tables: tables.length, rows: tables.reduce((count, table) => count + table.rows.length, 0), attachments: sourceAttachments.length };
  } catch (error) {
    if (!commitAttempted) { await client.query("ROLLBACK").catch(() => undefined); await rm(stagedAttachments, { recursive: true, force: true }).catch(() => undefined); await rm(journalPath, { force: true }).catch(() => undefined); }
    throw error;
  } finally { client.release(); await pool.end(); }
}

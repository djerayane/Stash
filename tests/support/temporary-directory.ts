import { mkdtemp, rm } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ownedDirectories = new Set<string>();
let exitCleanupRegistered = false;

export function cleanupTestDirectories(): void {
  for (const path of ownedDirectories) rmSync(path, { recursive: true, force: true });
  ownedDirectories.clear();
}

export async function withTemporaryDirectory<T>(prefix: string, work: (path: string) => Promise<T>): Promise<T> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  try { return await work(path); }
  finally { await rm(path, { recursive: true, force: true }); }
}

/** Own a temporary directory for the lifetime of the current test file. */
export async function temporaryTestDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  ownedDirectories.add(path);
  if (!exitCleanupRegistered) {
    exitCleanupRegistered = true;
    process.once("exit", cleanupTestDirectories);
  }
  return path;
}

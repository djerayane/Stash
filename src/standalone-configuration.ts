import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";

export interface StandaloneRuntimeConfiguration { schema: "stash.standalone-config.v1"; publicOrigin: string; host: string; port: number; masterKeyFile: string }

function isConfiguration(value: unknown): value is StandaloneRuntimeConfiguration {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.schema === "stash.standalone-config.v1" && typeof candidate.publicOrigin === "string" && candidate.publicOrigin.length > 0
    && typeof candidate.host === "string" && candidate.host.length > 0 && typeof candidate.port === "number" && Number.isInteger(candidate.port)
    && candidate.port >= 1 && candidate.port <= 65_535 && typeof candidate.masterKeyFile === "string" && isAbsolute(candidate.masterKeyFile);
}

export async function loadStandaloneConfiguration(dataDirectory: string, hostArgument?: string, portArgument?: string) {
  const configurationPath = join(dataDirectory, "config", "runtime.json"); let saved: StandaloneRuntimeConfiguration | undefined; let existingEntries: string[] = [];
  try { existingEntries = await readdir(dataDirectory); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  try { const parsed: unknown = JSON.parse(await readFile(configurationPath, "utf8")); if (!isConfiguration(parsed)) throw new Error("invalid configuration"); saved = parsed; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Standalone generated configuration is unreadable or invalid");
    if (existingEntries.length > 0) throw new Error("Existing data directory is missing its generated standalone configuration; restore the configuration and master-key file");
  }
  const host = hostArgument?.trim() || saved?.host || "127.0.0.1"; const port = Number.parseInt(portArgument ?? String(saved?.port ?? 3000), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("--port must be an integer between 1 and 65535");
  const masterKeyFile = saved?.masterKeyFile || join(dirname(dataDirectory), `.${basename(dataDirectory)}.master-key`);
  await mkdir(join(dataDirectory, "config"), { recursive: true });
  if (saved) {
    try { await readFile(masterKeyFile, "utf8"); } catch { throw new Error(`Configured master-key file is unreadable or missing: ${masterKeyFile}`); }
  } else await writeFile(masterKeyFile, `${randomBytes(32).toString("base64")}\n`, { mode: 0o600, flag: "wx" });
  if (process.platform !== "win32") await chmod(masterKeyFile, 0o600);
  const configuration: StandaloneRuntimeConfiguration = { schema: "stash.standalone-config.v1", publicOrigin: `http://localhost:${port}`, host, port, masterKeyFile };
  if (!saved) await writeFile(configurationPath, `${JSON.stringify(configuration, null, 2)}\n`, { mode: 0o600 });
  return { configuration, masterKey: (await readFile(masterKeyFile, "utf8")).trim() };
}

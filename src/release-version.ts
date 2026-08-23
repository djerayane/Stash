import { readFile } from "node:fs/promises";

export async function readStashReleaseVersion(packageUrl = new URL("../package.json", import.meta.url)): Promise<string> {
  const value = JSON.parse(await readFile(packageUrl, "utf8")) as { version?: unknown };
  if (typeof value.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value.version)) throw new Error("Stash package version is invalid");
  return value.version;
}

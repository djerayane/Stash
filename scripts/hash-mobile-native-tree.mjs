import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

async function filesBeneath(root, path = root) {
  const entries = await readdir(path, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) files.push(...await filesBeneath(root, child));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

function normalize(path, bytes) {
  if (!path.endsWith("project.pbxproj")) return bytes;
  const lines = bytes.toString("utf8").replaceAll("\r\n", "\n")
    .replace(/\b[A-F0-9]{24}\b/g, "XCODE_GENERATED_ID")
    .split("\n").sort();
  return Buffer.from(lines.join("\n"));
}

export async function hashNativeTree(root) {
  const hash = createHash("sha256");
  for (const file of await filesBeneath(resolve(root))) {
    const path = relative(resolve(root), file).replaceAll("\\", "/");
    hash.update(path).update("\0").update(normalize(path, await readFile(file))).update("\0");
  }
  return hash.digest("hex");
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  process.stdout.write(`${await hashNativeTree(process.argv[2] ?? ".")}\n`);
}

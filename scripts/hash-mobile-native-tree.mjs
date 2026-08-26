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
    .replace(/\b[A-F0-9]{24}\b/g, "XCODE_GENERATED_ID").split("\n");
  for (let begin = 0; begin < lines.length; begin += 1) {
    if (!/^\/\* Begin \w+ section \*\/$/.test(lines[begin] ?? "")) continue;
    const end = lines.findIndex((line, index) => index > begin && /^\/\* End \w+ section \*\/$/.test(line));
    if (end < 0) continue;
    const prefix = []; const records = []; let current = null;
    for (const line of lines.slice(begin + 1, end)) {
      if (current) {
        current.push(line);
        if (line === "\t\t};") { records.push(current); current = null; }
      } else if (/^\t\t\S.* = \{/.test(line)) {
        current = [line];
        if (line.endsWith("};")) { records.push(current); current = null; }
      } else prefix.push(line);
    }
    if (current) records.push(current);
    const canonical = records.sort((left, right) => left.join("\n").localeCompare(right.join("\n"))).flat();
    lines.splice(begin + 1, end - begin - 1, ...prefix, ...canonical);
    begin += prefix.length + canonical.length;
  }
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

import { readFile, writeFile } from "node:fs/promises";
import { parseMobileReleaseTag } from "./mobile-release-version.mjs";

const tag = process.argv[2] ?? "";
const values = parseMobileReleaseTag(tag);
const path = new URL("../apps/mobile/app.json", import.meta.url);
const app = JSON.parse(await readFile(path, "utf8"));
app.expo.version = values.version;
await writeFile(path, `${JSON.stringify(app, null, 2)}\n`);
if (process.env.GITHUB_OUTPUT) {
  await writeFile(process.env.GITHUB_OUTPUT, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(""), { flag: "a" });
} else {
  process.stdout.write(`${JSON.stringify(values)}\n`);
}

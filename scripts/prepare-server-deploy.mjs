import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const target = resolve(".bundle-deploy");
const expected = resolve(fileURLToPath(new URL("../.bundle-deploy", import.meta.url)));
if (target !== expected) throw new Error("Refusing to clean an unexpected deployment directory");
await rm(target, { recursive: true, force: true });

import { rm } from "node:fs/promises";
import { resolve } from "node:path";

const target = resolve(".bundle-deploy");
const expected = new URL("../.bundle-deploy", import.meta.url).pathname.replace(/\/$/, "");
if (target !== expected) throw new Error("Refusing to clean an unexpected deployment directory");
await rm(target, { recursive: true, force: true });

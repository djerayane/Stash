import { fileURLToPath } from "node:url";

import { startInstance } from "../src/instance.js";

const instance = await startInstance({
  database: { async verifyConnection() {}, async close() {} },
  host: "127.0.0.1",
  port: Number.parseInt(process.env.STASH_BROWSER_PORT ?? "4173", 10),
  instanceAdminToken: "browser-acceptance-admin-token",
  webClientRoot: fileURLToPath(new URL("../apps/web/dist", import.meta.url)),
});

console.log(`Browser acceptance Instance listening on ${instance.url}`);

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await instance.close();
  process.exit(0);
}

process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());

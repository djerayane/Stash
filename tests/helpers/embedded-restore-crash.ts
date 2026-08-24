import { PGlite } from "@electric-sql/pglite";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const [root, dumpPath, renameCountText] = process.argv.slice(2);
if (!root || !dumpPath || !renameCountText) throw new Error("root, dump, and rename count are required");
const renameCount = Number(renameCountText);
const live = { database: join(root, "database"), attachments: join(root, "attachments"), configuration: join(root, "config") };
const staged = { database: `${live.database}.restore-staged-crash`, attachments: `${live.attachments}.restore-staged-crash`, configuration: `${live.configuration}.restore-staged-crash` };
const previous = { database: `${live.database}.restore-previous-crash`, attachments: `${live.attachments}.restore-previous-crash`, configuration: `${live.configuration}.restore-previous-crash` };
await Promise.all([...Object.values(staged), ...Object.values(previous)].map((path) => rm(path, { recursive: true, force: true })));
const restored = await PGlite.create({ dataDir: staged.database, loadDataDir: new Blob([await readFile(dumpPath)]) }); await restored.close();
await mkdir(staged.attachments, { recursive: true }); await writeFile(join(staged.attachments, "state.txt"), "backup");
await mkdir(staged.configuration, { recursive: true }); await writeFile(join(staged.configuration, "runtime.json"), JSON.stringify({ state: "backup" }));
await writeFile(join(root, ".restore-journal.json"), JSON.stringify({ state: "cutting_over", staged, previous }), { mode: 0o600 });
const operations = (["database", "attachments", "configuration"] as const).flatMap((name) => [[live[name], previous[name]], [staged[name], live[name]]] as const);
for (const [index, operation] of operations.entries()) { if (index >= renameCount) break; await rename(...operation); }
process.kill(process.pid, "SIGKILL");

import { composeInstanceRuntime } from "./instance-runtime.js";

async function main(): Promise<void> {
  const runtime = await composeInstanceRuntime(process.env);
  console.log(`Stash Instance listening on ${runtime.instance.url}`);
  const shutdown = async () => {
    console.log("Stopping Stash Instance");
    await runtime.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown startup failure";
  console.error(`Stash Instance failed to start: ${message}`);
  process.exitCode = 1;
});

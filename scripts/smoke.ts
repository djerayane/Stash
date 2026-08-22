const baseUrl = (process.env.STASH_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const deadline = Date.now() + Number(process.env.SMOKE_TIMEOUT_MS ?? 30_000);

async function waitUntilReady(): Promise<void> {
  let lastFailure = "Instance did not respond";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health/ready`);
      if (response.ok) return;
      lastFailure = `${response.status} ${await response.text()}`;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Stash Instance was not ready: ${lastFailure}`);
}

await waitUntilReady();
const browser = await fetch(baseUrl);
if (!browser.ok || !(await browser.text()).includes("Stash")) {
  throw new Error("Stash browser surface was not available");
}
console.log(`Smoke test passed for ${baseUrl}`);

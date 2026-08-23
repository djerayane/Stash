import { defineConfig } from "@playwright/test";

const browserPort = Number.parseInt(process.env.STASH_BROWSER_PORT ?? "4173", 10);

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL: `http://127.0.0.1:${browserPort}`, trace: "retain-on-failure" },
  webServer: {
    command: "pnpm exec tsx scripts/browser-instance.ts",
    url: `http://127.0.0.1:${browserPort}/health/ready`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});

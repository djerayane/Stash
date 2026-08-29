import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  test: { environment: "jsdom", maxWorkers: 4, setupFiles: "./src/test-setup.ts" },
});

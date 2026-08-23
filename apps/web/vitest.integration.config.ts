import { mergeConfig } from "vitest/config";
import baseConfig from "./vite.config";

export default mergeConfig(baseConfig, {
  test: { include: ["src/**/*.integration.test.{ts,tsx}"] },
});

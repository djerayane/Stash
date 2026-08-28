import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: [
      { find: /^react-native$/, replacement: "react-native-web" },
      { find: /^@\//, replacement: `${process.cwd()}/` },
    ],
  },
  test: {
    environment: "jsdom",
  },
});

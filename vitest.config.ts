import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  resolve: {
    alias: {
      // Provide a shim for node:sqlite so Vite can resolve it during tests
      "node:sqlite": resolve(__dirname, "shims/sqlite.cjs"),
    },
  },
  test: {
    globals: true,
    environment: "node",
    pool: "forks",
    forkOptions: {
      execArgv: ["--experimental-sqlite"],
    },
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts", "src/http-server.ts"],
      reporter: ["text", "lcov"],
    },
  },
});

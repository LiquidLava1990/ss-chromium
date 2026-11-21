import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    // Builds the stub daemon that the daemon tests start as a separate process
    globalSetup: ["./src/testing/global-setup.ts"],
    // Real Chromium and daemon processes. One file at a time: tests with real-time budgets (a
    // screenshot within 5 s) fail when several Chromium-heavy files share a small CI runner
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});

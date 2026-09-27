import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // One Postgres container for the whole run; files share it, so run them one at a time.
    globalSetup: ["test/global-setup.ts"],
    fileParallelism: false,
    hookTimeout: 120_000,
    testTimeout: 20_000,
  },
});

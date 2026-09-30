import { defineConfig, devices } from "@playwright/test";
import { BASE_URL } from "./support";

/**
 * End-to-end tests against the production build: the real server started through its CLI (so
 * migrations run), serving the built web app (`yarn workspace @ganttlines/web build` first), on a
 * throwaway PostgreSQL. Tests share one server and reset the database, so they run one at a time.
 */
export default defineConfig({
  testDir: "tests",
  globalSetup: "./global-setup.ts",
  workers: 1,
  fullyParallel: false,
  retries: process.env["CI"] ? 1 : 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: process.env["CI"] ? [["github"], ["list"]] : "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: BASE_URL,
    locale: "en-US",
    timezoneId: "UTC",
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
  },
});

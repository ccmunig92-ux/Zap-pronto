import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  outputDir: "../../.playwright-results",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: Number(process.env.E2E_OIDC_TEST_TIMEOUT_MS ?? 90_000),
  reporter: [["line"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173",
    browserName: "chromium",
    screenshot: "off",
    video: "off",
    trace: "off",
    acceptDownloads: false,
  },
});

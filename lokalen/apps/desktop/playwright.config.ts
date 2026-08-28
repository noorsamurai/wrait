import { defineConfig } from "@playwright/test";

/**
 * A per-run data directory, so each run starts against an empty relay.
 * Playwright boots `webServer` before any setup hook could clear a shared one.
 */
const dataDir = `./.e2e-data/run-${Date.now().toString(36)}`;

/**
 * Drives the real UI against a real relay.
 *
 * The app is a webview app on every platform it ships to, so exercising it in
 * Chromium is a genuine test of the shipped frontend rather than a stand-in.
 */
export default defineConfig({
  testDir: "./e2e",
  // Everything except the screenshot run, which is a capture rather than a check.
  testMatch: /(messaging|tasks|rooms|editing|richtext|search|photos)\.spec\.ts/,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "off",
    // Honour a preinstalled Chromium when the sandbox provides one, rather
    // than downloading a browser at test time.
    launchOptions: process.env.CHROMIUM_PATH
      ? { executablePath: process.env.CHROMIUM_PATH }
      : {},
  },
  webServer: [
    {
      command: "node --experimental-sqlite ../server/src/index.js",
      env: { PORT: "8788", COMMS_DATA: dataDir, HOST: "127.0.0.1" },
      url: "http://127.0.0.1:8788/api/health",
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: "npx vite preview --port 4173 --strictPort --host 127.0.0.1",
      url: "http://127.0.0.1:4173",
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});

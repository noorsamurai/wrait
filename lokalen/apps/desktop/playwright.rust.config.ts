import { defineConfig } from "@playwright/test";

/**
 * The same browser suite, driven against the embedded Rust relay instead of
 * the Node one.
 *
 * This is the real check that the portable exe speaks the identical protocol:
 * the frontend and the tests are byte-for-byte the same, only the server
 * behind them changes.
 */
const dataDir = `./.e2e-data/rust-${Date.now().toString(36)}`;

export default defineConfig({
  testDir: "./e2e",
  // Everything except the screenshot run, which is a capture rather than a check.
  testMatch: /(messaging|tasks|rooms|editing)\.spec\.ts/,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "off",
    launchOptions: process.env.CHROMIUM_PATH
      ? { executablePath: process.env.CHROMIUM_PATH }
      : {},
  },
  webServer: [
    {
      command: "./src-tauri/target/debug/relay",
      env: { PORT: "8788", COMMS_DATA: dataDir },
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

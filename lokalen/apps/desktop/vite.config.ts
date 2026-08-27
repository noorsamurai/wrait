import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/** Tauri's dev server contract: a fixed port it can wait on, and no clever
 *  host rewriting, because the iOS simulator connects over the LAN. */
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    // Safari 13 is the floor for the iOS webview features used here.
    target: ["es2021", "chrome100", "safari13"],
    sourcemap: false,
    minify: "esbuild",
  },
});

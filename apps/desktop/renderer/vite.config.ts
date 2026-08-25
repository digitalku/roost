import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The renderer's build.
 *
 * `base: "./"` because a packaged build is loaded from `file://`, where an
 * absolute asset path resolves against the filesystem root rather than against
 * the app. Nothing here reaches outside this directory: the renderer has no
 * filesystem access, and its only door is `window.roost`.
 */
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Sourcemaps ship: this app makes no network requests, so there is nothing
    // to leak them to, and a stack trace from a user's crash report is worth
    // more than the bytes.
    sourcemap: true,
  },
  server: { port: 5173, strictPort: true },
});

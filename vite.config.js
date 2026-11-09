// The RobinCode window (web/) is a React app; server.mjs serves web/dist.
//   npm run build        once
//   npm run watch        rebuild on every change while working on the window
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const out = fileURLToPath(new URL("./web/dist", import.meta.url));

export default defineConfig({
  root: "web",
  base: "/",
  plugins: [
    react(),
    // vite's own emptyOutDir uses fs.rmSync, which on Node 24.13 for Windows
    // kills the process (0xC0000409, no message) on any path with Korean in it
    // (this repo sits in 바탕화면; 2026-11-09). fs.promises.rm does not
    { name: "robincode-clear-dist", apply: "build", buildStart: () => rm(out, { recursive: true, force: true }) },
  ],
  build: {
    outDir: "dist",
    emptyOutDir: false,
    chunkSizeWarningLimit: 2000,
  },
});

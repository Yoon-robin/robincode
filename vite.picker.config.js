// The folder window robincode.cmd and robincode-app.cmd open at startup
// (web/picker, React). Built into ops/windows/robincode-picker/, which is in
// git, so starting RobinCode needs no npm: robincode-ui.ps1 serves it.
// shadcn/ui style: Tailwind v4, cmdk, lucide, motion (all only for the build).
//   npm run build:picker      after changing web/picker
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const out = fileURLToPath(new URL("../ops/windows/robincode-picker", import.meta.url));

export default defineConfig({
  root: "web/picker",
  base: "./",
  plugins: [
    react(),
    tailwindcss(),
    // not vite's emptyOutDir: fs.rmSync dies on Korean paths here (vite.config.js)
    { name: "robincode-clear-picker", apply: "build", buildStart: () => rm(out, { recursive: true, force: true }) },
  ],
  build: {
    outDir: out,
    emptyOutDir: false,
    assetsDir: "assets",
    chunkSizeWarningLimit: 2000,
  },
});

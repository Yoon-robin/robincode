// The RobinCode window (web/) is a React app; server.mjs serves web/dist.
//   npm run build        once
//   npm run watch        rebuild on every change while working on the window
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "web",
  base: "/",
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000,
  },
});

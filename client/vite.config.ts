import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// VITE_BASE=/livevote/ for GitHub Pages project sites; "/" everywhere else.
export default defineConfig({
  base: process.env.VITE_BASE ?? "/",
  plugins: [react()],
  resolve: { alias: { "@livevote/shared": fileURLToPath(new URL("../shared/src/index.ts", import.meta.url)) } },
  server: { port: 5173, strictPort: true },
  build: { sourcemap: true, target: "es2022" },
});

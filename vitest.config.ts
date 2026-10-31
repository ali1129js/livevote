import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const shared = fileURLToPath(new URL("./shared/src/index.ts", import.meta.url));

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias: { "@livevote/shared": shared } },
        test: { name: "shared+server", environment: "node", include: ["shared/src/**/*.test.ts", "server/src/**/*.test.ts"] },
      },
      {
        plugins: [react()],
        resolve: { alias: { "@livevote/shared": shared } },
        test: {
          name: "client",
          environment: "jsdom",
          globals: true,
          include: ["client/src/**/*.test.{ts,tsx}"],
          setupFiles: ["client/vitest.setup.ts"],
          css: false,
        },
      },
    ],
  },
});

import { existsSync } from "node:fs";
import { defineConfig } from "@playwright/test";

const SERVER_PORT = 3101;
const CLIENT_PORT = 4173;
// Use a system Chrome if present (no browser download needed); otherwise Playwright's own Chromium.
const chrome = process.env.CHROME_PATH ?? ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((p) => existsSync(p));

export default defineConfig({
  testDir: "e2e",
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 7_000 },
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${CLIENT_PORT}`,
    viewport: { width: 1280, height: 900 },
    launchOptions: { ...(chrome ? { executablePath: chrome } : {}), args: ["--no-sandbox"] },
    trace: "off",
  },
  webServer: [
    {
      command: "npx tsx --tsconfig server/tsconfig.json server/src/index.ts",
      url: `http://localhost:${SERVER_PORT}/api/health`,
      env: {
        PORT: String(SERVER_PORT),
        CLIENT_ORIGIN: `http://localhost:${CLIENT_PORT}`,
        RATE_LIMIT_CREATE: "500",
        RATE_LIMIT_JOINS: "5000",
        RATE_LIMIT_EVENTS: "2000",
      },
      reuseExistingServer: false,
    },
    {
      command: `npm run build -w client && npm run preview -w client`,
      url: `http://localhost:${CLIENT_PORT}`,
      env: { VITE_SERVER_URL: `http://localhost:${SERVER_PORT}` },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});

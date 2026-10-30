import { createApp } from "./app";
import { loadConfig } from "./config";

const config = loadConfig();
const app = createApp({ config });
const port = await app.listen();
console.log(`[livevote] listening on :${port} (allowed origins: ${config.clientOrigins.join(", ")})`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.once(sig, () => {
    void app.close().finally(() => process.exit(0));
  });
}

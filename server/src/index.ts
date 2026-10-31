import { createApp } from "./app";
import { loadConfig } from "./config";
import { installProcessGuards } from "./processGuards";
import { createStore } from "./storeFactory";

const log = (msg: string) => console.log(`[livevote] ${msg}`);
installProcessGuards(log);
const config = loadConfig();
const store = createStore(config, log);
try {
  await store.init(); // creates the table on first run; fails fast on a bad DATABASE_URL
} catch (e) {
  // Print only the error class/code: driver messages can include the host and user.
  const err = e as { name?: string; code?: string };
  console.error(`[livevote] could not initialise the ${store.kind} store (${err.code ?? err.name ?? "error"}); check DATABASE_URL.`);
  process.exit(1);
}
const app = createApp({ config, store, log });
const port = await app.listen();
log(`listening on :${port} (store: ${store.kind}, allowed origins: ${config.clientOrigins.join(", ")})`);
if (!config.databaseUrl) log("DATABASE_URL not set: polls are kept in memory and are lost on restart or sleep.");

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.once(sig, () => {
    void app
      .close()
      .then(() => store.close())
      .catch(() => {})
      .finally(() => process.exit(0));
  });
}

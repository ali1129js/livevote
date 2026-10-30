import type { Config } from "./config";
import { MemoryPollStore } from "./memoryStore";
import { PgPollStore } from "./pgStore";
import type { PollStore } from "./store";

/** DATABASE_URL set => Postgres (persistent); otherwise the volatile in-memory store. */
export function createStore(config: Pick<Config, "databaseUrl">, log: (msg: string) => void = () => {}): PollStore {
  if (config.databaseUrl) return new PgPollStore({ connectionString: config.databaseUrl, log });
  return new MemoryPollStore();
}

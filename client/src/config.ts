const raw = import.meta.env.VITE_SERVER_URL as string | undefined;
/** Base URL of the LiveVote server. */
export const SERVER_URL = (raw && raw.length > 0 ? raw : "http://localhost:3001").replace(/\/+$/, "");
/** Show the "server waking up" state if we are not connected after this long. */
export const WAKING_AFTER_MS = 3500;
/** Give up creating a poll after this long overall (a cold Render instance + a cold Neon compute can take ~60 s). */
export const CREATE_TIMEOUT_MS = 90_000;

/** localStorage helpers that never throw (private mode, blocked storage). */
export function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
export function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

const VOTER_KEY = "livevote.voterId";
let memoryVoterId: string | null = null;

function randomId(): string {
  // randomUUID needs a secure context; plain-http LAN testing falls back to getRandomValues.
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** One id per browser; the server counts one vote per id (a deterrent, not a lock). */
export function getVoterId(): string {
  const existing = safeGet(VOTER_KEY);
  if (existing && /^[A-Za-z0-9_-]{16,64}$/.test(existing)) return existing;
  const id = memoryVoterId ?? randomId();
  memoryVoterId = id;
  safeSet(VOTER_KEY, id);
  return id;
}

export const hostTokenKey = (pollId: string): string => `livevote.host.${pollId}`;

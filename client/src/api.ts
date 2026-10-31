import type { CreatePollInput, CreatePollResult } from "@livevote/shared";
import { CREATE_TIMEOUT_MS, SERVER_URL, WAKING_AFTER_MS } from "./config";

export type ApiFailureKind = "validation" | "rate_limited" | "network" | "server" | "timeout";

export class ApiFailure extends Error {
  constructor(
    message: string,
    readonly kind: ApiFailureKind,
  ) {
    super(message);
  }
}

export const MSG_TIMEOUT = "The server didn't answer in time. It may still be waking up: wait a moment, then tap Create poll again.";
export const MSG_SERVER = "The server is having trouble right now. Please try again in a minute.";
/** Our own app answering 500 this many times means a real problem, not a cold start. */
const MAX_APP_ERRORS = 4;
export const MSG_OFFLINE = "You're offline. Check your connection and try again.";

export interface CreateOptions {
  /** Called if the server hasn't answered after WAKING_AFTER_MS (free-tier cold start), or as soon as an attempt fails and we retry. */
  onSlow?: () => void;
  signal?: AbortSignal;
  /** Overall deadline for the whole create, including retries (default CREATE_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Pause between attempts (default 2000). */
  retryDelayMs?: number;
}

type Envelope = { ok: true; data: CreatePollResult } | { ok: false; error: { code: string; message: string } };

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

/**
 * Creates a poll. A free Render instance that is asleep answers the first request late, with a proxy error (502/503/504)
 * or with nothing at all, so those are retried until the overall deadline instead of failing at the first hiccup.
 * Real answers from our app (validation, rate limit) are never retried. Uses AbortController + setTimeout rather than
 * AbortSignal.timeout/any, which older mobile Safari lacks (there the call would throw before sending anything).
 */
export async function createPoll(input: CreatePollInput, opts: CreateOptions = {}): Promise<CreatePollResult> {
  const deadline = new AbortController();
  const deadlineTimer = setTimeout(() => deadline.abort(), opts.timeoutMs ?? CREATE_TIMEOUT_MS);
  const slow = opts.onSlow ? setTimeout(opts.onSlow, WAKING_AFTER_MS) : undefined;
  const onCallerAbort = () => deadline.abort();
  opts.signal?.addEventListener("abort", onCallerAbort, { once: true });
  const abortedBy = (): ApiFailure =>
    opts.signal?.aborted ? new ApiFailure("Cancelled.", "network") : new ApiFailure(MSG_TIMEOUT, "timeout");
  try {
    let appErrors = 0;
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await fetch(`${SERVER_URL}/api/polls`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
          signal: deadline.signal,
        });
        const json = (await res.json().catch(() => null)) as Envelope | null;
        if (res.ok && json && json.ok) return json.data;
        if (json && !json.ok && json.error.code !== "server_error") {
          throw new ApiFailure(json.error.message, res.status === 429 ? "rate_limited" : res.status >= 500 ? "server" : "validation");
        }
        if (!json && res.status < 500) throw new ApiFailure("The server sent an unexpected answer. Please try again.", "server");
        if (json && !json.ok && ++appErrors >= MAX_APP_ERRORS) throw new ApiFailure(MSG_SERVER, "server");
        // Otherwise: no JSON from our app (a proxy error page while the instance boots) or a transient server_error. Retry.
      } catch (e) {
        if (e instanceof ApiFailure) throw e;
        if (deadline.signal.aborted) throw abortedBy();
        if (typeof navigator !== "undefined" && navigator.onLine === false) throw new ApiFailure(MSG_OFFLINE, "network");
        // A network error (connection refused/reset, or a CORS-less proxy error while waking). Retry.
      }
      opts.onSlow?.();
      await sleep(opts.retryDelayMs ?? Math.min(2000 + attempt * 500, 5000), deadline.signal);
      if (deadline.signal.aborted) throw abortedBy();
    }
  } finally {
    clearTimeout(deadlineTimer);
    if (slow) clearTimeout(slow);
    opts.signal?.removeEventListener("abort", onCallerAbort);
  }
}

/** Pings the health endpoint (8 s cap per ping) so a sleeping server starts waking while the host types. */
export async function pingHealth(signal?: AbortSignal): Promise<boolean> {
  const cap = new AbortController();
  const t = setTimeout(() => cap.abort(), 8000);
  const onAbort = () => cap.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await fetch(`${SERVER_URL}/api/health`, { signal: cap.signal, cache: "no-store" });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
    signal?.removeEventListener("abort", onAbort);
  }
}

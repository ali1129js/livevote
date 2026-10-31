import type { CreatePollInput, CreatePollResult } from "@livevote/shared";
import { SERVER_URL, WAKING_AFTER_MS } from "./config";

export class ApiFailure extends Error {
  constructor(
    message: string,
    readonly kind: "validation" | "rate_limited" | "network" | "server",
  ) {
    super(message);
  }
}

export interface CreateOptions {
  /** Called if the server hasn't answered after WAKING_AFTER_MS (free-tier cold start). */
  onSlow?: () => void;
  signal?: AbortSignal;
}

export async function createPoll(input: CreatePollInput, opts: CreateOptions = {}): Promise<CreatePollResult> {
  const slow = opts.onSlow ? setTimeout(opts.onSlow, WAKING_AFTER_MS) : undefined;
  const timeout = AbortSignal.timeout(75_000);
  try {
    const res = await fetch(`${SERVER_URL}/api/polls`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
      signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
    });
    const json = (await res.json().catch(() => null)) as
      | { ok: true; data: CreatePollResult }
      | { ok: false; error: { code: string; message: string } }
      | null;
    if (res.ok && json && json.ok) return json.data;
    if (json && !json.ok) {
      throw new ApiFailure(
        json.error.message,
        res.status === 429 ? "rate_limited" : res.status >= 500 ? "server" : "validation",
      );
    }
    throw new ApiFailure("The server sent an unexpected answer. Please try again.", "server");
  } catch (e) {
    if (e instanceof ApiFailure) throw e;
    throw new ApiFailure("Couldn't reach the server. Check your connection and try again.", "network");
  } finally {
    if (slow) clearTimeout(slow);
  }
}

/** Pings the health endpoint until it answers, so a sleeping server starts waking while the host types. */
export async function pingHealth(signal?: AbortSignal): Promise<boolean> {
  try {
    const res = await fetch(`${SERVER_URL}/api/health`, { ...(signal ? { signal } : {}), cache: "no-store" });
    return res.ok;
  } catch {
    return false;
  }
}

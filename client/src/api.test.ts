import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiFailure, MSG_OFFLINE, MSG_SERVER, MSG_TIMEOUT, createPoll, pingHealth } from "./api";

const input = { question: "Where do we eat?", options: ["Italiano", "Sushi"], multiple: false, allowAddOwn: true, closesAt: null };
const created = { pollId: "abcd2345xy", hostToken: "secret-token-value-123" };

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const proxyError = (status = 503) => new Response("<html>Service Unavailable</html>", { status });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Settle the promise while advancing fake time, without leaving an unhandled rejection behind. */
async function settle<T>(p: Promise<T>, advanceMs = 120_000): Promise<{ value?: T; error?: unknown }> {
  const out = p.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await vi.advanceTimersByTimeAsync(advanceMs);
  return out;
}

describe("createPoll against a cold server (regression: 'Create poll does nothing')", () => {
  it("works first time on a warm server", async () => {
    fetchMock.mockResolvedValueOnce(json(201, { ok: true, data: created }));
    expect((await settle(createPoll(input))).value).toEqual(created);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not need AbortSignal.timeout / AbortSignal.any (missing on older mobile Safari)", async () => {
    vi.stubGlobal("AbortSignal", class FakeSignal extends EventTarget {} as unknown);
    const orig = globalThis.AbortController;
    fetchMock.mockResolvedValueOnce(json(201, { ok: true, data: created }));
    expect((await settle(createPoll(input))).value).toEqual(created);
    expect(globalThis.AbortController).toBe(orig);
  });

  it("retries proxy 503s while the instance boots, tells the UI it's slow, then succeeds", async () => {
    const onSlow = vi.fn();
    fetchMock
      .mockResolvedValueOnce(proxyError(503))
      .mockResolvedValueOnce(proxyError(502))
      .mockResolvedValueOnce(json(201, { ok: true, data: created }));
    const r = await settle(createPoll(input, { onSlow }));
    expect(r.value).toEqual(created);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(onSlow).toHaveBeenCalled();
  });

  it("retries network failures (a CORS-less proxy error surfaces as a TypeError) and then succeeds", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValueOnce(json(201, { ok: true, data: created }));
    expect((await settle(createPoll(input))).value).toEqual(created);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a transient server_error (e.g. Neon still resuming) but gives up after a few", async () => {
    fetchMock.mockImplementation(async () => json(500, { ok: false, error: { code: "server_error", message: "Something went wrong." } }));
    const r = await settle(createPoll(input));
    expect(r.error).toBeInstanceOf(ApiFailure);
    expect((r.error as ApiFailure).message).toBe(MSG_SERVER);
    expect((r.error as ApiFailure).kind).toBe("server");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("never retries real answers: validation and rate limits come straight back", async () => {
    fetchMock.mockResolvedValueOnce(
      json(400, { ok: false, error: { code: "bad_request", message: "Question must have at least 3 characters." } }),
    );
    const v = await settle(createPoll(input));
    expect((v.error as ApiFailure).kind).toBe("validation");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce(json(429, { ok: false, error: { code: "rate_limited", message: "Too many polls created." } }));
    const rl = await settle(createPoll(input));
    expect((rl.error as ApiFailure).kind).toBe("rate_limited");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("times out with a clear message instead of hanging forever when the server never answers", async () => {
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_res, rej) => init.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")))),
    );
    const r = await settle(createPoll(input, { timeoutMs: 60_000 }), 61_000);
    expect(r.error).toBeInstanceOf(ApiFailure);
    expect((r.error as ApiFailure).kind).toBe("timeout");
    expect((r.error as ApiFailure).message).toBe(MSG_TIMEOUT);
    expect(MSG_TIMEOUT).toMatch(/wake|waking/i);
    expect(MSG_TIMEOUT).toMatch(/Create poll again/);
  });

  it("times out between retries too (server keeps failing fast)", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const r = await settle(createPoll(input, { timeoutMs: 10_000 }), 11_000);
    expect((r.error as ApiFailure).kind).toBe("timeout");
  });

  it("fails fast with an offline message when the browser is offline", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const r = await settle(createPoll(input), 100);
    expect((r.error as ApiFailure).message).toBe(MSG_OFFLINE);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("can be cancelled by the caller", async () => {
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_res, rej) => init.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")))),
    );
    const ctrl = new AbortController();
    const p = settle(createPoll(input, { signal: ctrl.signal }), 100);
    ctrl.abort();
    expect(((await p).error as ApiFailure).message).toBe("Cancelled.");
  });

  it("rejects a 200 that isn't our JSON instead of silently doing nothing", async () => {
    fetchMock.mockResolvedValueOnce(new Response("<html>hi</html>", { status: 200 }));
    const r = await settle(createPoll(input));
    expect((r.error as ApiFailure).message).toMatch(/unexpected answer/);
  });
});

describe("pingHealth", () => {
  it("is true on 200, false on failure, and caps a hung ping at 8 s", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 200 }));
    expect((await settle(pingHealth(), 10)).value).toBe(true);
    fetchMock.mockRejectedValueOnce(new TypeError("x"));
    expect((await settle(pingHealth(), 10)).value).toBe(false);
    fetchMock.mockImplementationOnce(
      (_u: string, init: RequestInit) => new Promise((_r, rej) => init.signal?.addEventListener("abort", () => rej(new Error("aborted")))),
    );
    expect((await settle(pingHealth(), 8100)).value).toBe(false);
  });
});

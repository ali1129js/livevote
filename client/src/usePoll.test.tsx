import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeState, sampleResults } from "./test/fixtures";

// ---- A tiny fake Socket.IO client -----------------------------------------------------------
type Handler = (...a: unknown[]) => void;
class FakeSocket {
  connected = false;
  handlers = new Map<string, Handler[]>();
  emitted: Array<{ event: string; args: unknown[] }> = [];
  joinReply: unknown = { ok: true, data: makeState() };
  on(e: string, h: Handler) {
    this.handlers.set(e, [...(this.handlers.get(e) ?? []), h]);
    return this;
  }
  removeAllListeners() {
    this.handlers.clear();
    return this;
  }
  disconnect() {
    this.connected = false;
    return this;
  }
  trigger(e: string, ...a: unknown[]) {
    for (const h of this.handlers.get(e) ?? []) h(...a);
  }
  timeout() {
    return {
      emit: (event: string, ...args: unknown[]) => {
        this.emitted.push({ event, args });
        const cb = args[args.length - 1] as (err: Error | null, ack?: unknown) => void;
        if (event === "poll:join") cb(null, this.joinReply);
        else cb(null, { ok: true });
      },
    };
  }
  connect() {
    this.connected = true;
    this.trigger("connect");
  }
}
let fake: FakeSocket;
vi.mock("socket.io-client", () => ({ io: () => fake }));

import { usePoll } from "./usePoll";

beforeEach(() => {
  vi.useFakeTimers();
  fake = new FakeSocket();
});
afterEach(() => vi.useRealTimers());

describe("usePoll", () => {
  it("joins with the voter id (and host token) on connect and exposes the state", () => {
    const { result } = renderHook(() => usePoll("abcdefghjk", "host-token-123456"));
    expect(result.current.connection).toBe("connecting");
    act(() => fake.connect());
    expect(result.current.connection).toBe("online");
    expect(result.current.state?.poll.question).toBe("Where do we eat?");
    const join = fake.emitted.find((e) => e.event === "poll:join")!;
    expect(join.args[0]).toMatchObject({ pollId: "abcdefghjk", hostToken: "host-token-123456" });
    expect((join.args[0] as { voterId: string }).voterId).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
  });

  it("does not send a host token for voters", () => {
    renderHook(() => usePoll("abcdefghjk", null));
    act(() => fake.connect());
    expect(fake.emitted[0]!.args[0]).not.toHaveProperty("hostToken");
  });

  it("applies pushed state (live results) and computes the server clock offset", () => {
    const { result } = renderHook(() => usePoll("abcdefghjk", null));
    act(() => fake.connect());
    const pushed = makeState({ myVote: { optionIds: ["o1"], people: 2 }, results: sampleResults(), serverNow: Date.now() + 5000 });
    act(() => fake.trigger("poll:state", pushed));
    expect(result.current.state?.results?.voters).toBe(3);
    expect(result.current.clockOffset).toBeGreaterThanOrEqual(4900);
  });

  it("shows 'waking' after 3.5 s without a connection, counts seconds, and recovers by itself", () => {
    const { result } = renderHook(() => usePoll("abcdefghjk", null));
    act(() => void vi.advanceTimersByTime(2000));
    expect(result.current.connection).toBe("connecting");
    act(() => void vi.advanceTimersByTime(2000));
    expect(result.current.connection).toBe("waking");
    act(() => void vi.advanceTimersByTime(26_000));
    expect(result.current.connection).toBe("waking");
    expect(result.current.waitedSeconds).toBeGreaterThanOrEqual(29);
    act(() => fake.connect()); // Render finished booting
    expect(result.current.connection).toBe("online");
  });

  it("reconnect: goes to 'reconnecting', then re-joins and refreshes state", () => {
    const { result } = renderHook(() => usePoll("abcdefghjk", null));
    act(() => fake.connect());
    act(() => {
      fake.connected = false;
      fake.trigger("disconnect", "transport close");
    });
    expect(result.current.connection).toBe("reconnecting");
    expect(result.current.state).not.toBeNull(); // the poll stays on screen
    fake.joinReply = { ok: true, data: makeState({ myVote: { optionIds: ["o2"], people: 4 }, results: sampleResults() }) };
    act(() => fake.connect());
    expect(result.current.connection).toBe("online");
    expect(result.current.state?.myVote).toEqual({ optionIds: ["o2"], people: 4 });
    expect(fake.emitted.filter((e) => e.event === "poll:join")).toHaveLength(2);
  });

  it("a poll that doesn't exist is a fatal state", () => {
    fake.joinReply = { ok: false, error: { code: "not_found", message: "This poll doesn't exist or has expired." } };
    const { result } = renderHook(() => usePoll("abcdefghjk", null));
    act(() => fake.connect());
    expect(result.current.fatal?.code).toBe("not_found");
    expect(result.current.state).toBeNull();
  });

  it("poll:gone (expired) is fatal", () => {
    const { result } = renderHook(() => usePoll("abcdefghjk", null));
    act(() => fake.connect());
    act(() => fake.trigger("poll:gone"));
    expect(result.current.fatal?.message).toMatch(/expired/);
  });

  it("actions send the right events and fail gracefully when offline", async () => {
    const { result } = renderHook(() => usePoll("abcdefghjk", null));
    const offline = await result.current.actions.vote(["o1"], 2);
    expect(offline.ok).toBe(false);
    act(() => fake.connect());
    await act(async () => void (await result.current.actions.vote(["o1"], 2)));
    await act(async () => void (await result.current.actions.addOption("Pho")));
    await act(async () => void (await result.current.actions.removeOption("o3")));
    const events = fake.emitted.map((e) => e.event);
    expect(events).toEqual(["poll:join", "vote:cast", "option:add", "host:removeOption"]);
    expect(fake.emitted[1]!.args[0]).toEqual({ optionIds: ["o1"], people: 2 });
  });

  it("cleans up the socket on unmount", () => {
    const { unmount } = renderHook(() => usePoll("abcdefghjk", null));
    act(() => fake.connect());
    unmount();
    expect(fake.connected).toBe(false);
    expect(fake.handlers.size).toBe(0);
  });
});

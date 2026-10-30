import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { io as connect, type Socket } from "socket.io-client";
import type { Ack, ClientState, ClientToServerEvents, CreatePollResult, ServerToClientEvents } from "@livevote/shared";
import { createApp, type RunningApp } from "./app";
import type { Config } from "./config";

type Client = Socket<ServerToClientEvents, ClientToServerEvents>;

const ORIGIN = "http://localhost:5173";
const config: Config = { port: 0, clientOrigins: [ORIGIN], trustProxyHops: 0, production: false, databaseUrl: null, limits: { createPer10Min: 10, joinsPerMinPerIp: 60, eventsPer10sPerSocket: 30 } };
const vid = (n: number) => `integration-voter-${String(n).padStart(4, "0")}`;
const body = { question: "Where do we eat tonight?", options: ["Italiano", "Sushi", "Thai"], multiple: false, allowAddOwn: true, closesAt: null };

let app: RunningApp;
let base: string;
let clients: Client[] = [];

async function startApp(limits: Parameters<typeof createApp>[0]["limits"] = {}, clock?: () => number) {
  app = createApp({ config, log: () => undefined, limits, ...(clock ? { clock } : {}) });
  const port = await app.listen(0);
  base = `http://127.0.0.1:${port}`;
}

async function createPoll(extra: Record<string, unknown> = {}): Promise<CreatePollResult> {
  const res = await fetch(`${base}/api/polls`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ ...body, ...extra }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: CreatePollResult }).data;
}

function client(): Client {
  const c: Client = connect(base, { transports: ["websocket"], forceNew: true, reconnection: false, extraHeaders: { origin: ORIGIN } });
  clients.push(c);
  return c;
}

const emitAck = <T = undefined>(c: Client, ev: keyof ClientToServerEvents, ...args: unknown[]) =>
  new Promise<Ack<T>>((resolve) => {
    (c.emit as (...a: unknown[]) => void)(ev, ...args, resolve);
  });

const nextState = (c: Client) => new Promise<ClientState>((resolve) => c.once("poll:state", resolve));

async function join(pollId: string, n: number, hostToken?: string) {
  const c = client();
  const res = await emitAck<ClientState>(c, "poll:join", { pollId, voterId: vid(n), ...(hostToken ? { hostToken } : {}) });
  return { c, res };
}
const data = <T>(a: Ack<T>): T => {
  if (!a.ok) throw new Error(`expected ok, got ${a.error.code}`);
  return (a as { data: T }).data;
};

beforeEach(async () => {
  await startApp();
});
afterEach(async () => {
  for (const c of clients) c.disconnect();
  clients = [];
  await app.close();
});

describe("HTTP", () => {
  it("health check responds", async () => {
    const res = await fetch(`${base}/api/health`);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("creates a poll and returns a host token", async () => {
    const r = await createPoll();
    expect(r.pollId).toHaveLength(10);
    expect(r.hostToken.length).toBeGreaterThan(20);
  });

  it("rejects invalid polls with 400 and a message", async () => {
    const res = await fetch(`${base}/api/polls`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, options: ["one"] }) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("bad_request");
  });

  it("rejects malformed JSON and oversized bodies without leaking internals", async () => {
    const bad = await fetch(`${base}/api/polls`, { method: "POST", headers: { "content-type": "application/json" }, body: "{nope" });
    expect(bad.status).toBe(400);
    const big = await fetch(`${base}/api/polls`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, question: "x".repeat(20_000) }) });
    expect(big.status).toBe(413);
    expect(await big.text()).not.toMatch(/at .*\.(js|ts)/);
  });

  it("answers 404 in JSON", async () => {
    const res = await fetch(`${base}/nothing`);
    expect(res.status).toBe(404);
  });

  it("only sends CORS headers to the configured client origin", async () => {
    const allowed = await fetch(`${base}/api/health`, { headers: { origin: ORIGIN } });
    expect(allowed.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    const evil = await fetch(`${base}/api/health`, { headers: { origin: "https://evil.example" } });
    expect(evil.headers.get("access-control-allow-origin")).toBeNull();
    const post = await fetch(`${base}/api/polls`, { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: JSON.stringify(body) });
    expect(post.status).toBe(403);
  });

  it("handles a CORS preflight for the client origin", async () => {
    const res = await fetch(`${base}/api/polls`, {
      method: "OPTIONS",
      headers: { origin: ORIGIN, "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  });
});

describe("Socket.IO flow", () => {
  it("lets a late joiner see the ballot but no results; after voting they get results", async () => {
    const { pollId } = await createPoll();
    const { c, res } = await join(pollId, 1);
    const st = data(res);
    expect(st.poll.question).toBe(body.question);
    expect(st.poll.options.map((o) => o.label)).toEqual(["Italiano", "Sushi", "Thai"]);
    expect(st.results).toBeNull();
    expect(st.isHost).toBe(false);

    const pushed = nextState(c);
    const ack = await emitAck(c, "vote:cast", { optionIds: ["o1"], people: 3 });
    expect(ack.ok).toBe(true);
    const after = await pushed;
    expect(after.myVote).toEqual({ optionIds: ["o1"], people: 3 });
    expect(after.results?.options[0]).toMatchObject({ label: "Italiano", votes: 1, people: 3 });
  });

  it("pushes live updates to other viewers (host sees them, a non-voter does not)", async () => {
    const { pollId, hostToken } = await createPoll();
    const host = await join(pollId, 100, hostToken);
    expect(data(host.res).isHost).toBe(true);
    expect(data(host.res).results).not.toBeNull();
    const lurker = await join(pollId, 200);

    const hostUpdate = nextState(host.c);
    const lurkerUpdate = nextState(lurker.c);
    const voter = await join(pollId, 1);
    await emitAck(voter.c, "vote:cast", { optionIds: ["o2"], people: 5 });

    const h = await hostUpdate;
    expect(h.results?.options[0]).toMatchObject({ label: "Sushi", votes: 1, people: 5 });
    const l = await lurkerUpdate;
    expect(l.results).toBeNull(); // hasn't voted yet: no peeking
    expect(l.poll.options).toHaveLength(3);
  });

  it("delivers a live update within about a second", async () => {
    const { pollId, hostToken } = await createPoll();
    const host = await join(pollId, 100, hostToken);
    const voter = await join(pollId, 1);
    const upd = nextState(host.c);
    const t0 = Date.now();
    await emitAck(voter.c, "vote:cast", { optionIds: ["o1"], people: 1 });
    await upd;
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("add-your-own appears live for everyone and can be voted on", async () => {
    const { pollId } = await createPoll();
    const a = await join(pollId, 1);
    const b = await join(pollId, 2);
    const bUpdate = nextState(b.c);
    const added = await emitAck<{ optionId: string; merged: boolean }>(a.c, "option:add", { label: "Burger Barn" });
    expect(data(added).merged).toBe(false);
    const st = await bUpdate;
    expect(st.poll.options.at(-1)).toMatchObject({ label: "Burger Barn", addedByVoter: true });
    const vote = await emitAck(b.c, "vote:cast", { optionIds: [data(added).optionId], people: 2 });
    expect(vote.ok).toBe(true);
    // the second add by the same voter is refused
    const again = await emitAck(a.c, "option:add", { label: "Pho" });
    expect(again.ok).toBe(false);
  });

  it("merges a near-duplicate", async () => {
    const { pollId } = await createPoll();
    const a = await join(pollId, 1);
    const res = await emitAck<{ optionId: string; merged: boolean }>(a.c, "option:add", { label: "  sushi!! " });
    expect(data(res)).toEqual({ optionId: "o2", merged: true });
  });

  it("lets a voter change their vote and keeps one vote per voter id across connections", async () => {
    const { pollId, hostToken } = await createPoll();
    const host = await join(pollId, 100, hostToken);
    const first = await join(pollId, 1);
    await emitAck(first.c, "vote:cast", { optionIds: ["o1"], people: 2 });
    // same browser (voter id), new tab / reconnect
    const again = await join(pollId, 1);
    expect(data(again.res).myVote).toEqual({ optionIds: ["o1"], people: 2 });
    expect(data(again.res).results).not.toBeNull();
    await emitAck(again.c, "vote:cast", { optionIds: ["o3"], people: 4 });
    const st = data(await emitAck<ClientState>(host.c, "poll:join", { pollId, voterId: vid(100), hostToken }));
    expect(st.results?.voters).toBe(1);
    expect(st.results?.options.find((o) => o.label === "Thai")).toMatchObject({ votes: 1, people: 4 });
    expect(st.results?.options.find((o) => o.label === "Italiano")?.votes).toBe(0);
  });

  it("restores state after a reconnect (new socket, same voter id)", async () => {
    const { pollId } = await createPoll();
    const v = await join(pollId, 1);
    await emitAck(v.c, "vote:cast", { optionIds: ["o2"], people: 1 });
    v.c.disconnect();
    const back = await join(pollId, 1);
    expect(data(back.res).myVote?.optionIds).toEqual(["o2"]);
  });

  it("host can remove an option, close, and reset; others can't", async () => {
    const { pollId, hostToken } = await createPoll();
    const host = await join(pollId, 100, hostToken);
    const voter = await join(pollId, 1);
    expect((await emitAck(voter.c, "host:close")).ok).toBe(false);
    expect((await emitAck(voter.c, "host:removeOption", { optionId: "o3" })).ok).toBe(false);

    const voterUpdate = nextState(voter.c);
    expect((await emitAck(host.c, "host:removeOption", { optionId: "o3" })).ok).toBe(true);
    expect((await voterUpdate).poll.options.map((o) => o.id)).toEqual(["o1", "o2"]);

    await emitAck(voter.c, "vote:cast", { optionIds: ["o1"], people: 6 });
    const closed = nextState(voter.c);
    expect((await emitAck(host.c, "host:close")).ok).toBe(true);
    const cs = await closed;
    expect(cs.poll).toMatchObject({ closed: true, closedBy: "host" });
    expect(cs.results?.summary).toBe("Winner: Italiano (1 vote, 6 people) · 6 people in total, 1 voter");
    const late = await emitAck(voter.c, "vote:cast", { optionIds: ["o2"], people: 1 });
    expect(late.ok === false && late.error.code).toBe("closed");

    const reopened = nextState(voter.c);
    expect((await emitAck(host.c, "host:reset")).ok).toBe(true);
    const rs = await reopened;
    expect(rs.poll.closed).toBe(false);
    expect(rs.results).toBeNull();
    expect(rs.myVote).toBeNull();
  });

  it("closes automatically at the closing time and tells connected clients", async () => {
    // A real-time timer: use a clock we can advance, with the close 1.2s away.
    await app.close();
    let offset = 0;
    await startApp({}, () => Date.now() + offset);
    const { pollId } = await createPoll({ closesAt: Date.now() + 61_000 });
    const v = await join(pollId, 1);
    expect(data(v.res).poll.closed).toBe(false);
    expect(data(v.res).results).toBeNull();
    offset = 61_100; // time passes
    // a new action observes closure
    const res = await emitAck(v.c, "vote:cast", { optionIds: ["o1"], people: 1 });
    expect(res.ok === false && res.error.code).toBe("closed");
    const re = await join(pollId, 2);
    expect(data(re.res).poll).toMatchObject({ closed: true, closedBy: "time" });
    expect(data(re.res).results).not.toBeNull();
  });

  it("pushes the closed state to connected clients when the closing time passes", async () => {
    await app.close();
    let offset = 0;
    await startApp({}, () => Date.now() + offset);
    const { pollId } = await createPoll({ closesAt: Date.now() + 61_000 });
    const waiting = await join(pollId, 1);
    expect(data(waiting.res).poll.closed).toBe(false);
    offset = 60_500; // 0.5 s of real time left; the next join (re)arms the close timer
    const pushed = nextState(waiting.c);
    await join(pollId, 2);
    const st = await pushed;
    expect(st.poll).toMatchObject({ closed: true, closedBy: "time" });
    expect(st.results).not.toBeNull(); // closing unlocks results even for non-voters
  });

  it("refuses wrong host tokens, bad ids and unknown polls", async () => {
    const { pollId } = await createPoll();
    const c = client();
    expect((await emitAck(c, "poll:join", { pollId, voterId: vid(1), hostToken: "nope" })).ok).toBe(false);
    expect((await emitAck(c, "poll:join", { pollId, voterId: "x" })).ok).toBe(false);
    const missing = await emitAck(c, "poll:join", { pollId: "doesnotexist", voterId: vid(1) });
    expect(missing.ok === false && missing.error.code).toBe("not_found");
    const junk = await emitAck(c, "poll:join", null);
    expect(junk.ok).toBe(false);
  });

  it("requires joining before voting", async () => {
    const c = client();
    const res = await emitAck(c, "vote:cast", { optionIds: ["o1"], people: 1 });
    expect(res.ok === false && res.error.code).toBe("not_joined");
  });

  it("never echoes the host token or other voters' ids in any state", async () => {
    const { pollId, hostToken } = await createPoll();
    const host = await join(pollId, 100, hostToken);
    const v = await join(pollId, 1);
    const upd = nextState(host.c);
    await emitAck(v.c, "vote:cast", { optionIds: ["o1"], people: 1 });
    const text = JSON.stringify([data(host.res), await upd]);
    expect(text).not.toContain(hostToken);
    expect(text).not.toContain(vid(1));
  });
});

describe("rate limiting", () => {
  it("limits poll creation per IP", async () => {
    await app.close();
    await startApp({ createPerWindow: 2 });
    await createPoll();
    await createPoll();
    const res = await fetch(`${base}/api/polls`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(res.status).toBe(429);
  });

  it("limits events per socket", async () => {
    await app.close();
    await startApp({ eventsPerSocket: 5 });
    const { pollId } = await createPoll();
    const { c } = await join(pollId, 1);
    const results: boolean[] = [];
    for (let i = 0; i < 8; i++) {
      const r = await emitAck(c, "vote:cast", { optionIds: ["o1"], people: 1 });
      results.push(r.ok || r.error.code !== "rate_limited");
    }
    expect(results.filter((x) => !x).length).toBeGreaterThanOrEqual(3);
  });

  it("limits joins per IP", async () => {
    await app.close();
    await startApp({ joinsPerIp: 3 });
    const { pollId } = await createPoll();
    const outcomes: string[] = [];
    for (let i = 1; i <= 5; i++) {
      const { res } = await join(pollId, i);
      outcomes.push(res.ok ? "ok" : res.error.code);
    }
    expect(outcomes).toEqual(["ok", "ok", "ok", "rate_limited", "rate_limited"]);
  });
});

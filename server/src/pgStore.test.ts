import { EventEmitter } from "node:events";
import { newDb } from "pg-mem";
import { connect, type Socket } from "socket.io-client";
import { describe, expect, it, vi } from "vitest";
import type { Ack, ClientState, ClientToServerEvents, CreatePollResult, ServerToClientEvents } from "@livevote/shared";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { MemoryPollStore } from "./memoryStore";
import { PgPollStore, type PgClientLike, type PgPoolLike } from "./pgStore";
import { createStore } from "./storeFactory";

/** A scripted fake pool: records every SQL statement and can inject failures. */
function fakePool(
  script: {
    connectFailures?: Error[];
    failOn?: (sql: string) => Error | null;
  } = {},
) {
  const sqls: string[] = [];
  const released: unknown[] = [];
  const failures = [...(script.connectFailures ?? [])];
  const client: PgClientLike = {
    async query(sql: string) {
      sqls.push(sql.trim().split(/\s+/).slice(0, 3).join(" "));
      const err = script.failOn?.(sql);
      if (err) throw err;
      if (/FOR UPDATE/.test(sql)) {
        return {
          rows: [
            {
              id: "p1",
              host_token_hash: "00",
              question: "q?",
              options: [],
              next_option_seq: 1,
              multiple: false,
              allow_add_own: false,
              closes_at: null,
              closed_at: null,
              created_at: "1",
              expires_at: "2",
              votes: {},
              adders: [],
            },
          ],
        };
      }
      return { rows: [] };
    },
    release: (destroy) => void released.push(destroy ?? false),
  };
  const pool: PgPoolLike = {
    async connect() {
      const f = failures.shift();
      if (f) throw f;
      return client;
    },
    async end() {},
  };
  return { pool, sqls, released };
}

describe("PgPollStore transaction handling", () => {
  it("wraps update in BEGIN ... FOR UPDATE ... COMMIT and releases the client", async () => {
    const f = fakePool();
    const store = new PgPollStore({ pool: f.pool, skipSchemaSetup: true });
    const res = await store.update("p1", (d) => d.createdAt);
    expect(res?.result).toBe(1); // bigint strings are parsed to numbers
    expect(f.sqls[0]).toBe("BEGIN");
    expect(f.sqls[1]).toMatch(/^SELECT/);
    expect(f.sqls.at(-2)).toMatch(/^UPDATE/);
    expect(f.sqls.at(-1)).toBe("COMMIT");
    expect(f.released).toEqual([false]);
  });

  it("rolls back and rethrows when mutate throws, without writing", async () => {
    const f = fakePool();
    const store = new PgPollStore({ pool: f.pool, skipSchemaSetup: true });
    await expect(
      store.update("p1", () => {
        throw new Error("nope");
      }),
    ).rejects.toThrow("nope");
    expect(f.sqls).toContain("ROLLBACK");
    expect(f.sqls).not.toContain("COMMIT");
    expect(f.sqls.some((s) => s.startsWith("UPDATE"))).toBe(false);
    expect(f.released).toEqual([false]);
  });

  it("destroys the connection when it was lost mid-transaction", async () => {
    const lost = Object.assign(new Error("Connection terminated unexpectedly"), { code: "57P01" });
    const f = fakePool({
      failOn: (sql) => (/FOR UPDATE/.test(sql) ? lost : /ROLLBACK/.test(sql) ? lost : null),
    });
    const store = new PgPollStore({ pool: f.pool, skipSchemaSetup: true });
    await expect(store.update("p1", () => 1)).rejects.toThrow(/terminated/);
    expect(f.released).toEqual([true, true]); // original try + the one retry on a fresh connection, both destroyed
  });
});

describe("PgPollStore connection retries", () => {
  it("retries transient connect failures (e.g. a cold Neon compute) and then succeeds", async () => {
    const f = fakePool({
      connectFailures: [new Error("timeout exceeded when trying to connect"), new Error("ECONNRESET")],
    });
    const store = new PgPollStore({
      pool: f.pool,
      skipSchemaSetup: true,
      retryDelayMs: 0,
    });
    expect(await store.get("p1")).toBeNull();
  });

  it("gives up after 3 attempts", async () => {
    const connect = vi.fn(async () => {
      throw new Error("down");
    });
    const store = new PgPollStore({
      pool: { connect, end: async () => {} },
      skipSchemaSetup: true,
      retryDelayMs: 0,
    });
    await expect(store.get("x")).rejects.toThrow("down");
    expect(connect).toHaveBeenCalledTimes(3);
  });

  it("does not retry authentication errors", async () => {
    const connect = vi.fn(async () => {
      throw Object.assign(new Error("password authentication failed"), {
        code: "28P01",
      });
    });
    const store = new PgPollStore({
      pool: { connect, end: async () => {} },
      skipSchemaSetup: true,
      retryDelayMs: 0,
    });
    await expect(store.get("x")).rejects.toThrow();
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("creates the schema once, lazily, and rejects unsafe table names", async () => {
    const f = fakePool();
    const store = new PgPollStore({ pool: f.pool });
    await store.get("a");
    await store.get("b");
    expect(f.sqls.filter((s) => s.startsWith("CREATE TABLE"))).toHaveLength(1);
    expect(() => new PgPollStore({ pool: f.pool, table: "x; DROP TABLE y" })).toThrow();
  });
});

describe("store selection (DATABASE_URL)", () => {
  it("falls back to the in-memory store when DATABASE_URL is unset", () => {
    expect(createStore(loadConfig({}))).toBeInstanceOf(MemoryPollStore);
    expect(createStore(loadConfig({ DATABASE_URL: "  " }))).toBeInstanceOf(MemoryPollStore);
  });
  it("uses Postgres when DATABASE_URL is set (connects lazily)", async () => {
    const store = createStore(loadConfig({ DATABASE_URL: "postgresql://user:pw@127.0.0.1:1/db" }));
    expect(store).toBeInstanceOf(PgPollStore);
    expect(store.kind).toBe("postgres");
    expect(store.sweepIntervalMs).toBeGreaterThanOrEqual(60 * 60_000); // rare sweeps let a scale-to-zero DB sleep
    await store.close();
  });
});

describe("end to end: a poll survives a server restart", () => {
  it("serves the same poll, votes and host rights after the app is rebuilt on the same database", async () => {
    const ORIGIN = "http://localhost:5173";
    const config = loadConfig({});
    const db = newDb();
    const open = (skip: boolean) => {
      const { Pool } = db.adapters.createPg();
      return new PgPollStore({
        pool: new Pool() as unknown as PgPoolLike,
        skipSchemaSetup: skip,
      });
    };
    type Client = Socket<ServerToClientEvents, ClientToServerEvents>;
    const sockets: Client[] = [];
    const emitAck = <T>(c: Client, ev: keyof ClientToServerEvents, ...args: unknown[]) =>
      new Promise<Ack<T>>((resolve) => (c.emit as (...a: unknown[]) => void)(ev, ...args, resolve));
    const join = async (base: string, payload: object) => {
      const c: Client = connect(base, {
        transports: ["websocket"],
        forceNew: true,
        reconnection: false,
        extraHeaders: { origin: ORIGIN },
      });
      sockets.push(c);
      return emitAck<ClientState>(c, "poll:join", payload);
    };

    const store1 = open(false);
    await store1.init();
    const app1 = createApp({ config, store: store1, log: () => undefined });
    const base1 = `http://127.0.0.1:${await app1.listen(0)}`;
    const created = (await (
      await fetch(`${base1}/api/polls`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({
          question: "Where do we eat tonight?",
          options: ["Italiano", "Sushi"],
          multiple: false,
          allowAddOwn: true,
          closesAt: null,
        }),
      })
    ).json()) as { data: CreatePollResult };
    const { pollId, hostToken } = created.data;
    const voterId = "integration-voter-0001";
    const first = await join(base1, { pollId, voterId });
    expect(first.ok).toBe(true);
    const c = sockets[0]!;
    expect((await emitAck(c, "vote:cast", { optionIds: ["o2"], people: 3 })).ok).toBe(true);
    for (const s of sockets) s.disconnect();
    await app1.close(); // "Render sleeps / restarts": process state is gone

    const store2 = open(true);
    const app2 = createApp({ config, store: store2, log: () => undefined });
    const base2 = `http://127.0.0.1:${await app2.listen(0)}`;
    const again = await join(base2, { pollId, voterId });
    expect(again.ok).toBe(true);
    if (again.ok) {
      expect(again.data.myVote).toEqual({ optionIds: ["o2"], people: 3 });
      expect(again.data.results?.totalPeople).toBe(3);
      expect(again.data.isHost).toBe(false);
    }
    const asHost = await join(base2, {
      pollId,
      voterId: "integration-voter-0002",
      hostToken,
    });
    expect(asHost.ok && asHost.data.isHost).toBe(true);
    const stranger = await join(base2, {
      pollId,
      voterId: "integration-voter-0003",
    });
    expect(stranger.ok && stranger.data.results).toBeNull(); // results still hidden from someone who hasn't voted
    for (const s of sockets) s.disconnect();
    await app2.close();
  });
});

describe("PgPollStore: dead connections after a scale-to-zero database (regression: create poll did nothing)", () => {
  const terminated = () => Object.assign(new Error("Connection terminated unexpectedly"), {});

  it("retries the whole unit of work once on a fresh connection when the pooled socket was stale", async () => {
    let calls = 0;
    const released: unknown[] = [];
    const rows = [
      {
        id: "p1",
        host_token_hash: "00",
        question: "q?",
        options: [],
        next_option_seq: 1,
        multiple: false,
        allow_add_own: false,
        closes_at: null,
        closed_at: null,
        created_at: "1",
        expires_at: "2",
        votes: {},
        adders: [],
      },
    ];
    const pool: PgPoolLike = {
      async connect() {
        return {
          async query(sql: string) {
            if (/SELECT/.test(sql) && calls++ === 0) throw terminated(); // first (stale) client is dead
            return { rows };
          },
          release: (d) => void released.push(d ?? false),
        };
      },
      async end() {},
    };
    const logs: string[] = [];
    const store = new PgPollStore({
      pool,
      skipSchemaSetup: true,
      retryDelayMs: 0,
      log: (m) => logs.push(m),
    });
    await expect(store.get("p1")).resolves.toMatchObject({ id: "p1" });
    expect(released).toEqual([true, false]); // stale client destroyed, fresh one returned to the pool
    expect(logs.join("\n")).toMatch(/stale/);
  });

  it("gives up after one retry instead of looping", async () => {
    const f = fakePool({
      failOn: (sql) => (/SELECT/.test(sql) ? terminated() : null),
    });
    const store = new PgPollStore({
      pool: f.pool,
      skipSchemaSetup: true,
      retryDelayMs: 0,
    });
    await expect(store.get("p1")).rejects.toThrow(/terminated/);
    expect(f.released).toEqual([true, true]);
  });

  it("treats a duplicate key on the retried INSERT as success (the first attempt had committed)", async () => {
    let inserts = 0;
    const pool: PgPoolLike = {
      async connect() {
        return {
          async query() {
            inserts++;
            if (inserts === 1) throw terminated();
            throw Object.assign(new Error("duplicate key"), { code: "23505" });
          },
          release: () => {},
        };
      },
      async end() {},
    };
    const store = new PgPollStore({
      pool,
      skipSchemaSetup: true,
      retryDelayMs: 0,
    });
    const poll = {
      id: "p1",
      hostTokenHash: "00",
      question: "q?",
      options: [],
      nextOptionSeq: 1,
      multiple: false,
      allowAddOwn: false,
      closesAt: null,
      closedAt: null,
      createdAt: 1,
      expiresAt: 2,
      votes: {},
      adders: [],
    };
    await expect(store.create(poll)).resolves.toBeUndefined();
    expect(inserts).toBe(2);
  });

  it("does not retry a duplicate key on the first attempt", async () => {
    const pool: PgPoolLike = {
      async connect() {
        return {
          query: async () => {
            throw Object.assign(new Error("duplicate key"), { code: "23505" });
          },
          release: () => {},
        };
      },
      async end() {},
    };
    const store = new PgPollStore({ pool, skipSchemaSetup: true });
    const poll = {
      id: "p1",
      hostTokenHash: "00",
      question: "q?",
      options: [],
      nextOptionSeq: 1,
      multiple: false,
      allowAddOwn: false,
      closesAt: null,
      closedAt: null,
      createdAt: 1,
      expiresAt: 2,
      votes: {},
      adders: [],
    };
    await expect(store.create(poll)).rejects.toThrow(/duplicate/);
  });

  it("does not crash when a checked-out client emits 'error' (pg removes the pool's listener during checkout)", async () => {
    const ee = new EventEmitter();
    const logs: string[] = [];
    const released: unknown[] = [];
    const pool: PgPoolLike = {
      async connect() {
        return {
          async query() {
            // The socket dies while we hold the client, between queries: pg emits 'error' on the client.
            ee.emit(
              "error",
              Object.assign(new Error("read ECONNRESET"), {
                code: "ECONNRESET",
              }),
            );
            return { rows: [{ n: 3 }] };
          },
          release: (d) => void released.push(d ?? false),
          on: (ev: "error", l: (e: Error) => void) => ee.on(ev, l),
          removeListener: (ev: "error", l: (e: Error) => void) => ee.removeListener(ev, l),
        };
      },
      async end() {},
    };
    const store = new PgPollStore({
      pool,
      skipSchemaSetup: true,
      log: (m) => logs.push(m),
    });
    await expect(store.count()).resolves.toBe(3);
    expect(released).toEqual([true]); // flagged broken so the pool discards it
    expect(logs.join(" ")).toMatch(/client error: ECONNRESET/);
    expect(ee.listenerCount("error")).toBe(0); // our listener is removed on release
    expect(() => ee.emit("error", new Error("late"))).toThrow(); // proves: without our listener this WOULD be uncaught
  });

  it("an idle pool 'error' is logged, never thrown", () => {
    const ee = new EventEmitter();
    const logs: string[] = [];
    const pool: PgPoolLike = {
      connect: async () => {
        throw new Error("x");
      },
      end: async () => {},
      on: (ev, l) => ee.on(ev, l),
    };
    new PgPollStore({ pool, skipSchemaSetup: true, log: (m) => logs.push(m) });
    expect(() =>
      ee.emit("error", Object.assign(new Error("terminating connection due to administrator command"), { code: "57P01" })),
    ).not.toThrow();
    expect(logs).toEqual(["postgres pool error: 57P01"]);
  });
});

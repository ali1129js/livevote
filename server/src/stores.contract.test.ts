/**
 * Contract suite: every PollStore implementation must behave identically.
 * Backends: in-memory, Postgres via pg-mem (always), and a REAL Postgres when TEST_DATABASE_URL is set
 * (e.g. a throwaway local database, or a Neon dev branch). The concurrency cases are the point of
 * the real-Postgres run, because pg-mem is a single-process emulator and does not model row locks.
 */
import { randomBytes } from "node:crypto";
import { LIMITS } from "@livevote/shared";
import pg from "pg";
import { newDb } from "pg-mem";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { MemoryPollStore } from "./memoryStore";
import { PgPollStore, type PgPoolLike } from "./pgStore";
import { PollService, ServiceError, hashToken, type Viewer } from "./pollService";
import type { PollRecord, PollStore } from "./store";

const rec = (id: string, over: Partial<PollRecord> = {}): PollRecord => ({
  id,
  hostTokenHash: hashToken("secret"),
  question: "Where do we eat? 🍕 ünï",
  options: [
    { id: "o1", label: "Italiano", addedByVoter: false },
    { id: "o2", label: "Sushi", addedByVoter: false },
  ],
  nextOptionSeq: 3,
  multiple: false,
  allowAddOwn: true,
  closesAt: null,
  closedAt: null,
  createdAt: 1_700_000_000_000,
  expiresAt: 1_700_000_000_000 + LIMITS.pollTtlMs,
  votes: {},
  adders: [],
  ...over,
});

interface Backend {
  name: string;
  make(): Promise<{ store: PollStore; stop(): Promise<void> }>;
  /** A second store over the same data, simulating a process restart. */
  reopen?: (first: PollStore) => PollStore;
  persistent: boolean;
  /** True when concurrent transactions really contend (not the single-process pg-mem emulator). */
  trueConcurrency: boolean;
}

const backends: Backend[] = [
  {
    name: "MemoryPollStore",
    persistent: false,
    trueConcurrency: true,
    make: async () => ({ store: new MemoryPollStore(), stop: async () => {} }),
  },
];

// ---- pg-mem (always runs) -------------------------------------------------------------------
{
  const dbs = new WeakMap<PollStore, ReturnType<typeof newDb>>();
  const open = (db: ReturnType<typeof newDb>, skipSchemaSetup = false) => {
    const { Pool } = db.adapters.createPg();
    // pg-mem can't re-run CREATE TABLE IF NOT EXISTS on an existing table, so a "restarted" store skips setup.
    const store = new PgPollStore({ pool: new Pool() as unknown as PgPoolLike, retryDelayMs: 0, skipSchemaSetup });
    dbs.set(store, db);
    return store;
  };
  backends.push({
    name: "PgPollStore (pg-mem)",
    persistent: true,
    trueConcurrency: false,
    make: async () => {
      const store = open(newDb());
      return { store, stop: () => store.close() };
    },
    reopen: (first) => open(dbs.get(first)!, true),
  });
}

// ---- real Postgres (opt-in) -----------------------------------------------------------------
const REAL_URL = process.env.TEST_DATABASE_URL;
const realTable = `lvtest_${randomBytes(4).toString("hex")}`;
if (REAL_URL) {
  backends.push({
    name: "PgPollStore (real Postgres)",
    persistent: true,
    trueConcurrency: true,
    make: async () => {
      const store = new PgPollStore({ connectionString: REAL_URL, table: realTable });
      await store.init();
      const cleaner = new pg.Pool({ connectionString: REAL_URL, max: 1 });
      await cleaner.query(`TRUNCATE ${realTable}`);
      await cleaner.end();
      return { store, stop: () => store.close() };
    },
    reopen: () => new PgPollStore({ connectionString: REAL_URL, table: realTable }),
  });
  afterAll(async () => {
    const cleaner = new pg.Pool({ connectionString: REAL_URL, max: 1 });
    await cleaner.query(`DROP TABLE IF EXISTS ${realTable}`);
    await cleaner.end();
  });
}

const voter = (n: number): Viewer => ({ voterId: `voter-${String(n).padStart(16, "0")}`, isHost: false });
const host: Viewer = { voterId: "host-0000000000000000", isHost: true };
const base = { question: "Where do we eat?", options: ["Italiano", "Sushi", "Thai"], multiple: false, allowAddOwn: true, closesAt: null };
const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof ServiceError ? e.code : "other";
  }
};

describe.each(backends)("PollStore contract: $name", (backend) => {
  let store: PollStore;
  let stop: () => Promise<void>;
  let now = 1_700_000_000_000;
  let svc: PollService;

  beforeEach(async () => {
    ({ store, stop } = await backend.make());
    now = 1_700_000_000_000;
    svc = new PollService(store, { clock: () => now, maxPolls: 5000 });
    return () => stop();
  });

  describe("store primitives", () => {
    it("round-trips every field (nulls, unicode, votes, adders)", async () => {
      const r = rec("a", {
        closesAt: 1_700_000_500_000,
        closedAt: 1_700_000_100_000,
        multiple: true,
        allowAddOwn: false,
        votes: { v1: { optionIds: ["o1", "o2"], people: 3, updatedAt: 42 } },
        adders: ["v1"],
      });
      await store.create(r);
      expect(await store.get("a")).toEqual(r);
      await store.create(rec("b"));
      const b = await store.get("b");
      expect(b?.closesAt).toBeNull();
      expect(b?.closedAt).toBeNull();
      expect(typeof b?.createdAt).toBe("number");
    });

    it("returns null for unknown ids and rejects duplicate ids", async () => {
      expect(await store.get("nope")).toBeNull();
      await store.create(rec("a"));
      await expect(store.create(rec("a", { question: "other" }))).rejects.toThrow();
      expect((await store.get("a"))?.question).toContain("Where do we eat");
    });

    it("hands out copies: mutating inputs or results never changes stored state", async () => {
      const r = rec("a");
      await store.create(r);
      r.question = "changed";
      const got = await store.get("a");
      expect(got?.question).not.toBe("changed");
      got!.options.push({ id: "x", label: "x", addedByVoter: true });
      expect((await store.get("a"))?.options).toHaveLength(2);
    });

    it("update returns the mutation result and the saved poll, and persists", async () => {
      await store.create(rec("a"));
      const res = await store.update("a", (d) => {
        d.votes["v1"] = { optionIds: ["o1"], people: 2, updatedAt: 1 };
        d.nextOptionSeq++;
        return "done";
      });
      expect(res?.result).toBe("done");
      expect(res?.poll.votes["v1"]?.people).toBe(2);
      expect(await store.get("a")).toEqual(res?.poll);
      expect((await store.get("a"))?.nextOptionSeq).toBe(4);
    });

    it("update on a missing poll resolves null without calling mutate", async () => {
      let called = false;
      expect(await store.update("missing", () => (called = true))).toBeNull();
      expect(called).toBe(false);
    });

    it("update is all-or-nothing when mutate throws", async () => {
      await store.create(rec("a"));
      await expect(
        store.update("a", (d) => {
          d.question = "half";
          d.votes["v1"] = { optionIds: ["o1"], people: 1, updatedAt: 1 };
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      const after = await store.get("a");
      expect(after?.question).toContain("Where do we eat");
      expect(after?.votes).toEqual({});
      // the store is still usable (no leaked lock / connection)
      expect((await store.update("a", () => 1))?.result).toBe(1);
    });

    it("deleteExpired removes polls with expiresAt <= now, returns their ids, and count/delete agree", async () => {
      await store.create(rec("old", { expiresAt: 100 }));
      await store.create(rec("edge", { expiresAt: 200 }));
      await store.create(rec("new", { expiresAt: 5000 }));
      expect(await store.count()).toBe(3);
      expect((await store.deleteExpired(200)).sort()).toEqual(["edge", "old"]);
      expect(await store.get("old")).toBeNull();
      expect(await store.get("new")).not.toBeNull();
      expect(await store.deleteExpired(200)).toEqual([]);
      await store.delete("new");
      await store.delete("new"); // idempotent
      expect(await store.count()).toBe(0);
    });

    it("init and close are safe to call repeatedly", async () => {
      await store.init();
      await store.init();
      expect(store.sweepIntervalMs).toBeGreaterThan(0);
      expect(store.kind.length).toBeGreaterThan(0);
    });
  });

  describe.runIf(backend.reopen)("persistence", () => {
    it("polls, votes and hashed host tokens survive a restart (new store instance)", async () => {
      const { pollId, hostToken } = await svc.createPoll(base);
      await svc.castVote(pollId, voter(1), { optionIds: ["o2"], people: 2 });
      const reopened = backend.reopen!(store);
      const svc2 = new PollService(reopened, { clock: () => now });
      const auth = await svc2.authenticate(pollId, voter(9).voterId, hostToken);
      expect(auth.viewer.isHost).toBe(true);
      expect(auth.poll.votes[voter(1).voterId]).toMatchObject({ optionIds: ["o2"], people: 2 });
      if (reopened !== store) await reopened.close();
    });
  });

  describe("service rules on this store", () => {
    it("stores only the SHA-256 of the host token, never the token", async () => {
      const { pollId, hostToken } = await svc.createPoll(base);
      const stored = await store.get(pollId);
      expect(stored?.hostTokenHash).toBe(hashToken(hostToken));
      expect(JSON.stringify(stored)).not.toContain(hostToken);
      expect(await codeOf(svc.authenticate(pollId, voter(1).voterId, "wrong-token"))).toBe("forbidden");
    });

    it("keeps the 7-day expiry: readable before, not_found after, and swept", async () => {
      const { pollId } = await svc.createPoll(base);
      expect((await store.get(pollId))?.expiresAt).toBe(now + 7 * 24 * 3600 * 1000);
      now += 7 * 24 * 3600 * 1000 - 1;
      await expect(svc.load(pollId)).resolves.toBeTruthy();
      now += 1;
      expect(await codeOf(svc.load(pollId))).toBe("not_found");
      expect(await svc.sweepExpired()).toEqual([pollId]);
      expect(await store.count()).toBe(0);
    });

    it("enforces the global poll cap", async () => {
      const small = new PollService(store, { clock: () => now, maxPolls: 2 });
      await small.createPoll(base);
      await small.createPoll(base);
      expect(await codeOf(small.createPoll(base))).toBe("limit_reached");
    });

    it("hides results until a person votes (host and closed polls excepted)", async () => {
      const { pollId } = await svc.createPoll(base);
      const poll1 = await svc.load(pollId);
      expect(svc.viewFor(poll1, voter(1)).results).toBeNull();
      const after = await svc.castVote(pollId, voter(1), { optionIds: ["o1"], people: 2 });
      expect(svc.viewFor(after, voter(1)).results?.voters).toBe(1);
      expect(svc.viewFor(after, voter(2)).results).toBeNull(); // a different, non-voting person still sees nothing
      expect(svc.viewFor(after, host).results?.totalPeople).toBe(2);
      const closed = await svc.close(pollId, host);
      expect(svc.viewFor(closed, voter(2)).results).not.toBeNull();
    });

    it("applies add-your-own: one per voter, duplicates merge without using the allowance, cap of 10", async () => {
      const { pollId } = await svc.createPoll({ ...base, options: ["A1", "B2", "C3", "D4", "E5", "F6"] });
      const first = await svc.addOption(pollId, voter(1), "  pizza ");
      expect(first.result).toEqual({ optionId: "o7", merged: false });
      expect(await codeOf(svc.addOption(pollId, voter(1), "Burgers"))).toBe("forbidden");
      const merged = await svc.addOption(pollId, voter(2), "PIZZA");
      expect(merged.result).toEqual({ optionId: "o7", merged: true });
      expect((await svc.addOption(pollId, voter(2), "Burgers")).result.merged).toBe(false); // merge didn't consume voter 2's add
      await svc.addOption(pollId, voter(3), "Tacos");
      await svc.addOption(pollId, voter(4), "Ramen");
      expect((await svc.load(pollId)).options).toHaveLength(10);
      expect(await codeOf(svc.addOption(pollId, voter(5), "Curry"))).toBe("limit_reached");
      expect(svc.viewFor(await svc.load(pollId), voter(5)).canAddOption).toBe(false);
    });

    it("lets the host reset (clears votes and adders) and remove options (dropping orphaned votes)", async () => {
      const { pollId } = await svc.createPoll(base);
      await svc.castVote(pollId, voter(1), { optionIds: ["o1"], people: 1 });
      await svc.castVote(pollId, voter(2), { optionIds: ["o2"], people: 1 });
      const removed = await svc.removeOption(pollId, host, "o1");
      expect(Object.keys(removed.votes)).toEqual([voter(2).voterId]);
      const reset = await svc.reset(pollId, host);
      expect(reset.votes).toEqual({});
      expect(reset.adders).toEqual([]);
    });

    it("enforces the voter cap (500) and lets existing voters change their vote at the cap", async () => {
      const { pollId } = await svc.createPoll(base);
      // fill to the cap directly through the atomic primitive (fast), then exercise the real service path
      await store.update(pollId, (d) => {
        for (let i = 0; i < LIMITS.votersPerPollMax; i++) {
          d.votes[voter(i).voterId] = { optionIds: ["o1"], people: 1, updatedAt: 1 };
        }
      });
      expect(await codeOf(svc.castVote(pollId, voter(100_000), { optionIds: ["o1"], people: 1 }))).toBe("limit_reached");
      await svc.castVote(pollId, voter(7), { optionIds: ["o2"], people: 3 });
      const p = await svc.load(pollId);
      expect(Object.keys(p.votes)).toHaveLength(LIMITS.votersPerPollMax);
      expect(p.votes[voter(7).voterId]).toMatchObject({ optionIds: ["o2"], people: 3 });
    });
  });

  describe.runIf(backend.trueConcurrency)("atomicity under concurrency", () => {
    it("60 simultaneous votes from different people are all recorded (no lost updates)", async () => {
      const { pollId } = await svc.createPoll(base);
      await Promise.all(Array.from({ length: 60 }, (_, i) => svc.castVote(pollId, voter(i), { optionIds: [`o${(i % 3) + 1}`], people: 1 })));
      const p = await svc.load(pollId);
      expect(Object.keys(p.votes)).toHaveLength(60);
    });

    it("racing to pass the 500-voter cap admits exactly 500", async () => {
      const { pollId } = await svc.createPoll(base);
      await store.update(pollId, (d) => {
        for (let i = 0; i < LIMITS.votersPerPollMax - 5; i++) d.votes[voter(i).voterId] = { optionIds: ["o1"], people: 1, updatedAt: 1 };
      });
      const results = await Promise.all(
        Array.from({ length: 30 }, (_, i) => codeOf(svc.castVote(pollId, voter(10_000 + i), { optionIds: ["o1"], people: 1 }))),
      );
      expect(results.filter((r) => r === "ok")).toHaveLength(5);
      expect(results.filter((r) => r === "limit_reached")).toHaveLength(25);
      expect(Object.keys((await svc.load(pollId)).votes)).toHaveLength(LIMITS.votersPerPollMax);
    });

    it("racing add-your-own with distinct labels stops exactly at 10 options with unique ids", async () => {
      const { pollId } = await svc.createPoll({ ...base, options: ["A1", "B2", "C3", "D4", "E5", "F6"] });
      const results = await Promise.all(Array.from({ length: 25 }, (_, i) => codeOf(svc.addOption(pollId, voter(i), `Place ${i}`))));
      expect(results.filter((r) => r === "ok")).toHaveLength(4);
      const p = await svc.load(pollId);
      expect(p.options).toHaveLength(10);
      expect(new Set(p.options.map((o) => o.id)).size).toBe(10);
      expect(p.adders).toHaveLength(4);
    });

    it("racing add-your-own with the same label creates it once and merges the rest", async () => {
      const { pollId } = await svc.createPoll(base);
      const outs = await Promise.all(Array.from({ length: 12 }, (_, i) => svc.addOption(pollId, voter(i), i % 2 ? "Pizza" : " pizza ")));
      expect(outs.filter((o) => !o.result.merged)).toHaveLength(1);
      expect(new Set(outs.map((o) => o.result.optionId)).size).toBe(1);
      expect((await svc.load(pollId)).options).toHaveLength(4);
    });

    it("one voter's concurrent re-votes leave exactly one coherent vote", async () => {
      const { pollId } = await svc.createPoll({ ...base, multiple: true });
      await Promise.all(Array.from({ length: 20 }, (_, i) => svc.castVote(pollId, voter(1), { optionIds: [`o${(i % 3) + 1}`], people: (i % 5) + 1 })));
      const votes = (await svc.load(pollId)).votes;
      expect(Object.keys(votes)).toEqual([voter(1).voterId]);
      expect(votes[voter(1).voterId]?.optionIds).toHaveLength(1);
    });

    it("a failing mutation under load does not poison concurrent good ones", async () => {
      const { pollId } = await svc.createPoll(base);
      const settled = await Promise.allSettled(
        Array.from({ length: 20 }, (_, i) =>
          i % 4 === 0 ? svc.castVote(pollId, voter(i), { optionIds: ["nope"], people: 1 }) : svc.castVote(pollId, voter(i), { optionIds: ["o1"], people: 1 }),
        ),
      );
      expect(settled.filter((s) => s.status === "rejected")).toHaveLength(5);
      expect(Object.keys((await svc.load(pollId)).votes)).toHaveLength(15);
    });
  });
});

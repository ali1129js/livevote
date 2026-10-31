import { beforeEach, describe, expect, it } from "vitest";
import { MemoryPollStore } from "./memoryStore";
import { PollService, ServiceError, hashToken, type Viewer } from "./pollService";

let now = 1_700_000_000_000;
let svc: PollService;
let store: MemoryPollStore;

const voter = (n: number): Viewer => ({ voterId: `voter-${String(n).padStart(16, "0")}`, isHost: false });
const base = { question: "Where do we eat?", options: ["Italiano", "Sushi", "Thai"], multiple: false, allowAddOwn: true, closesAt: null };

async function make(overrides: Record<string, unknown> = {}) {
  const { pollId, hostToken } = await svc.createPoll({ ...base, ...overrides });
  const host: Viewer = { voterId: "host-0000000000000000", isHost: true };
  return { pollId, hostToken, host };
}
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof ServiceError ? e.code : "other";
  }
};

beforeEach(() => {
  now = 1_700_000_000_000;
  store = new MemoryPollStore();
  svc = new PollService(store, { clock: () => now, maxPolls: 3 });
});

describe("createPoll", () => {
  it("returns an id and a secret token, and stores only the token hash", async () => {
    const { pollId, hostToken } = await make();
    expect(pollId).toMatch(/^[a-z2-9]{10}$/);
    expect(hostToken.length).toBeGreaterThanOrEqual(30);
    const rec = await store.get(pollId);
    expect(rec?.hostTokenHash).toBe(hashToken(hostToken));
    expect(JSON.stringify(rec)).not.toContain(hostToken);
    expect(rec?.expiresAt).toBe(now + 7 * 24 * 3600 * 1000);
  });
  it("rejects invalid input and enforces the global poll cap", async () => {
    expect(await code(svc.createPoll({ ...base, options: ["x"] }))).toBe("bad_request");
    await make();
    await make();
    await make();
    expect(await code(svc.createPoll(base))).toBe("limit_reached");
  });
});

describe("authenticate", () => {
  it("accepts the right host token, rejects wrong ones and bad voter ids", async () => {
    const { pollId, hostToken } = await make();
    const ok = await svc.authenticate(pollId, voter(1).voterId, hostToken);
    expect(ok.viewer.isHost).toBe(true);
    expect((await svc.authenticate(pollId, voter(1).voterId, undefined)).viewer.isHost).toBe(false);
    expect(await code(svc.authenticate(pollId, voter(1).voterId, "wrong"))).toBe("forbidden");
    expect(await code(svc.authenticate(pollId, "x", undefined))).toBe("bad_request");
    expect(await code(svc.authenticate("nope", voter(1).voterId, undefined))).toBe("not_found");
  });
  it("treats polls older than 7 days as gone", async () => {
    const { pollId } = await make();
    now += 7 * 24 * 3600 * 1000 + 1;
    expect(await code(svc.authenticate(pollId, voter(1).voterId, undefined))).toBe("not_found");
    expect(await svc.sweepExpired()).toEqual([pollId]);
  });
});

describe("voting", () => {
  it("hides results from late joiners until they vote", async () => {
    const { pollId, host } = await make();
    const v = voter(1);
    let st = svc.viewFor(await svc.load(pollId), v);
    expect(st.results).toBeNull();
    expect(st.myVote).toBeNull();
    expect(svc.viewFor(await svc.load(pollId), host).results).not.toBeNull();
    await svc.castVote(pollId, v, { optionIds: ["o1"], people: 3 });
    st = svc.viewFor(await svc.load(pollId), v);
    expect(st.results?.options[0]).toMatchObject({ label: "Italiano", votes: 1, people: 3 });
    expect(st.myVote).toEqual({ optionIds: ["o1"], people: 3 });
    // another browser who hasn't voted still sees nothing
    expect(svc.viewFor(await svc.load(pollId), voter(2)).results).toBeNull();
  });

  it("counts one vote per voter id and lets them change it", async () => {
    const { pollId } = await make();
    const v = voter(1);
    await svc.castVote(pollId, v, { optionIds: ["o1"], people: 2 });
    await svc.castVote(pollId, v, { optionIds: ["o2"], people: 5 });
    const r = svc.viewFor(await svc.load(pollId), v).results;
    expect(r?.voters).toBe(1);
    expect(r?.totalPeople).toBe(5);
    expect(r?.options.find((o) => o.label === "Italiano")?.votes).toBe(0);
    expect(r?.options.find((o) => o.label === "Sushi")?.votes).toBe(1);
  });

  it("enforces single vs multiple picks", async () => {
    const single = await make();
    expect(await code(svc.castVote(single.pollId, voter(1), { optionIds: ["o1", "o2"], people: 1 }))).toBe("bad_request");
    const multi = await make({ multiple: true });
    expect(await code(svc.castVote(multi.pollId, voter(1), { optionIds: ["o1", "o2", "o2"], people: 1 }))).toBe("ok");
    const r = svc.viewFor(await svc.load(multi.pollId), voter(1)).results;
    expect(r?.options.filter((o) => o.votes === 1)).toHaveLength(2);
  });

  it.each([
    ["no options", { optionIds: [], people: 1 }],
    ["unknown option", { optionIds: ["zzz"], people: 1 }],
    ["people 0", { optionIds: ["o1"], people: 0 }],
    ["people 21", { optionIds: ["o1"], people: 21 }],
    ["people fraction", { optionIds: ["o1"], people: 1.5 }],
    ["people string", { optionIds: ["o1"], people: "2" }],
    ["option ids not array", { optionIds: "o1", people: 1 }],
    ["non-string ids", { optionIds: [1], people: 1 }],
    ["null", null],
  ])("rejects %s", async (_n, payload) => {
    const { pollId } = await make();
    expect(await code(svc.castVote(pollId, voter(1), payload as never))).toBe("bad_request");
  });

  it("stops voting at the closing time and unlocks results for everyone", async () => {
    const { pollId } = await make({ closesAt: now + 120_000 });
    await svc.castVote(pollId, voter(1), { optionIds: ["o1"], people: 1 });
    now += 120_000;
    expect(await code(svc.castVote(pollId, voter(2), { optionIds: ["o1"], people: 1 }))).toBe("closed");
    const st = svc.viewFor(await svc.load(pollId), voter(3));
    expect(st.poll).toMatchObject({ closed: true, closedBy: "time" });
    expect(st.results?.voters).toBe(1);
  });

  it("caps voters per poll", async () => {
    const { pollId } = await make();
    // fill the poll straight through the store to keep the test fast
    await store.update(pollId, (p) => {
      for (let i = 0; i < 500; i++) p.votes[`filler-${String(i).padStart(16, "0")}`] = { optionIds: ["o1"], people: 1, updatedAt: now };
    });
    expect(await code(svc.castVote(pollId, voter(1), { optionIds: ["o1"], people: 1 }))).toBe("limit_reached");
    // an existing voter may still change their vote
    expect(await code(svc.castVote(pollId, { voterId: `filler-${"0".repeat(16)}`, isHost: false }, { optionIds: ["o2"], people: 2 }))).toBe("ok");
  });
});

describe("add your own", () => {
  it("adds an option once per voter and lets people vote on it", async () => {
    const { pollId } = await make();
    const v = voter(1);
    const { result } = await svc.addOption(pollId, v, "  Burger   Barn ");
    expect(result.merged).toBe(false);
    const st = svc.viewFor(await svc.load(pollId), v);
    expect(st.poll.options.at(-1)).toMatchObject({ label: "Burger Barn", addedByVoter: true });
    expect(st.canAddOption).toBe(false);
    expect(await code(svc.addOption(pollId, v, "Another"))).toBe("forbidden");
    await svc.castVote(pollId, voter(2), { optionIds: [result.optionId], people: 2 });
  });

  it.each(["italiano", "  ITALIANO ", "Italiano!", "Itàliano"])("merges near-duplicate %j into the existing option", async (label) => {
    const { pollId } = await make();
    const { result } = await svc.addOption(pollId, voter(1), label);
    expect(result).toEqual({ optionId: "o1", merged: true });
    const p = await svc.load(pollId);
    expect(p.options).toHaveLength(3);
    // a merge doesn't use up the voter's one add
    expect(svc.viewFor(p, voter(1)).canAddOption).toBe(true);
  });

  it("merges duplicates of voter-added options too", async () => {
    const { pollId } = await make();
    const a = await svc.addOption(pollId, voter(1), "Café Nero");
    const b = await svc.addOption(pollId, voter(2), "cafe nero");
    expect(b.result).toEqual({ optionId: a.result.optionId, merged: true });
  });

  it("is refused when disabled, closed or full", async () => {
    const off = await make({ allowAddOwn: false });
    expect(await code(svc.addOption(off.pollId, voter(1), "X"))).toBe("forbidden");
    expect(svc.viewFor(await svc.load(off.pollId), voter(1)).canAddOption).toBe(false);

    const full = await make({ options: ["1", "2", "3", "4", "5", "6"] });
    for (let i = 1; i <= 4; i++) expect(await code(svc.addOption(full.pollId, voter(i), `extra ${i}`))).toBe("ok");
    expect(await code(svc.addOption(full.pollId, voter(9), "one too many"))).toBe("limit_reached");

    const closing = await make({ closesAt: now + 61_000 });
    now += 61_000;
    expect(await code(svc.addOption(closing.pollId, voter(1), "late"))).toBe("closed");
  });

  it("validates the label", async () => {
    const { pollId } = await make();
    expect(await code(svc.addOption(pollId, voter(1), ""))).toBe("bad_request");
    expect(await code(svc.addOption(pollId, voter(1), "x".repeat(61)))).toBe("bad_request");
    expect(await code(svc.addOption(pollId, voter(1), 12))).toBe("bad_request");
  });
});

describe("host actions", () => {
  it("only the host may close, reset or remove", async () => {
    const { pollId } = await make();
    const v = voter(1);
    expect(await code(svc.close(pollId, v))).toBe("forbidden");
    expect(await code(svc.reset(pollId, v))).toBe("forbidden");
    expect(await code(svc.removeOption(pollId, v, "o1"))).toBe("forbidden");
  });

  it("close ends voting and shows results; closing twice errors", async () => {
    const { pollId, host } = await make();
    await svc.castVote(pollId, voter(1), { optionIds: ["o1"], people: 4 });
    await svc.close(pollId, host);
    const st = svc.viewFor(await svc.load(pollId), voter(2));
    expect(st.poll).toMatchObject({ closed: true, closedBy: "host" });
    expect(st.results?.summary).toContain("Winner: Italiano");
    expect(await code(svc.castVote(pollId, voter(2), { optionIds: ["o1"], people: 1 }))).toBe("closed");
    expect(await code(svc.close(pollId, host))).toBe("closed");
  });

  it("reset clears votes, re-opens, and lets voters add again", async () => {
    const { pollId, host } = await make({ closesAt: now + 61_000 });
    await svc.castVote(pollId, voter(1), { optionIds: ["o1"], people: 4 });
    await svc.addOption(pollId, voter(1), "Burger");
    now += 61_000; // deadline passed
    await svc.reset(pollId, host);
    const st = svc.viewFor(await svc.load(pollId), voter(1));
    expect(st.poll.closed).toBe(false);
    expect(st.poll.closesAt).toBeNull();
    expect(st.myVote).toBeNull();
    expect(st.canAddOption).toBe(true);
    expect(st.poll.options).toHaveLength(4); // options are kept
    expect((await svc.load(pollId)).votes).toEqual({});
  });

  it("removing an option drops its votes, and voters left with no pick can vote again", async () => {
    const { pollId, host } = await make({ multiple: true });
    await svc.castVote(pollId, voter(1), { optionIds: ["o1"], people: 2 });
    await svc.castVote(pollId, voter(2), { optionIds: ["o1", "o2"], people: 3 });
    await svc.removeOption(pollId, host, "o1");
    const p = await svc.load(pollId);
    expect(p.options.map((o) => o.id)).toEqual(["o2", "o3"]);
    expect(svc.viewFor(p, voter(1)).myVote).toBeNull();
    expect(svc.viewFor(p, voter(2)).myVote).toEqual({ optionIds: ["o2"], people: 3 });
  });

  it("keeps at least 2 options and rejects unknown ids", async () => {
    const { pollId, host } = await make({ options: ["A", "B"] });
    expect(await code(svc.removeOption(pollId, host, "o1"))).toBe("bad_request");
    const three = await make();
    expect(await code(svc.removeOption(three.pollId, three.host, "nope"))).toBe("bad_request");
    expect(await code(svc.removeOption(three.pollId, three.host, 5))).toBe("bad_request");
  });

  it("refuses to remove options once closed", async () => {
    const { pollId, host } = await make();
    await svc.close(pollId, host);
    expect(await code(svc.removeOption(pollId, host, "o1"))).toBe("closed");
  });
});

describe("concurrency", () => {
  it("never loses a vote when many arrive at once", async () => {
    const { pollId } = await make();
    await Promise.all(Array.from({ length: 50 }, (_, i) => svc.castVote(pollId, voter(i), { optionIds: ["o1"], people: 2 })));
    const r = svc.viewFor(await svc.load(pollId), voter(0)).results;
    expect(r?.voters).toBe(50);
    expect(r?.options[0]).toMatchObject({ votes: 50, people: 100 });
  });
});

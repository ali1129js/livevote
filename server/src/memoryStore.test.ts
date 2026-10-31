import { describe, expect, it } from "vitest";
import { MemoryPollStore } from "./memoryStore";
import type { PollRecord } from "./store";

const rec = (id: string, expiresAt = 1000): PollRecord => ({
  id, hostTokenHash: "00", question: "q?", options: [], nextOptionSeq: 1, multiple: false, allowAddOwn: false,
  closesAt: null, closedAt: null, createdAt: 0, expiresAt, votes: {}, adders: [],
});

describe("MemoryPollStore", () => {
  it("stores copies, so outside mutation can't corrupt state", async () => {
    const s = new MemoryPollStore();
    const r = rec("a");
    await s.create(r);
    r.question = "changed";
    const got = await s.get("a");
    expect(got?.question).toBe("q?");
    if (got) got.question = "changed again";
    expect((await s.get("a"))?.question).toBe("q?");
  });

  it("update is all-or-nothing", async () => {
    const s = new MemoryPollStore();
    await s.create(rec("a"));
    await expect(
      s.update("a", (d) => {
        d.question = "half";
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect((await s.get("a"))?.question).toBe("q?");
    const ok = await s.update("a", (d) => ((d.question = "new?"), 7));
    expect(ok?.result).toBe(7);
    expect((await s.get("a"))?.question).toBe("new?");
    expect(await s.update("missing", () => 1)).toBeNull();
  });

  it("deletes expired polls and counts", async () => {
    const s = new MemoryPollStore();
    await s.create(rec("old", 100));
    await s.create(rec("new", 5000));
    expect(await s.count()).toBe(2);
    expect(await s.deleteExpired(100)).toEqual(["old"]);
    expect(await s.get("old")).toBeNull();
    await s.delete("new");
    expect(await s.count()).toBe(0);
  });
});

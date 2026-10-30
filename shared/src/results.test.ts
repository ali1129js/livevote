import { describe, expect, it } from "vitest";
import { computeResults } from "./results";
import type { PollOption } from "./types";

const opts = (...labels: string[]): PollOption[] => labels.map((label, i) => ({ id: `o${i + 1}`, label, addedByVoter: false }));

describe("computeResults", () => {
  it("counts votes and people per option and flags the winner", () => {
    const r = computeResults({
      options: opts("Italiano", "Sushi"),
      votes: [
        { optionIds: ["o1"], people: 4 },
        { optionIds: ["o1"], people: 10 },
        { optionIds: ["o2"], people: 2 },
      ],
    });
    expect(r.options[0]).toMatchObject({ label: "Italiano", votes: 2, people: 14, isLeader: true });
    expect(r.options[1]).toMatchObject({ label: "Sushi", votes: 1, people: 2, isLeader: false });
    expect(r.voters).toBe(3);
    expect(r.totalPeople).toBe(16);
    expect(r.tie).toBe(false);
    expect(r.summary).toBe("Winner: Italiano (2 votes, 14 people) · 16 people in total, 3 voters");
  });

  it("counts total people once per voter in approval voting", () => {
    const r = computeResults({
      options: opts("A", "B"),
      votes: [{ optionIds: ["o1", "o2"], people: 3 }],
    });
    expect(r.totalPeople).toBe(3);
    expect(r.options.map((o) => [o.votes, o.people])).toEqual([
      [1, 3],
      [1, 3],
    ]);
    expect(r.tie).toBe(true);
  });

  it("flags ties and names every leader", () => {
    const r = computeResults({
      options: opts("A", "B", "C"),
      votes: [
        { optionIds: ["o1"], people: 1 },
        { optionIds: ["o2"], people: 5 },
      ],
    });
    expect(r.tie).toBe(true);
    expect(r.leaders).toEqual(["o1", "o2"]);
    expect(r.summary).toBe("Tie: B / A (1 vote each) · 6 people in total, 2 voters");
  });

  it("handles no votes", () => {
    const r = computeResults({ options: opts("A", "B"), votes: [] });
    expect(r.tie).toBe(false);
    expect(r.leaders).toEqual([]);
    expect(r.summary).toBe("No votes yet · 0 people in total, 0 voters");
  });

  it("uses singular wording", () => {
    const r = computeResults({ options: opts("A", "B"), votes: [{ optionIds: ["o1"], people: 1 }] });
    expect(r.summary).toBe("Winner: A (1 vote, 1 person) · 1 person in total, 1 voter");
  });

  it("ignores votes for options that no longer exist and duplicate ids", () => {
    const r = computeResults({ options: opts("A", "B"), votes: [{ optionIds: ["o1", "o1", "gone"], people: 2 }] });
    expect(r.options[0]).toMatchObject({ votes: 1, people: 2 });
  });

  it("sorts by votes, then people, then original order", () => {
    const r = computeResults({
      options: opts("A", "B", "C"),
      votes: [
        { optionIds: ["o2"], people: 1 },
        { optionIds: ["o3"], people: 9 },
      ],
    });
    expect(r.options.map((o) => o.label)).toEqual(["C", "B", "A"]);
  });
});

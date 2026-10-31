import type { MyVote, OptionResult, PollOption, Results } from "./types";

export interface TallyInput {
  options: readonly PollOption[];
  votes: Iterable<MyVote>;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Pure tally used by the server (and tested in isolation). */
export function computeResults({ options, votes }: TallyInput): Results {
  const byId = new Map<string, { votes: number; people: number }>();
  for (const o of options) byId.set(o.id, { votes: 0, people: 0 });

  let voters = 0;
  let totalPeople = 0;
  for (const v of votes) {
    voters += 1;
    totalPeople += v.people;
    for (const id of new Set(v.optionIds)) {
      const slot = byId.get(id);
      if (slot) {
        slot.votes += 1;
        slot.people += v.people;
      }
    }
  }

  const maxVotes = Math.max(0, ...[...byId.values()].map((s) => s.votes));
  const leaders = maxVotes > 0 ? options.filter((o) => byId.get(o.id)?.votes === maxVotes).map((o) => o.id) : [];
  const tie = leaders.length > 1;

  const rows: OptionResult[] = options.map((o) => {
    const s = byId.get(o.id) ?? { votes: 0, people: 0 };
    return { optionId: o.id, label: o.label, votes: s.votes, people: s.people, isLeader: leaders.includes(o.id) };
  });
  // Stable sort: more votes first, then more people, then original order.
  const indexed = rows.map((r, i) => ({ r, i }));
  indexed.sort((a, b) => b.r.votes - a.r.votes || b.r.people - a.r.people || a.i - b.i);
  const sorted = indexed.map((x) => x.r);

  return {
    options: sorted,
    voters,
    totalPeople,
    leaders,
    tie,
    summary: buildSummary(sorted, voters, totalPeople, leaders),
  };
}

export function buildSummary(rows: readonly OptionResult[], voters: number, totalPeople: number, leaders: readonly string[]): string {
  const totals = `${plural(totalPeople, "person", "people")} in total, ${plural(voters, "voter")}`;
  const lead = rows.filter((r) => leaders.includes(r.optionId));
  const first = lead[0];
  if (!first) return `No votes yet · ${totals}`;
  if (lead.length === 1) {
    return `Winner: ${first.label} (${plural(first.votes, "vote")}, ${plural(first.people, "person", "people")}) · ${totals}`;
  }
  const names = lead.map((r) => r.label).join(" / ");
  return `Tie: ${names} (${plural(first.votes, "vote")} each) · ${totals}`;
}

export { plural };

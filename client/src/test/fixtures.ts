import { computeResults, type ClientState, type PollOption, type PublicPoll } from "@livevote/shared";

export const options = (...labels: string[]): PollOption[] => labels.map((label, i) => ({ id: `o${i + 1}`, label, addedByVoter: false }));

export function makeState(over: Partial<Omit<ClientState, "poll">> & { poll?: Partial<PublicPoll> } = {}): ClientState {
  const { poll: pollOver, ...rest } = over;
  return {
    poll: {
      id: "abcdefghjk",
      question: "Where do we eat?",
      options: options("Italiano", "Sushi", "Thai"),
      multiple: false,
      allowAddOwn: true,
      closesAt: null,
      closed: false,
      closedBy: null,
      expiresAt: Date.now() + 7 * 24 * 3600_000,
      ...pollOver,
    },
    serverNow: Date.now(),
    isHost: false,
    myVote: null,
    canAddOption: true,
    results: null,
    ...rest,
  };
}

export const sampleResults = () =>
  computeResults({
    options: options("Italiano", "Sushi", "Thai"),
    votes: [
      { optionIds: ["o1"], people: 4 },
      { optionIds: ["o1"], people: 10 },
      { optionIds: ["o2"], people: 2 },
    ],
  });

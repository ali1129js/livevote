import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UsePoll } from "../usePoll";
import { expectNoA11yViolations } from "../test/axe";
import { makeState, sampleResults } from "../test/fixtures";

let current: UsePoll;
vi.mock("../usePoll", () => ({ usePoll: () => current }));

import { PollPage } from "./PollPage";

const ack = vi.fn().mockResolvedValue({ ok: true });
const base = (over: Partial<UsePoll> = {}): UsePoll => ({
  connection: "online",
  waitedSeconds: 0,
  state: makeState(),
  fatal: null,
  clockOffset: 0,
  actions: { vote: ack, addOption: ack, close: ack, reset: ack, removeOption: ack },
  ...over,
});

beforeEach(() => {
  ack.mockClear();
});

describe("PollPage", () => {
  it("late joiner: sees the question and options first, results stay locked until they vote", async () => {
    current = base();
    const { container } = render(<PollPage pollId="abcdefghjk" hostToken={null} />);
    expect(screen.getByRole("heading", { name: "Where do we eat?" })).toBeInTheDocument();
    expect(screen.getAllByRole("radio")).toHaveLength(3);
    expect(screen.queryByRole("heading", { name: /results/i })).toBeNull();
    expect(screen.getByText(/Vote first, then you'll see the live results/)).toBeInTheDocument();
    expect(screen.queryByText("Host controls")).toBeNull();
    await expectNoA11yViolations(container);
  });

  it("after voting: shows the vote and live results, with a way to change it", async () => {
    current = base({ state: makeState({ myVote: { optionIds: ["o1"], people: 3 }, results: sampleResults() }) });
    const { container } = render(<PollPage pollId="abcdefghjk" hostToken={null} />);
    expect(screen.getByText("You voted")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Live results" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Vote" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Change vote" }));
    expect(screen.getByRole("button", { name: "Update vote" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Italiano" })).toBeChecked();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("button", { name: "Update vote" })).toBeNull();
    await expectNoA11yViolations(container);
  });

  it("closed poll: no ballot, final results for everyone, 'Closed by host'", async () => {
    current = base({ state: makeState({ poll: { closed: true, closedBy: "host" }, results: sampleResults(), canAddOption: false }) });
    const { container } = render(<PollPage pollId="abcdefghjk" hostToken={null} />);
    expect(screen.getByText("Closed by host")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Final results" })).toBeInTheDocument();
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    expect(screen.getByTestId("summary")).toHaveTextContent("Winner: Italiano");
    await expectNoA11yViolations(container);
  });

  it("shows the closing time and a countdown", () => {
    const closesAt = Date.now() + 5 * 60_000 + 30_000;
    current = base({ state: makeState({ poll: { closesAt } }) });
    render(<PollPage pollId="abcdefghjk" hostToken={null} />);
    expect(screen.getByTestId("closes")).toHaveTextContent(/Closes .* · 5m \d\ds/);
  });

  it("host: share link, QR, private host link, and controls with confirmation", async () => {
    current = base({ state: makeState({ isHost: true, results: sampleResults() }) });
    const { container } = render(<PollPage pollId="abcdefghjk" hostToken="host-token-1234567890" />);
    const qr = await screen.findByRole("img", { name: /QR code/ });
    expect(qr.getAttribute("src")).toContain("data:image/svg+xml");
    expect((screen.getByLabelText("Share link") as HTMLInputElement).value).toMatch(/#\/p\/abcdefghjk$/);
    expect((screen.getByLabelText(/Private host link/) as HTMLInputElement).value).toMatch(/#\/p\/abcdefghjk\/host\/host-token-1234567890$/);

    await userEvent.click(screen.getByRole("button", { name: "Close poll" }));
    expect(screen.getByRole("alertdialog")).toHaveTextContent("Close voting now?");
    await userEvent.click(screen.getByRole("button", { name: "Keep going" }));
    expect(ack).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Close poll" }));
    await userEvent.click(screen.getByRole("button", { name: "Yes, close it" }));
    expect(ack).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole("button", { name: "Reset votes" }));
    await userEvent.click(screen.getByRole("button", { name: "Yes, reset" }));
    expect(ack).toHaveBeenCalledTimes(2);

    await userEvent.click(screen.getByRole("button", { name: "Remove option Thai" }));
    expect(ack).toHaveBeenCalledWith("o3");
    await expectNoA11yViolations(container);
  });

  it("host can't remove below 2 options", () => {
    current = base({ state: makeState({ isHost: true, poll: { options: makeState().poll.options.slice(0, 2) } }) });
    render(<PollPage pollId="abcdefghjk" hostToken="host-token-1234567890" />);
    expect(screen.getByRole("button", { name: "Remove option Italiano" })).toBeDisabled();
  });

  it("waking up: shows the banner and a loading card while there is no state yet", async () => {
    current = base({ state: null, connection: "waking", waitedSeconds: 12 });
    const { container } = render(<PollPage pollId="abcdefghjk" hostToken={null} />);
    expect(screen.getByTestId("waking")).toHaveTextContent(/Server waking up/);
    expect(screen.getByTestId("waking")).toHaveTextContent("Waiting 12s");
    await expectNoA11yViolations(container);
  });

  it("reconnecting: keeps the poll on screen and says so", () => {
    current = base({ connection: "reconnecting" });
    render(<PollPage pollId="abcdefghjk" hostToken={null} />);
    expect(screen.getByText("Connection lost.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Where do we eat?" })).toBeInTheDocument();
  });

  it("not found / bad host link", async () => {
    current = base({ state: null, fatal: { code: "forbidden", message: "This host link isn't valid." } });
    const { container } = render(<PollPage pollId="abcdefghjk" hostToken="x" />);
    expect(screen.getByRole("alert")).toHaveTextContent("This host link isn't valid.");
    expect(screen.getByRole("link", { name: "Start a new poll" })).toHaveAttribute("href", "#/");
    await expectNoA11yViolations(container);
  });
});

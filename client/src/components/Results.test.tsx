import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { computeResults } from "@livevote/shared";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/axe";
import { options, sampleResults } from "../test/fixtures";
import { Results } from "./Results";

describe("Results", () => {
  it("shows votes AND people per option, e.g. 'Italiano: 2 votes, 14 people'", () => {
    render(<Results results={sampleResults()} closed={false} />);
    const italiano = screen.getByText("Italiano").closest("li")!;
    expect(within(italiano).getByText("2 votes, 14 people")).toBeInTheDocument();
    expect(within(italiano).getByText("Leading")).toBeInTheDocument();
    expect(screen.getByText("Thai").closest("li")).toHaveTextContent("0 votes, 0 people");
    expect(screen.getByTestId("totals")).toHaveTextContent("3 voters · 16 people");
    expect(screen.getByTestId("summary")).toHaveTextContent("Winner: Italiano (2 votes, 14 people) · 16 people in total, 3 voters");
  });

  it("calls the leader 'Winner' once closed", () => {
    render(<Results results={sampleResults()} closed />);
    expect(screen.getByRole("heading", { name: "Final results" })).toBeInTheDocument();
    expect(screen.getByText("Winner")).toBeInTheDocument();
    expect(screen.getByText("Final summary for booking")).toBeInTheDocument();
  });

  it("flags a tie in words, not just colour", () => {
    const tie = computeResults({
      options: options("Italiano", "Sushi"),
      votes: [{ optionIds: ["o1"], people: 2 }, { optionIds: ["o2"], people: 3 }],
    });
    render(<Results results={tie} closed={false} />);
    expect(screen.getByTestId("tie")).toHaveTextContent("It's a tie between Sushi and Italiano");
    expect(screen.getAllByText("Tied")).toHaveLength(2);
    expect(screen.getByTestId("summary")).toHaveTextContent("Tie: Sushi / Italiano (1 vote each)");
  });

  it("shows no tie flag when nobody has voted", () => {
    render(<Results results={computeResults({ options: options("A", "B"), votes: [] })} closed={false} />);
    expect(screen.queryByTestId("tie")).toBeNull();
    expect(screen.getByTestId("summary")).toHaveTextContent("No votes yet");
  });

  it("copies the summary line", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<Results results={sampleResults()} closed />);
    await userEvent.click(screen.getByRole("button", { name: "Copy summary" }));
    expect(writeText).toHaveBeenCalledWith("Winner: Italiano (2 votes, 14 people) · 16 people in total, 3 voters");
    expect(await screen.findByRole("button", { name: "Copied ✓" })).toBeInTheDocument();
  });

  it("is accessible", async () => {
    const { container } = render(<Results results={sampleResults()} closed={false} />);
    await expectNoA11yViolations(container);
  });
});

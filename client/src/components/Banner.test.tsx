import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { expectNoA11yViolations } from "../test/axe";
import { formatRemaining } from "../useNow";
import { ConnectionBanner, WAKE_NOTE_CREATE, WAKE_NOTE_OPEN } from "./Banner";

describe("ConnectionBanner", () => {
  it("renders nothing visible when things are fine, but keeps the polite live region mounted", () => {
    render(<ConnectionBanner kind="online" waitedSeconds={0} />);
    expect(screen.queryByText(/waking/i)).toBeNull();
    const region = screen.getByRole("status");
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region).toBeEmptyDOMElement();
  });

  it("explains a cold start in plain English: up to a minute, and what happens next", async () => {
    const { container } = render(<ConnectionBanner kind="waking" waitedSeconds={7} purpose="create" />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Server waking up");
    expect(status).toHaveTextContent(WAKE_NOTE_CREATE);
    expect(status).toHaveTextContent("takes up to a minute to wake up");
    expect(status).toHaveTextContent("Your poll is created once it's ready.");
    await expectNoA11yViolations(container);
  });

  it("keeps the elapsed seconds out of the live region announcement (aria-hidden)", () => {
    render(<ConnectionBanner kind="waking" waitedSeconds={42} />);
    const secs = screen.getByText(/Waiting 42s/);
    expect(secs).toHaveAttribute("aria-hidden", "true");
  });

  it("shows the note right away, before the 'waking' threshold, while still checking", () => {
    render(<ConnectionBanner kind="checking" waitedSeconds={0} purpose="create" />);
    expect(screen.getByRole("status")).toHaveTextContent(WAKE_NOTE_CREATE);
    render(<ConnectionBanner kind="connecting" waitedSeconds={0} purpose="open" />);
    expect(screen.getAllByRole("status")[1]).toHaveTextContent(WAKE_NOTE_OPEN);
    expect(WAKE_NOTE_OPEN).toContain("This poll opens once it's ready.");
  });

  it("changes to a short confirmation once the server is awake (create screen only)", () => {
    const { rerender } = render(<ConnectionBanner kind="waking" waitedSeconds={9} purpose="create" confirmReady />);
    expect(screen.getByRole("status")).toHaveTextContent("waking up");
    rerender(<ConnectionBanner kind="ready" waitedSeconds={9} purpose="create" confirmReady />);
    expect(screen.getByRole("status")).toHaveTextContent("Server is awake. You can create your poll now.");
    expect(screen.queryByText(/up to a minute/)).toBeNull();
    rerender(<ConnectionBanner kind="online" waitedSeconds={9} purpose="open" />);
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("is the same live region element across states (so changes are announced)", () => {
    const { rerender } = render(<ConnectionBanner kind="checking" waitedSeconds={0} />);
    const before = screen.getByRole("status");
    rerender(<ConnectionBanner kind="waking" waitedSeconds={5} />);
    expect(screen.getByRole("status")).toBe(before);
  });

  it("reassures on reconnect", () => {
    render(<ConnectionBanner kind="reconnecting" waitedSeconds={0} />);
    expect(screen.getByRole("status")).toHaveTextContent("Reconnecting");
  });
});

describe("formatRemaining", () => {
  it.each([
    [0, "closing now"],
    [-5, "closing now"],
    [45_000, "45s"],
    [125_000, "2m 05s"],
    [3_660_000, "1h 1m"],
    [90_000_000, "1d 1h"],
  ])("%i ms -> %s", (ms, text) => expect(formatRemaining(ms)).toBe(text));
});

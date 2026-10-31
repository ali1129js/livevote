import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { expectNoA11yViolations } from "../test/axe";
import { formatRemaining } from "../useNow";
import { ConnectionBanner } from "./Banner";

describe("ConnectionBanner", () => {
  it("renders nothing visible when things are fine", () => {
    render(<ConnectionBanner kind="online" waitedSeconds={0} />);
    expect(screen.queryByText(/waking/i)).toBeNull();
  });
  it("explains a cold start in plain English", async () => {
    const { container } = render(<ConnectionBanner kind="waking" waitedSeconds={7} />);
    expect(screen.getByRole("status")).toHaveTextContent("Server waking up");
    expect(screen.getByRole("status")).toHaveTextContent("30 seconds");
    await expectNoA11yViolations(container);
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

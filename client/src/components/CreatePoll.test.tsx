import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/axe";

const createPoll = vi.fn();
vi.mock("../api", async (orig) => ({
  ...(await orig<typeof import("../api")>()),
  createPoll: (...a: unknown[]) => createPoll(...a),
  pingHealth: () => Promise.resolve(true),
}));

import { ApiFailure } from "../api";
import { CreatePoll, toLocalInput } from "./CreatePoll";

beforeEach(() => {
  createPoll.mockReset();
  window.location.hash = "";
});

async function fillValid() {
  await userEvent.type(screen.getByLabelText("Question"), "Where do we eat?");
  await userEvent.type(screen.getByRole("textbox", { name: "Option 1" }), "Italiano");
  await userEvent.type(screen.getByRole("textbox", { name: "Option 2" }), "Sushi");
}

describe("CreatePoll", () => {
  it("starts with two options, toggles for multiple picks and add-your-own (on by default)", () => {
    render(<CreatePoll />);
    expect(screen.getAllByRole("textbox", { name: /^Option \d$/ })).toHaveLength(2);
    expect(screen.getByLabelText(/Allow multiple picks/)).not.toBeChecked();
    expect(screen.getByLabelText(/Add your own/)).toBeChecked();
    expect(screen.queryByLabelText("Closing time")).toBeNull();
  });

  it("enforces 2 to 6 options in the UI", async () => {
    render(<CreatePoll />);
    for (let i = 0; i < 4; i++) await userEvent.click(screen.getByRole("button", { name: "+ Add option" }));
    expect(screen.getAllByRole("textbox", { name: /^Option \d$/ })).toHaveLength(6);
    expect(screen.queryByRole("button", { name: "+ Add option" })).toBeNull();
    for (let i = 0; i < 4; i++) await userEvent.click(screen.getAllByRole("button", { name: /Remove option/ })[0]!);
    expect(screen.getAllByRole("textbox", { name: /^Option \d$/ })).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /Remove option/ })).toBeNull();
  });

  it("validates before calling the server", async () => {
    render(<CreatePoll />);
    await userEvent.click(screen.getByRole("button", { name: "Create poll" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Question must have at least 3 characters/);
    expect(createPoll).not.toHaveBeenCalled();
  });

  it("rejects near-duplicate options", async () => {
    render(<CreatePoll />);
    await userEvent.type(screen.getByLabelText("Question"), "Where do we eat?");
    await userEvent.type(screen.getByRole("textbox", { name: "Option 1" }), "Café");
    await userEvent.type(screen.getByRole("textbox", { name: "Option 2" }), "cafe ");
    await userEvent.click(screen.getByRole("button", { name: "Create poll" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/appears twice/);
  });

  it("sends the poll, stores the host token and opens the host link", async () => {
    createPoll.mockResolvedValue({ pollId: "abcd2345xy", hostToken: "secret-token-value-123" });
    render(<CreatePoll />);
    await fillValid();
    await userEvent.click(screen.getByLabelText(/Allow multiple picks/));
    await userEvent.click(screen.getByRole("button", { name: "Create poll" }));
    await vi.waitFor(() => expect(createPoll).toHaveBeenCalled());
    expect(createPoll.mock.calls[0]![0]).toMatchObject({
      question: "Where do we eat?",
      options: ["Italiano", "Sushi"],
      multiple: true,
      allowAddOwn: true,
      closesAt: null,
    });
    await vi.waitFor(() => expect(window.location.hash).toBe("#/p/abcd2345xy/host/secret-token-value-123"));
    expect(localStorage.getItem("livevote.host.abcd2345xy")).toBe("secret-token-value-123");
  });

  it("sends a closing time when enabled", async () => {
    createPoll.mockResolvedValue({ pollId: "abcd2345xy", hostToken: "secret-token-value-123" });
    render(<CreatePoll />);
    await fillValid();
    await userEvent.click(screen.getByLabelText(/Close automatically/));
    expect(screen.getByLabelText("Closing time")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Create poll" }));
    await vi.waitFor(() => expect(createPoll).toHaveBeenCalled());
    const closesAt = createPoll.mock.calls[0]![0].closesAt as number;
    expect(closesAt - Date.now()).toBeGreaterThan(50 * 60_000);
    expect(closesAt - Date.now()).toBeLessThan(70 * 60_000);
  });

  it("shows server errors and re-enables the button", async () => {
    createPoll.mockRejectedValue(new ApiFailure("Too many polls created. Try again in a few minutes.", "rate_limited"));
    render(<CreatePoll />);
    await fillValid();
    await userEvent.click(screen.getByRole("button", { name: "Create poll" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Too many polls created");
    expect(screen.getByRole("button", { name: "Create poll" })).toBeEnabled();
  });

  it("formats datetime-local values", () => {
    expect(toLocalInput(new Date(2026, 9, 30, 9, 5).getTime())).toBe("2026-10-30T09:05");
  });

  it("is accessible (with all options open)", async () => {
    const { container } = render(<CreatePoll />);
    await userEvent.click(screen.getByLabelText(/Close automatically/));
    await userEvent.click(screen.getByRole("button", { name: "+ Add option" }));
    await expectNoA11yViolations(container);
  });
});

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/axe";
import { makeState, options } from "../test/fixtures";
import { Ballot } from "./Ballot";

const ok = { ok: true } as const;
const setup = (stateOver = {}, over: Partial<Parameters<typeof Ballot>[0]> = {}) => {
  const onVote = vi.fn().mockResolvedValue(ok);
  const onAdd = vi.fn().mockResolvedValue({ ok: true, data: { optionId: "o4", merged: false } });
  const utils = render(<Ballot state={makeState(stateOver)} onVote={onVote} onAdd={onAdd} {...over} />);
  return { onVote, onAdd, ...utils };
};

describe("Ballot", () => {
  it("renders radios for single-pick polls and submits the pick with the default of 1 person", async () => {
    const { onVote } = setup();
    expect(screen.getAllByRole("radio")).toHaveLength(3);
    await userEvent.click(screen.getByRole("radio", { name: "Sushi" }));
    await userEvent.click(screen.getByRole("button", { name: "Vote" }));
    expect(onVote).toHaveBeenCalledWith(["o2"], 1);
  });

  it("renders checkboxes for approval voting and submits several picks", async () => {
    const { onVote } = setup({ poll: { multiple: true } });
    await userEvent.click(screen.getByRole("checkbox", { name: "Italiano" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Thai" }));
    const people = screen.getByLabelText(/How many people/);
    await userEvent.clear(people);
    await userEvent.type(people, "14");
    await userEvent.click(screen.getByRole("button", { name: "Vote" }));
    expect(onVote).toHaveBeenCalledWith(["o1", "o3"], 14);
  });

  it("requires a pick", async () => {
    const { onVote } = setup();
    await userEvent.click(screen.getByRole("button", { name: "Vote" }));
    expect(onVote).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("Pick an option to vote.");
  });

  it.each(["0", "21", "1.5", ""])("rejects %j people", async (value) => {
    const { onVote } = setup();
    await userEvent.click(screen.getByRole("radio", { name: "Sushi" }));
    const people = screen.getByLabelText(/How many people/);
    await userEvent.clear(people);
    if (value) await userEvent.type(people, value);
    await userEvent.click(screen.getByRole("button", { name: "Vote" }));
    expect(onVote).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("between 1 and 20");
  });

  it("shows server errors", async () => {
    const onVote = vi.fn().mockResolvedValue({ ok: false, error: { code: "closed", message: "This poll is closed." } });
    render(<Ballot state={makeState()} onVote={onVote} onAdd={vi.fn()} />);
    await userEvent.click(screen.getByRole("radio", { name: "Sushi" }));
    await userEvent.click(screen.getByRole("button", { name: "Vote" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This poll is closed.");
  });

  it("pre-fills an existing vote and offers 'Update vote'", async () => {
    const { onVote } = setup({ myVote: { optionIds: ["o3"], people: 5 } }, { editing: true, onDone: vi.fn() });
    expect(screen.getByRole("radio", { name: "Thai" })).toBeChecked();
    expect(screen.getByLabelText(/How many people/)).toHaveValue(5);
    await userEvent.click(screen.getByRole("button", { name: "Update vote" }));
    expect(onVote).toHaveBeenCalledWith(["o3"], 5);
  });

  it("add your own: shows the field when allowed, selects the new option, and tells about merges", async () => {
    const { onAdd, rerender, onVote } = setup();
    await userEvent.type(screen.getByLabelText(/Add your own/), "Burger Barn");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(onAdd).toHaveBeenCalledWith("Burger Barn");
    expect(await screen.findByText(/Added\. It's selected for you/)).toBeInTheDocument();
    // the server pushes the new option
    const withNew = makeState({ poll: { options: [...options("Italiano", "Sushi", "Thai"), { id: "o4", label: "Burger Barn", addedByVoter: true }] }, canAddOption: false });
    rerender(<Ballot state={withNew} onVote={onVote} onAdd={onAdd} />);
    expect(screen.getByRole("radio", { name: /Burger Barn/ })).toBeChecked();
    expect(screen.getByText("added by a voter")).toBeInTheDocument();
    expect(screen.queryByLabelText(/Add your own/)).toBeNull();
  });

  it("add your own: a merged duplicate gets a friendly message", async () => {
    const onAdd = vi.fn().mockResolvedValue({ ok: true, data: { optionId: "o2", merged: true } });
    render(<Ballot state={makeState()} onVote={vi.fn()} onAdd={onAdd} />);
    await userEvent.type(screen.getByLabelText(/Add your own/), "sushi!");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByText(/already exists/)).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Sushi" })).toBeChecked();
  });

  it("hides add your own when disabled or already used", () => {
    setup({ canAddOption: false });
    expect(screen.queryByLabelText(/Add your own/)).toBeNull();
  });

  it("drops a selection when the host removes that option", () => {
    const { rerender, onVote, onAdd } = setup({ myVote: { optionIds: ["o3"], people: 2 } });
    expect(screen.getByRole("radio", { name: "Thai" })).toBeChecked();
    rerender(<Ballot state={makeState({ poll: { options: options("Italiano", "Sushi") } })} onVote={onVote} onAdd={onAdd} />);
    expect(screen.queryByRole("radio", { name: "Thai" })).toBeNull();
    expect(screen.getAllByRole("radio").every((r) => !(r as HTMLInputElement).checked)).toBe(true);
  });

  it("is accessible in single, multiple and add-your-own variants", async () => {
    const a = setup();
    await expectNoA11yViolations(a.container);
    a.unmount();
    const b = setup({ poll: { multiple: true } });
    await expectNoA11yViolations(b.container);
  });
});

import { useEffect, useId, useState, type FormEvent } from "react";
import { LIMITS, type Ack, type AddOptionResult, type ClientState } from "@livevote/shared";

interface Props {
  state: ClientState;
  onVote: (optionIds: string[], people: number) => Promise<Ack>;
  onAdd: (label: string) => Promise<Ack<AddOptionResult>>;
  /** Voter already voted and is editing. */
  editing?: boolean;
  onDone?: (() => void) | undefined;
}

export function Ballot({ state, onVote, onAdd, editing = false, onDone }: Props) {
  const uid = useId();
  const { poll, myVote, canAddOption } = state;
  const [selected, setSelected] = useState<string[]>(myVote?.optionIds ?? []);
  const [people, setPeople] = useState<string>(String(myVote?.people ?? 1));
  const [newLabel, setNewLabel] = useState("");
  const [message, setMessage] = useState<{ kind: "error" | "info"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // Drop selections for options the host removed.
  useEffect(() => {
    setSelected((s) => s.filter((id) => poll.options.some((o) => o.id === id)));
  }, [poll.options]);

  const peopleNum = Number(people);
  const peopleValid = people.trim() !== "" && Number.isInteger(peopleNum) && peopleNum >= LIMITS.peopleMin && peopleNum <= LIMITS.peopleMax;

  const toggle = (id: string) =>
    setSelected((s) => (poll.multiple ? (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]) : [id]));

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (selected.length === 0) return setMessage({ kind: "error", text: poll.multiple ? "Pick at least one option." : "Pick an option to vote." });
    if (!peopleValid) return setMessage({ kind: "error", text: `Enter a number of people between ${LIMITS.peopleMin} and ${LIMITS.peopleMax}.` });
    setBusy(true);
    setMessage(null);
    const ack = await onVote(selected, peopleNum);
    setBusy(false);
    if (!ack.ok) return setMessage({ kind: "error", text: ack.error.message });
    onDone?.();
  }

  async function add(e: FormEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (newLabel.trim() === "") return;
    setBusy(true);
    const ack = await onAdd(newLabel);
    setBusy(false);
    if (!ack.ok) return setMessage({ kind: "error", text: ack.error.message });
    const { optionId, merged } = (ack as { data: AddOptionResult }).data;
    setNewLabel("");
    setSelected((s) => (poll.multiple ? (s.includes(optionId) ? s : [...s, optionId]) : [optionId]));
    setMessage({
      kind: "info",
      text: merged ? "That option already exists, so we selected it for you." : "Added. It's selected for you, tap Vote to confirm.",
    });
  }

  const msgId = `${uid}-msg`;

  return (
    <section className="card stack" aria-labelledby={`${uid}-h`}>
      <h2 id={`${uid}-h`}>{editing ? "Change your vote" : "Your vote"}</h2>
      <form className="stack" onSubmit={(e) => void submit(e)} noValidate aria-describedby={message ? msgId : undefined}>
        <fieldset className="field">
          <legend>{poll.multiple ? "Pick every place you'd be happy with" : "Pick one place"}</legend>
          <ul className="choices">
            {poll.options.map((o) => (
              <li key={o.id} className="choice-row">
                <label className="choice" data-selected={selected.includes(o.id)}>
                  <input
                    type={poll.multiple ? "checkbox" : "radio"}
                    name={`${uid}-choice`}
                    checked={selected.includes(o.id)}
                    onChange={() => toggle(o.id)}
                  />
                  <span className="choice-label">{o.label}</span>
                  {o.addedByVoter && <span className="tag">added by a voter</span>}
                </label>
              </li>
            ))}
          </ul>
        </fieldset>

        <div className="field people">
          <label htmlFor={`${uid}-people`}>
            How many people, including you? <span className="muted">(optional)</span>
          </label>
          <input
            id={`${uid}-people`}
            type="number"
            inputMode="numeric"
            min={LIMITS.peopleMin}
            max={LIMITS.peopleMax}
            step={1}
            value={people}
            aria-invalid={!peopleValid}
            onChange={(e) => setPeople(e.target.value)}
          />
          <small className="muted">Helps whoever books know the table size. 1 to {LIMITS.peopleMax}.</small>
        </div>

        {message && (
          <p id={msgId} role={message.kind === "error" ? "alert" : "status"} className={message.kind === "error" ? "error-box" : "info-box"}>
            {message.text}
          </p>
        )}

        <div className="row">
          <button type="submit" className="btn btn-primary btn-lg" disabled={busy}>
            {editing ? "Update vote" : "Vote"}
          </button>
          {editing && onDone && (
            <button type="button" className="btn" onClick={onDone}>
              Cancel
            </button>
          )}
        </div>
      </form>

      {canAddOption && (
        <form className="add-own" onSubmit={(e) => void add(e)}>
          <div className="field">
            <label htmlFor={`${uid}-add`}>
              Add your own <span className="muted">(one per person)</span>
            </label>
            <div className="row nowrap">
              <input
                id={`${uid}-add`}
                value={newLabel}
                maxLength={LIMITS.optionMax}
                placeholder="Another place you'd like"
                autoComplete="off"
                onChange={(e) => setNewLabel(e.target.value)}
              />
              <button type="submit" className="btn" disabled={busy || newLabel.trim() === ""}>
                Add
              </button>
            </div>
          </div>
        </form>
      )}
    </section>
  );
}

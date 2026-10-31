import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { LIMITS, validateCreateInput, type CreatePollInput } from "@livevote/shared";
import { ApiFailure, createPoll } from "../api";
import { hostTokenKey, safeSet } from "../storage";
import { navigate, pollLink } from "../router";
import { useServerWake } from "../useWake";
import { ConnectionBanner } from "./Banner";

/** `datetime-local` value (local time, minute precision) for an epoch ms. */
export function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

const PLACEHOLDERS = ["Italiano", "Sushi", "Thai", "Burgers", "Falafel", "Pho"];

export function CreatePoll() {
  const uid = useId();
  const wake = useServerWake();
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState<string[]>(["", ""]);
  const [multiple, setMultiple] = useState(false);
  const [allowAddOwn, setAllowAddOwn] = useState(true);
  const [autoClose, setAutoClose] = useState(false);
  const [closeAt, setCloseAt] = useState(() => toLocalInput(Date.now() + 60 * 60_000));
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const errRef = useRef<HTMLDivElement>(null);

  const minClose = useMemo(() => toLocalInput(Date.now() + 61_000), []);

  // Make sure a validation or server error is on screen (on a phone the keyboard or the page height can hide it).
  useEffect(() => {
    if (errors.length > 0) errRef.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }, [errors]);

  const setOption = (i: number, v: string) => setOptions((o) => o.map((x, j) => (j === i ? v : x)));

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const input: CreatePollInput = {
      question,
      options: options.map((o) => o.trim()).filter((o) => o.length > 0),
      multiple,
      allowAddOwn,
      closesAt: autoClose ? new Date(closeAt).getTime() : null,
    };
    if (autoClose && Number.isNaN(input.closesAt)) {
      setErrors(["Pick a valid closing time."]);
      return;
    }
    const v = validateCreateInput(input, Date.now());
    if (!v.ok) {
      setErrors([v.message]);
      return;
    }
    setErrors([]);
    setBusy(true);
    try {
      const { pollId, hostToken } = await createPoll(v.value, { onSlow: wake.markSlow });
      safeSet(hostTokenKey(pollId), hostToken);
      navigate(new URL(pollLink(pollId, hostToken)).hash);
    } catch (err) {
      setErrors([err instanceof ApiFailure ? err.message : "Something went wrong. Please try again."]);
      setBusy(false);
    }
  }

  const errId = `${uid}-err`;

  return (
    <form className="card stack" onSubmit={(e) => void onSubmit(e)} noValidate aria-describedby={errors.length ? errId : undefined}>
      <div>
        <h1>Where should we eat?</h1>
        <p className="muted">Make a quick poll, share the link in your group chat, and watch the votes roll in. No login.</p>
      </div>

      <ConnectionBanner kind={wake.state} waitedSeconds={wake.waitedSeconds} purpose="create" confirmReady busy={busy} />

      <div className="field">
        <label htmlFor={`${uid}-q`}>Question</label>
        <input
          id={`${uid}-q`}
          value={question}
          maxLength={LIMITS.questionMax}
          placeholder="Where do we eat after the shift?"
          autoComplete="off"
          onChange={(e) => setQuestion(e.target.value)}
        />
      </div>

      <fieldset className="field">
        <legend>
          Options{" "}
          <span className="muted">
            ({LIMITS.optionsMin}–{LIMITS.optionsMax})
          </span>
        </legend>
        <ul className="option-inputs">
          {options.map((o, i) => (
            <li key={i}>
              <label className="sr-only" htmlFor={`${uid}-o${i}`}>{`Option ${i + 1}`}</label>
              <input
                id={`${uid}-o${i}`}
                value={o}
                maxLength={LIMITS.optionMax}
                placeholder={PLACEHOLDERS[i] ?? "Another place"}
                autoComplete="off"
                onChange={(e) => setOption(i, e.target.value)}
              />
              {options.length > LIMITS.optionsMin && (
                <button
                  type="button"
                  className="btn btn-icon"
                  aria-label={`Remove option ${i + 1}`}
                  onClick={() => setOptions((x) => x.filter((_, j) => j !== i))}
                >
                  ✕
                </button>
              )}
            </li>
          ))}
        </ul>
        {options.length < LIMITS.optionsMax && (
          <button type="button" className="btn btn-ghost" onClick={() => setOptions((o) => [...o, ""])}>
            + Add option
          </button>
        )}
      </fieldset>

      <fieldset className="field toggles">
        <legend className="sr-only">Poll settings</legend>
        <label className="toggle">
          <input type="checkbox" checked={multiple} onChange={(e) => setMultiple(e.target.checked)} />
          <span>
            <strong>Allow multiple picks</strong>
            <small>Approval voting: everyone can pick all the places they'd be happy with.</small>
          </span>
        </label>
        <label className="toggle">
          <input type="checkbox" checked={allowAddOwn} onChange={(e) => setAllowAddOwn(e.target.checked)} />
          <span>
            <strong>Add your own</strong>
            <small>Each voter may add one option of their own. Near-duplicates are merged.</small>
          </span>
        </label>
        <label className="toggle">
          <input type="checkbox" checked={autoClose} onChange={(e) => setAutoClose(e.target.checked)} />
          <span>
            <strong>Close automatically</strong>
            <small>Voting stops at the time you choose.</small>
          </span>
        </label>
        {autoClose && (
          <div className="field indent">
            <label htmlFor={`${uid}-close`}>Closing time</label>
            <input id={`${uid}-close`} type="datetime-local" value={closeAt} min={minClose} onChange={(e) => setCloseAt(e.target.value)} />
          </div>
        )}
      </fieldset>

      {errors.length > 0 && (
        <div id={errId} ref={errRef} role="alert" className="error-box">
          {errors.map((m) => (
            <p key={m}>{m}</p>
          ))}
        </div>
      )}

      <button type="submit" className="btn btn-primary btn-lg" disabled={busy} aria-busy={busy}>
        {busy && <span className="spinner spinner-inline" aria-hidden="true" />}
        {busy ? (wake.state === "waking" ? "Waking the server…" : "Creating…") : "Create poll"}
      </button>
    </form>
  );
}

import { useState } from "react";
import { LIMITS } from "@livevote/shared";
import { pollLink } from "../router";
import { usePoll } from "../usePoll";
import { formatRemaining, useNow } from "../useNow";
import { ConnectionBanner } from "./Banner";
import { Ballot } from "./Ballot";
import { HostPanel, ShareCard } from "./HostPanel";
import { Results } from "./Results";

function formatTime(ms: number): string {
  return new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(ms));
}

export function PollPage({ pollId, hostToken }: { pollId: string; hostToken: string | null }) {
  const live = usePoll(pollId, hostToken);
  const { state, connection, fatal, actions } = live;
  const [editing, setEditing] = useState(false);
  const now = useNow(live.clockOffset, state?.poll.closesAt != null && !state.poll.closed);

  if (fatal) {
    return (
      <div className="card stack" role="alert">
        <h1>{fatal.code === "not_found" ? "Poll not found" : "Can't open this poll"}</h1>
        <p>{fatal.message}</p>
        <p>
          <a className="btn btn-primary" href="#/">
            Start a new poll
          </a>
        </p>
      </div>
    );
  }

  if (!state) {
    return (
      <div className="stack" aria-busy="true">
        <ConnectionBanner kind={connection} waitedSeconds={live.waitedSeconds} purpose="open" />
        <div className="card stack">
          <div className="skeleton skeleton-title" />
          <div className="skeleton" />
          <div className="skeleton" />
          <p className="muted">{connection === "waking" ? "Still trying…" : "Opening poll…"}</p>
        </div>
      </div>
    );
  }

  const { poll, myVote, results, isHost } = state;
  const hasVoted = myVote !== null;
  const shareUrl = pollLink(poll.id);
  const hostUrl = hostToken ? pollLink(poll.id, hostToken) : "";

  return (
    <div className="stack">
      <ConnectionBanner kind={connection} waitedSeconds={live.waitedSeconds} />

      <header className="card stack poll-head">
        <div className="row between">
          <span className="status" data-closed={poll.closed}>
            {poll.closed ? (poll.closedBy === "host" ? "Closed by host" : "Closed") : "Open"}
          </span>
          {poll.closesAt !== null && !poll.closed && (
            <span className="muted" data-testid="closes">
              Closes {formatTime(poll.closesAt)} · {formatRemaining(poll.closesAt - now)}
            </span>
          )}
        </div>
        <h1>{poll.question}</h1>
        <p className="muted">
          {poll.multiple ? "Pick as many as you like (approval voting)." : "Pick one."}{" "}
          {poll.allowAddOwn && !poll.closed ? "You can add one option of your own." : ""}
        </p>
      </header>

      {isHost && <ShareCard shareUrl={shareUrl} />}

      {!poll.closed && (!hasVoted || editing) && (
        <Ballot
          key={editing ? "edit" : "new"}
          state={state}
          editing={editing}
          onVote={actions.vote}
          onAdd={actions.addOption}
          onDone={() => setEditing(false)}
        />
      )}

      {!poll.closed && hasVoted && !editing && myVote && (
        <section className="card row between" aria-label="Your vote">
          <p>
            <strong>You voted</strong> for{" "}
            {myVote.optionIds
              .map((id) => poll.options.find((o) => o.id === id)?.label)
              .filter(Boolean)
              .join(", ")}{" "}
            · {myVote.people} {myVote.people === 1 ? "person" : "people"}
          </p>
          <button type="button" className="btn" onClick={() => setEditing(true)}>
            Change vote
          </button>
        </section>
      )}

      {poll.closed && myVote && (
        <section className="card" aria-label="Your vote">
          <p>
            <strong>You voted</strong> for{" "}
            {myVote.optionIds
              .map((id) => poll.options.find((o) => o.id === id)?.label)
              .filter(Boolean)
              .join(", ")}
            .
          </p>
        </section>
      )}

      {results ? (
        <Results results={results} closed={poll.closed} />
      ) : (
        <section className="card" aria-label="Results locked">
          <p className="muted">
            <span aria-hidden="true">🔒</span> Vote first, then you'll see the live results. This keeps everyone's pick unbiased.
          </p>
        </section>
      )}

      {isHost && (
        <HostPanel state={state} hostUrl={hostUrl} onClose={actions.close} onReset={actions.reset} onRemove={actions.removeOption} />
      )}

      <p className="muted footnote">
        One vote per browser. Polls disappear after 7 days. Up to {LIMITS.optionsTotalMax} options, including ones voters add.
      </p>
    </div>
  );
}

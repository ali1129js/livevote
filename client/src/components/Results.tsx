import { plural, type Results as ResultsData } from "@livevote/shared";
import { CopyButton } from "./CopyButton";

export function Results({ results, closed }: { results: ResultsData; closed: boolean }) {
  const maxVotes = Math.max(1, ...results.options.map((o) => o.votes));
  const leaders = results.options.filter((o) => o.isLeader);
  const names = leaders.map((o) => o.label);

  return (
    <section className="card stack" aria-labelledby="results-h">
      <div className="row between">
        <h2 id="results-h">{closed ? "Final results" : "Live results"}</h2>
        <span className="muted" data-testid="totals">
          {plural(results.voters, "voter")} · {plural(results.totalPeople, "person", "people")}
        </span>
      </div>

      {results.tie && (
        <p className="tie-flag" data-testid="tie">
          <span aria-hidden="true">⚖️</span> <strong>It's a tie</strong> between {names.join(" and ")}
          {closed ? "." : ". Every vote counts, so it can still change."}
        </p>
      )}

      <ul className="results">
        {results.options.map((o) => {
          const pct = Math.round((o.votes / maxVotes) * 100);
          return (
            <li key={o.optionId} className="result" data-leader={o.isLeader}>
              <div className="result-head">
                <span className="result-label">
                  {o.label}
                  {o.isLeader && (
                    <span className="badge">{results.tie ? "Tied" : closed ? "Winner" : "Leading"}</span>
                  )}
                </span>
                <span className="result-nums">
                  {plural(o.votes, "vote")}, {plural(o.people, "person", "people")}
                </span>
              </div>
              <div className="bar" aria-hidden="true">
                <div className="bar-fill" style={{ width: `${pct}%` }} />
              </div>
            </li>
          );
        })}
      </ul>

      <div className="summary">
        <p className="summary-label" id="summary-label">
          {closed ? "Final summary for booking" : "Current standing (copy for booking)"}
        </p>
        <div className="summary-row">
          <output className="summary-text" aria-labelledby="summary-label" aria-live="polite" data-testid="summary">
            {results.summary}
          </output>
          <CopyButton text={results.summary} label="Copy summary" />
        </div>
      </div>
    </section>
  );
}

import type { Connection } from "../usePoll";

/** Cold-start and reconnect notices. Polite live region so screen readers hear changes. */
export function ConnectionBanner({ kind, waitedSeconds }: { kind: Connection | "ready"; waitedSeconds: number }) {
  if (kind === "online" || kind === "ready" || kind === "connecting") return <div role="status" aria-live="polite" />;
  if (kind === "reconnecting") {
    return (
      <div role="status" className="banner banner-warn">
        <span className="spinner" aria-hidden="true" />
        <div>
          <strong>Connection lost.</strong> Reconnecting… your vote is safe.
        </div>
      </div>
    );
  }
  return (
    <div role="status" className="banner banner-info" data-testid="waking">
      <span className="spinner" aria-hidden="true" />
      <div>
        <strong>Server waking up…</strong> The free server sleeps when nobody uses it, so the first visit can take up to
        30 seconds. Hang tight, this page continues on its own.
        <span className="banner-time"> Waiting {waitedSeconds}s</span>
      </div>
    </div>
  );
}

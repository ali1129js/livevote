import type { Connection } from "../usePoll";

export const WAKE_NOTE_CREATE = "First visit in a while? The server takes up to a minute to wake up. Your poll is created once it's ready.";
export const WAKE_NOTE_OPEN = "First visit in a while? The server takes up to a minute to wake up. This poll opens once it's ready.";

export type BannerKind = Connection | "checking" | "ready";

interface Props {
  kind: BannerKind;
  waitedSeconds: number;
  /** What the wait is for: shapes the always-visible note. */
  purpose?: "create" | "open";
  /** Show a short "server is awake" confirmation once connected (create screen) instead of nothing (poll screen). */
  confirmReady?: boolean;
  /** The user already tapped the main button and we are retrying behind the scenes. */
  busy?: boolean;
}

/**
 * Cold-start and reconnect notices. The outer polite live region is always mounted, so screen readers announce every
 * change ("Server waking up" -> "Server is awake"). The elapsed seconds are aria-hidden so they don't chatter.
 * All variants reuse the themed .banner-info / .banner-warn colours (checked for contrast in all three themes).
 */
export function ConnectionBanner({ kind, waitedSeconds, purpose = "open", confirmReady = false, busy = false }: Props) {
  const note = purpose === "create" ? WAKE_NOTE_CREATE : WAKE_NOTE_OPEN;
  let body = null;
  if (kind === "reconnecting") {
    body = (
      <div className="banner banner-warn">
        <span className="spinner" aria-hidden="true" />
        <div>
          <strong>Connection lost.</strong> Reconnecting… your vote is safe.
        </div>
      </div>
    );
  } else if (kind === "waking") {
    body = (
      <div className="banner banner-info" data-testid="waking">
        <span className="spinner" aria-hidden="true" />
        <div>
          <strong>Server waking up…</strong> {note}
          {busy && purpose === "create" ? " Keep this page open." : ""}
          <span className="banner-time" aria-hidden="true">
            {" "}
            Waiting {waitedSeconds}s
          </span>
        </div>
      </div>
    );
  } else if (kind === "checking" || kind === "connecting") {
    body = (
      <div className="banner banner-info" data-testid="wake-note">
        <span className="spinner" aria-hidden="true" />
        <div>
          <strong>Checking the server…</strong> {note}
        </div>
      </div>
    );
  } else if (confirmReady && (kind === "ready" || kind === "online")) {
    body = (
      <div className="banner banner-info" data-testid="awake">
        <span aria-hidden="true">✓</span>
        <div>
          <strong>Server is awake.</strong> You can create your poll now.
        </div>
      </div>
    );
  }
  return (
    <div role="status" aria-live="polite" aria-atomic="true" data-testid="connection-status">
      {body}
    </div>
  );
}

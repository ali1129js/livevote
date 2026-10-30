import { useEffect, useState } from "react";
import QRCode from "qrcode";
import type { ClientState } from "@livevote/shared";
import { CopyButton } from "./CopyButton";

export function QrImage({ text }: { text: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    // Always dark-on-white with a quiet zone, whatever the theme, so phones can scan it.
    QRCode.toString(text, { type: "svg", margin: 2, color: { dark: "#000000", light: "#ffffff" } })
      .then((svg) => live && setSrc(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`))
      .catch(() => live && setSrc(null));
    return () => {
      live = false;
    };
  }, [text]);
  if (!src) return <div className="qr qr-empty" aria-hidden="true" />;
  return <img className="qr" src={src} width={176} height={176} alt="QR code that opens the share link" />;
}

interface Props {
  state: ClientState;
  shareUrl: string;
  hostUrl: string;
  onClose: () => Promise<unknown>;
  onReset: () => Promise<unknown>;
  onRemove: (optionId: string) => Promise<{ ok: boolean; error?: { message: string } }>;
}

export function ShareCard({ shareUrl }: { shareUrl: string }) {
  return (
    <section className="card stack" aria-labelledby="share-h">
      <h2 id="share-h">Share with your team</h2>
      <div className="share-grid">
        <QrImage text={shareUrl} />
        <div className="stack">
          <label htmlFor="share-url">Share link</label>
          <input id="share-url" readOnly value={shareUrl} onFocus={(e) => e.currentTarget.select()} />
          <div className="row">
            <CopyButton text={shareUrl} label="Copy share link" className="btn btn-primary" />
          </div>
        </div>
      </div>
    </section>
  );
}

export function HostPanel({ state, hostUrl, onClose, onReset, onRemove }: Omit<Props, "shareUrl">) {
  const [confirm, setConfirm] = useState<"close" | "reset" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const closed = state.poll.closed;
  return (
    <section className="card stack host" aria-labelledby="host-h">
      <h2 id="host-h">Host controls</h2>
      <div className="field">
        <label htmlFor="host-url">
          Private host link <span className="tag tag-warn">keep this secret</span>
        </label>
        <input id="host-url" readOnly value={hostUrl} onFocus={(e) => e.currentTarget.select()} />
        <small className="muted">Anyone with this link can close or reset the poll. Save it to come back later.</small>
        <div className="row">
          <CopyButton text={hostUrl} label="Copy host link" />
        </div>
      </div>

      <div className="row">
        {!closed && (
          <button type="button" className="btn btn-primary" onClick={() => setConfirm("close")}>
            Close poll
          </button>
        )}
        <button type="button" className="btn" onClick={() => setConfirm("reset")}>
          Reset votes
        </button>
      </div>
      {!closed && (
        <div className="field">
          <p className="field-title">Options</p>
          <ul className="manage-options">
            {state.poll.options.map((o) => (
              <li key={o.id}>
                <span>
                  {o.label} {o.addedByVoter && <span className="tag">added by a voter</span>}
                </span>
                <button
                  type="button"
                  className="btn btn-danger"
                  disabled={state.poll.options.length <= 2}
                  aria-label={`Remove option ${o.label}`}
                  onClick={() => {
                    setErr(null);
                    void onRemove(o.id).then((a) => !a.ok && setErr(a.error?.message ?? "Couldn't remove it."));
                  }}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
          {err && <p role="alert" className="error-box">{err}</p>}
        </div>
      )}

      {confirm && (
        <div role="alertdialog" aria-labelledby="confirm-h" className="confirm">
          <p id="confirm-h">
            {confirm === "close"
              ? "Close voting now? Everyone will see the final results."
              : "Reset the poll? All votes are cleared and voting re-opens."}
          </p>
          <div className="row">
            <button
              type="button"
              className="btn btn-primary"
              autoFocus
              onClick={() => {
                void (confirm === "close" ? onClose() : onReset());
                setConfirm(null);
              }}
            >
              {confirm === "close" ? "Yes, close it" : "Yes, reset"}
            </button>
            <button type="button" className="btn" onClick={() => setConfirm(null)}>
              Keep going
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

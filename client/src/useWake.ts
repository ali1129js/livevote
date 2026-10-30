import { useEffect, useState } from "react";
import { pingHealth } from "./api";
import { WAKING_AFTER_MS } from "./config";

export type WakeState = "checking" | "waking" | "ready";

/** Pre-warms the server on the create screen and reports when it is slow to answer. */
export function useServerWake(): { state: WakeState; waitedSeconds: number; markSlow: () => void } {
  const [state, setState] = useState<WakeState>("checking");
  const [waited, setWaited] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    const started = Date.now();
    const slow = setTimeout(() => setState((s) => (s === "ready" ? s : "waking")), WAKING_AFTER_MS);
    const tick = setInterval(() => setWaited(Math.floor((Date.now() - started) / 1000)), 500);
    let stop = false;
    void (async () => {
      while (!stop) {
        if (await pingHealth(ctrl.signal)) {
          if (!stop) setState("ready");
          return;
        }
        await new Promise((r) => setTimeout(r, 1500));
      }
    })();
    return () => {
      stop = true;
      ctrl.abort();
      clearTimeout(slow);
      clearInterval(tick);
    };
  }, []);

  return { state, waitedSeconds: waited, markSlow: () => setState((s) => (s === "ready" ? s : "waking")) };
}

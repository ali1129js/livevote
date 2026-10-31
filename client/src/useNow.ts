import { useEffect, useState } from "react";

/** Server-adjusted "now" that re-renders every second. */
export function useNow(clockOffset: number, active = true): number {
  const [now, setNow] = useState(() => Date.now() + clockOffset);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now() + clockOffset), 1000);
    setNow(Date.now() + clockOffset);
    return () => clearInterval(t);
  }, [clockOffset, active]);
  return now;
}

export function formatRemaining(ms: number): string {
  if (ms <= 0) return "closing now";
  const s = Math.ceil(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, "0")}s`;
  return `${sec}s`;
}

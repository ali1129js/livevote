import { useEffect, useRef, useState } from "react";

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

export function CopyButton({ text, label, className = "btn" }: { text: string; label: string; className?: string }) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const onClick = async () => {
    const ok = await copyText(text);
    setStatus(ok ? "copied" : "failed");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setStatus("idle"), 2500);
  };
  return (
    <>
      <button type="button" className={className} onClick={() => void onClick()}>
        {status === "copied" ? "Copied ✓" : label}
      </button>
      <span className="sr-only" role="status">
        {status === "copied" ? "Copied to clipboard" : status === "failed" ? "Copy failed, select the text manually" : ""}
      </span>
    </>
  );
}

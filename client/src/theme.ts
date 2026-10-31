import { useCallback, useEffect, useState } from "react";
import { safeGet, safeSet } from "./storage";

export const THEMES = ["light", "dark", "contrast"] as const;
export type Theme = (typeof THEMES)[number];
export const THEME_LABELS: Record<Theme, string> = { light: "Light", dark: "Dark", contrast: "High contrast" };

const KEY = "livevote.theme";

export function initialTheme(): Theme {
  const stored = safeGet(KEY);
  if (stored && (THEMES as readonly string[]).includes(stored)) return stored as Theme;
  if (typeof window.matchMedia === "function") {
    if (window.matchMedia("(prefers-contrast: more)").matches) return "contrast";
    if (window.matchMedia("(prefers-color-scheme: dark)").matches) return "dark";
  }
  return "light";
}

export function applyTheme(t: Theme): void {
  document.documentElement.dataset.theme = t;
}

export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  useEffect(() => applyTheme(theme), [theme]);
  const set = useCallback((t: Theme) => {
    safeSet(KEY, t);
    setTheme(t);
  }, []);
  return [theme, set];
}

import { THEMES, THEME_LABELS, type Theme } from "../theme";

export function ThemeSwitcher({ theme, onChange }: { theme: Theme; onChange: (t: Theme) => void }) {
  return (
    <div className="theme-switch" role="group" aria-label="Theme">
      {THEMES.map((t) => (
        <button key={t} type="button" className="chip" aria-pressed={theme === t} onClick={() => onChange(t)}>
          {THEME_LABELS[t]}
        </button>
      ))}
    </div>
  );
}

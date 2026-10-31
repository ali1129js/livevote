import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ThemeSwitcher } from "./components/ThemeSwitcher";
import { applyTheme, initialTheme } from "./theme";
import { expectNoA11yViolations } from "./test/axe";

function mockMedia(matches: Record<string, boolean>) {
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: matches[q] ?? false, media: q, addEventListener() {}, removeEventListener() {} }));
}

describe("theme", () => {
  it("respects a stored choice first", () => {
    localStorage.setItem("livevote.theme", "dark");
    expect(initialTheme()).toBe("dark");
  });
  it("falls back to OS preferences: contrast beats dark beats light", () => {
    mockMedia({ "(prefers-contrast: more)": true, "(prefers-color-scheme: dark)": true });
    expect(initialTheme()).toBe("contrast");
    mockMedia({ "(prefers-color-scheme: dark)": true });
    expect(initialTheme()).toBe("dark");
    mockMedia({});
    expect(initialTheme()).toBe("light");
    vi.unstubAllGlobals();
  });
  it("ignores junk in storage", () => {
    localStorage.setItem("livevote.theme", "neon");
    mockMedia({});
    expect(initialTheme()).toBe("light");
    vi.unstubAllGlobals();
  });
  it("applies the theme to <html>", () => {
    applyTheme("contrast");
    expect(document.documentElement.dataset.theme).toBe("contrast");
  });
  it("ThemeSwitcher exposes three pressed-state buttons and is accessible", async () => {
    const onChange = vi.fn();
    const { container } = render(<ThemeSwitcher theme="dark" onChange={onChange} />);
    expect(screen.getByRole("button", { name: "Dark" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Light" })).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(screen.getByRole("button", { name: "High contrast" }));
    expect(onChange).toHaveBeenCalledWith("contrast");
    await expectNoA11yViolations(container);
  });
});

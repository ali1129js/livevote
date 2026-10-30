import axe from "axe-core";
import { expect } from "vitest";

/**
 * Structural WCAG checks on a rendered subtree (names, roles, labels, ARIA, landmarks, ...).
 * jsdom has no layout engine, so colour contrast is verified separately in the Playwright
 * e2e suite (real Chrome, all three themes).
 */
export async function expectNoA11yViolations(container: Element): Promise<void> {
  const results = await axe.run(container, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"] },
    rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
  });
  const summary = results.violations.map((v) => `${v.id}: ${v.help} -> ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
  expect(summary).toEqual([]);
}

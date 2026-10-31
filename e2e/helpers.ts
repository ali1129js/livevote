import { mkdirSync } from "node:fs";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";
import { io } from "socket.io-client";

export const SERVER_URL = "http://localhost:3101";
export const ORIGIN = "http://localhost:4173";
export const SHOTS_DIR = process.env.SHOTS_DIR ?? "e2e/.shots";
export const TAKE_SHOTS = process.env.SHOTS === "1";

const THEMES = [
  { key: "light", label: "Light" },
  { key: "dark", label: "Dark" },
  { key: "contrast", label: "High contrast" },
] as const;
const WIDTHS = [
  { name: "1280", width: 1280, height: 900 },
  { name: "390", width: 390, height: 844 },
] as const;

/**
 * For the current page state: in each of the 3 themes run an axe WCAG 2.x A/AA scan (incl. colour contrast),
 * and, when SHOTS=1, save full-page screenshots at 1280 and 390 px wide.
 */
export async function checkState(page: Page, name: string): Promise<void> {
  if (TAKE_SHOTS) mkdirSync(SHOTS_DIR, { recursive: true });
  for (const theme of THEMES) {
    await page.getByRole("button", { name: theme.label, exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme.key);
    for (const w of WIDTHS) {
      await page.setViewportSize({ width: w.width, height: w.height });
      await page.waitForTimeout(w.name === "1280" ? 80 : 120);
      if (w.name === "1280") {
        const res = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
        const summary = res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
        expect(summary, `axe violations on "${name}" in ${theme.key} theme`).toEqual([]);
      }
      if (TAKE_SHOTS) {
        await page.screenshot({ path: join(SHOTS_DIR, `${name}-${theme.key}-${w.name}.png`), fullPage: true, animations: "disabled" });
      }
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole("button", { name: "Light", exact: true }).click();
}

type Ack = { ok: boolean; error?: { code: string }; data?: unknown };

/** Minimal scripted voter for seeding results (a real browser can't be in 12 places at once). */
export class FakeVoter {
  private constructor(private readonly socket: ReturnType<typeof io>) {}

  static async join(pollId: string, n: number, hostToken?: string): Promise<FakeVoter> {
    const socket = io(SERVER_URL, { transports: ["websocket"], forceNew: true, extraHeaders: { origin: ORIGIN } });
    const v = new FakeVoter(socket);
    const ack = await v.emit("poll:join", { pollId, voterId: `e2e-seed-voter-${String(n).padStart(4, "0")}`, ...(hostToken ? { hostToken } : {}) });
    if (!ack.ok) throw new Error(`join failed: ${ack.error?.code}`);
    return v;
  }

  emit(event: string, payload?: unknown): Promise<Ack> {
    return new Promise((resolve) => {
      const send = this.socket.emit.bind(this.socket) as (...a: unknown[]) => void;
      if (payload === undefined) send(event, resolve);
      else send(event, payload, resolve);
    });
  }

  async vote(optionIds: string[], people: number): Promise<void> {
    const ack = await this.emit("vote:cast", { optionIds, people });
    if (!ack.ok) throw new Error(`vote failed: ${ack.error?.code}`);
  }

  close(): void {
    this.socket.disconnect();
  }
}

export async function createPollViaApi(body: Record<string, unknown>): Promise<{ pollId: string; hostToken: string }> {
  const res = await fetch(`${SERVER_URL}/api/polls`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: { pollId: string; hostToken: string } }).data;
}

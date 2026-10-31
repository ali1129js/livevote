// Live smoke test against the deployed site (not part of `npm run e2e`):
//   LIVE_URL=https://<user>.github.io/livevote/ OUT=/tmp/shots node e2e/live-check.mjs
// Fresh browser context per run, desktop + mobile (390 px), with and without "Close automatically". Prints console errors,
// network requests, socket.io frames and timings, and what the user sees on the button / in alerts. Exit 1 on any failure.
import { existsSync, mkdirSync } from "node:fs";
const chrome = process.env.CHROME_PATH ?? ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((p) => existsSync(p));
import { chromium } from "@playwright/test";
const URL_ = process.env.LIVE_URL ?? "https://ali1129js.github.io/livevote/";
const out = process.env.OUT ?? "e2e/.live";
mkdirSync(out, { recursive: true });
const failures = [];
const profiles = [
  { name: "desktop", viewport: { width: 1280, height: 900 } },
  { name: "mobile", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" },
];
const API = new URL(process.env.SERVER_URL ?? "https://livevote-twdq.onrender.com");
// HEALTH_FIRST=0 skips the pre-flight pings (use it to see a COLD server from the browser first).
for (let i = 1; i <= (process.env.HEALTH_FIRST === "0" ? 0 : 3); i++) {
  const t = Date.now();
  const r = await fetch(new URL("/api/health", API), { cache: "no-store" }).catch(() => null);
  console.log(`health #${i}: ${r ? r.status : "FAILED"} in ${Date.now() - t} ms`);
}
const browser = await chromium.launch({ ...(chrome ? { executablePath: chrome } : {}), args: ["--no-sandbox"] });
const only = process.env.PROFILE; // "desktop" | "mobile"
for (const withClose of process.env.CLOSE_ONLY === "0" ? [false] : [false, true]) for (const p of profiles.filter((x) => !only || x.name === only)) {
  const { name, ...ctxOpts } = p;
  const ctx = await browser.newContext(ctxOpts); // fresh context
  const page = await ctx.newPage();
  const t0 = Date.now(); const T = () => `${((Date.now()-t0)/1000).toFixed(2)}s`;
  const log = [];
  page.on("console", m => log.push(`${T()} console.${m.type()}: ${m.text()}`));
  page.on("pageerror", e => log.push(`${T()} pageerror: ${e.message}`));
  page.on("request", r => { if (!r.url().startsWith("data:")) log.push(`${T()} --> ${r.method()} ${r.url()}`); });
  page.on("response", r => log.push(`${T()} <-- ${r.status()} ${r.url()} acao=${r.headers()["access-control-allow-origin"] ?? "-"}`));
  page.on("requestfailed", r => log.push(`${T()} FAILED ${r.url()} ${r.failure()?.errorText}`));
  page.on("websocket", ws => { log.push(`${T()} WS open ${ws.url()}`); ws.on("framesent", f => log.push(`${T()} WS > ${String(f.payload).slice(0,100)}`)); ws.on("framereceived", f => log.push(`${T()} WS < ${String(f.payload).slice(0,100)}`)); ws.on("close", () => log.push(`${T()} WS close`)); });
  await page.goto(URL_, { waitUntil: "load" });
  await page.getByLabel("Question").fill("Where should we eat?");
  await page.getByRole("textbox", { name: "Option 1" }).fill("Italiano");
  await page.getByRole("textbox", { name: "Option 2" }).fill("Sushi");
  if (withClose) await page.getByLabel("Close automatically").check();
  const btn = page.getByRole("button", { name: /Create poll|Creating|Waking/ });
  log.push(`${T()} button before click: "${await btn.innerText()}" disabled=${await btn.isDisabled()}`);
  await btn.click();
  log.push(`${T()} clicked`);
  let result = "TIMEOUT";
  try { await page.waitForURL(/#\/p\//, { timeout: 100000 }); await page.getByRole("img", { name: /QR code/ }).waitFor({ timeout: 10000 }); result = "OK host page"; } catch {}
  const alert = await page.getByRole("alert").allInnerTexts();
  log.push(`${T()} after: button="${await page.getByRole("button", { name: /Create poll|Creating|Waking/ }).innerText().catch(()=>"(gone)")}" alerts=${JSON.stringify(alert)} url=${page.url()}`);
  if (result !== "OK host page") failures.push(`${name} closeAuto=${withClose}`);
  console.log(`\n===== ${name} closeAuto=${withClose} => ${result} =====\n` + log.join("\n"));
  await page.screenshot({ path: `${out}/${name}-${withClose ? "close" : "noclose"}.png`, fullPage: true });
  await ctx.close();
}
await browser.close();
if (failures.length) {
  console.error("FAILED: " + failures.join(", "));
  process.exit(1);
}

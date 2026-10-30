# LiveVote

Quick live polls for a group chat. Built for one job: a shift team picking a dinner restaurant.
No login. The host makes a poll, shares a link (or QR code), everyone votes, and results update live.

> **Origin: 2018.** LiveVote is a rebuild of Ali's earlier real-time experiments:
> [`pollingapp`](https://github.com/ali1129js/pollingapp) (first commit **2018-04-11**, "express server and create-react-app client"),
> [`chat-app`](https://github.com/ali1129js/chat-app) (first commit 2019-10-04) and
> [`socket-io-test`](https://github.com/ali1129js/socket-io-test) (first commit 2019-12-04, a presenter/audience quiz with a score board).
> The earliest commit across the three is `pollingapp`'s on 2018-04-11, so the origin year is 2018.
> No code or secrets were copied; only the idea (Express + Socket.IO + React, push results to everyone) carries over.

## What it does

- **Host** creates a poll: question, 2–6 options, optional closing time, *multiple picks* (approval voting) toggle, *Add your own* toggle.
- Host gets a **share link + QR code** and a **private host link** (secret token) to close, reset, or remove options.
- **Voter** opens the share link, sees the question and options first, picks one or several, and optionally enters
  *how many people including you* (1–20, default 1). Only after voting do they see live result bars (late joiners vote first).
- Results show **votes and people per option**, e.g. `Italiano: 6 votes, 14 people`. **Ties are flagged** in words.
  A **copyable summary line** gives winner, total people and voter count for booking:
  `Winner: Italiano (6 votes, 14 people) · 25 people in total, 12 voters`.
- **Add your own**: each voter may add one option. It appears live for everyone and can be voted on.
  Near-duplicates are merged (case, whitespace, diacritics, punctuation normalised). The host can remove any option.
- A voter can **change their vote** until the poll closes. Updates arrive in well under a second; reconnects restore state.
- **"Server waking up"** screen for Render free-tier cold starts (~30 s), on the poll page and on the create page.
- Three themes: **light, dark, high contrast** (follows OS preferences, switchable, remembered). English UI.

## Stack

| Part | Tech |
| --- | --- |
| `client/` | Vite 8, React 19, TypeScript (strict), `socket.io-client`, `qrcode` |
| `server/` | Node 20+, Express 5, Socket.IO 4, TypeScript (strict) |
| `shared/` | Types, limits, validation, label normalisation and tally logic used by both sides |
| Tests | Vitest (shared, server, socket integration, client), axe-core (a11y), Playwright + Chrome (e2e, axe, screenshots) |

TypeScript runs with `strict` and `noUncheckedIndexedAccess` (plus `exactOptionalPropertyTypes`, `noUnusedLocals`, …) everywhere.

## Run it

```bash
npm install
npm run dev          # server on :3001, client on :5173
```

Open http://localhost:5173, create a poll, open the share link in a second (private) window to vote.

```bash
npm run typecheck    # tsc for shared, server, client, e2e
npm test             # Vitest: unit + component + socket integration
npm run e2e          # Playwright e2e (builds client, starts server+preview itself) incl. axe in all 3 themes
SHOTS_DIR=./shots npm run shots   # same walkthrough, also writes screenshots (3 themes x 1280/390 px)
```

e2e uses a system Chrome at `/usr/bin/google-chrome` if present (override with `CHROME_PATH`), else Playwright's Chromium
(`npx playwright install chromium`).

## Design decisions

- **Server is the authority.** The server decides who may see results: a socket gets `results` only if it has voted, is the host, or the poll is closed. Hiding results in the UI alone would leak them over the socket.
- **Per-viewer state pushes.** After any change the server sends each connected viewer *their* `ClientState` (poll, own vote, `canAddOption`, results or `null`). Simple, hard to get wrong, fine for ≤500 voters per poll.
- **Store interface.** `PollStore` (`server/src/store.ts`) is async with one atomic primitive, `update(id, mutate)`; two implementations: `MemoryPollStore` (default) and `PgPollStore` (`server/src/pgStore.ts`, Postgres), chosen at startup by `DATABASE_URL` (see *Persistence*). Neither touches `PollService` or the sockets. Both work on copies and commit all-or-nothing; in Postgres `update` is one transaction holding a `SELECT … FOR UPDATE` row lock, so concurrent votes / option adds on the same poll queue up instead of overwriting each other (the 500-voter and 10-option caps are checked inside that lock).
- **Host token.** 24 random bytes (base64url) shown once; only its SHA-256 is stored; compared in constant time. It lives in the URL *fragment* (`#/p/<id>/host/<token>`), so it is never sent to the static host or written to server access logs. Not logged anywhere.
- **Hash routing.** Works on GitHub Pages without rewrites and keeps the token out of requests.
- **Votes and people.** `votes` = voters who picked an option; `people` = sum of those voters' party sizes. With approval voting, a voter's party counts toward each option they picked, but **total people counts each voter once**.
- **Winner & ties.** Winner = most votes. Equal top vote counts are a tie, shown as a banner, `Tied` badges and a `Tie: A / B` summary (people count is only used to order rows).
- **Add your own.** One real add per voter (tracked by voter id). A merged duplicate does not use up the add and selects the existing option. Max 10 options in total. Host-removing an option deletes its votes; a voter left with no pick can vote again.
- **Closing.** `closesAt` is checked on every write; a server timer also pushes the closed state so open screens flip at the deadline. Host *Reset* clears votes (and add-your-own allowances) and re-opens (an elapsed deadline is dropped).
- **Limits & validation.** Question ≤140 chars, option ≤60, 2–6 options, people 1–20, ≤500 voters/poll, ≤5000 polls stored, 8 kB JSON bodies, 10 kB socket messages, closing time 1 min–7 days ahead, control characters stripped, all inputs re-validated on the server.
- **Rate limiting.** Per IP: 10 poll creations / 10 min, 60 joins / min; per socket: 30 events / 10 s. In-memory fixed windows. `X-Forwarded-For` is trusted only when `TRUST_PROXY` says how many proxies sit in front.
- **CORS.** Only exact origins from `CLIENT_ORIGIN` (required in production, `*` rejected) for REST and Socket.IO.
- **Cold starts.** The create page pings `/api/health` immediately to start waking the server while the host types; both pages show the waking banner after 3.5 s and carry on by themselves. Socket.IO reconnects with back-off and the client re-joins with its voter id, so state is restored.
- **Accessibility.** Native radios/checkboxes/labels, live regions for status, no colour-only signals (text badges for leader/tie), ≥44 px targets, visible focus, reduced-motion support. axe runs in jsdom (structure) and in real Chrome in all three themes (including colour contrast).

## Known limits

- **One vote per browser is a deterrent, not a lock.** The voter id is a random value in `localStorage`; clearing storage, a private window or another browser/device gives a new identity, and a script can mint ids (rate limits and the 500-voter cap bound the damage). There are no accounts by design.
- **Memory unless `DATABASE_URL` is set.** Without it a server restart (or Render free-tier spin-down after ~15 min idle) **loses all polls**. With it, polls, votes and hashed host tokens survive restarts and sleeps.
- **Single instance.** Rate limits and sockets are per process; horizontal scaling needs a shared store and the Socket.IO Redis adapter.
- Anyone with the share link can vote and (if enabled) add an option; anyone with the host link controls the poll. There is no way to rotate a leaked host link.
- Closing time: the closed state is pushed within ~1 s of the deadline; the countdown corrects for the device clock using the server's time, but it is only as exact as the network round trip.
- Free-tier cold start can exceed 30 s; a poll can't be created while the server is asleep until it wakes.

## Persistence (optional, free, no card)

Set `DATABASE_URL` to a Postgres connection string and the server stores polls there; leave it unset and it falls back to memory. Recommended: **Neon Postgres, Free plan** (no time limit, no credit card; Render's own free Postgres is deleted after 30 days).

1. Sign up at <https://console.neon.tech/signup> (email, or "Continue with GitHub"/Google; no card asked).
2. Create a project (pick a region near your Render region, e.g. AWS Frankfurt for Render Frankfurt). The default database `neondb` is fine.
3. Click **Connect**, keep "Connection pooling" on, copy the connection string (`postgresql://…-pooler….neon.tech/neondb?sslmode=require…`).
4. Put it in Render → service → Environment as `DATABASE_URL` (the Blueprint declares it with `sync: false`, so Render prompts for it). For local use put it in an untracked `server/.env`-style environment, never in git.

The server creates its table (`livevote_polls`) on first start; no migration step. If the URL is wrong the server exits at startup with the error code only (the URL is never printed). Free-plan limits (Neon, Oct 2026): 100 CU-hours compute/month per project (compute sleeps after 5 min idle and resumes in a few hundred ms), 1 GB storage, 5 GB egress/month; polls are a few KB each, and the server keeps ≤5000 and deletes polls after 7 days (swept hourly, and ignored on read the moment they expire).

Tests: `npm test` runs the store contract suite against memory and pg-mem. To also run it (including the true concurrency cases) against a real Postgres: `TEST_DATABASE_URL=postgresql://… npm test` (creates and drops its own `lvtest_*` table).

## Deploy prep (nothing is deployed)

- **Client → GitHub Pages:** `docs/github-pages.workflow.yml` (kept in `docs/` because the gh token has no `workflow` scope; move it to `.github/workflows/pages.yml` to enable). Set repo variable `SERVER_URL`. Note: Pages on a *private* repo needs a paid plan.
- **Server → Render (free web service):** `render.yaml` blueprint. Set `CLIENT_ORIGIN` to the Pages origin (e.g. `https://ali1129js.github.io`) and `DATABASE_URL` (see *Persistence*). No Render service has been created.
- Build-time client config: `VITE_SERVER_URL`, `VITE_BASE` (e.g. `/livevote/`).

## Layout

```
client/   Vite + React app (components, hooks, themes)
server/   Express + Socket.IO (PollService, PollStore, rate limiting)
shared/   Types, limits, validation, normalisation, tally
e2e/      Playwright specs (walkthrough, ties, waking, reconnect, host powers) + helpers
docs/     Pages workflow, screenshots
```

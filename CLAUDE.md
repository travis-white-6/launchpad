# Launchpad — Claude context

## What this project is

A personal job-search assistant. Users fill in a candidate profile (roles, skills, location, notes) and a list of recipient emails. Claude (claude-sonnet-4-6 with `web_search`) searches live job boards and emails a daily digest via Mailgun. Everything runs on Netlify — static frontend, serverless functions, Netlify Blobs for storage, and a scheduled function for the daily cron.

## Stack at a glance

- **Frontend**: Vanilla TypeScript (`src/main.ts`) compiled by esbuild → `dist/main.js`. No framework.
- **Backend**: Netlify Functions (TypeScript, each file = one serverless function).
- **Storage**: Netlify Blobs — store name `launchpad`, two keys: `candidate-profile` and `run-history`.
- **AI**: Anthropic API, model `claude-sonnet-4-6`, tool `web_search_20250305`.
- **Email**: Mailgun REST API. Sender is `noreply@<MAILGUN_DOMAIN>`. All sends also CC `travis.lee.white.6@gmail.com`.
- **Scheduling**: Netlify scheduled function — `daily-run.ts` exports `config: { schedule: '0 9 * * *' }` (9:00 AM UTC daily).

## File map

```
index.html                  Single HTML file — app shell + all CSS (no external stylesheet)
src/main.ts                 All frontend logic — form, tag inputs, background run + polling, results rendering, schedule panel
netlify/functions/
  run-background.ts         POST /api/run-background — BACKGROUND FUNCTION: Anthropic loop (10 turns), email, writes run-result:<id> to Blobs
  run-status.ts             GET /api/run-status?id=<runId> — reads run-result:<id> from Blobs; returns result or {status:'pending'}
  proxy.ts                  POST /api/proxy — legacy synchronous proxy (deprecated, no longer called by frontend)
  profile.ts                GET/POST /api/profile — candidate profile in Netlify Blobs
  runs.ts                   GET/POST/DELETE /api/runs — run history (up to 100 records)
  send-email.ts             POST /api/send-email — Mailgun send (still used by daily-run.ts)
  check-urls.ts             POST /api/check-urls — HEAD-checks job URLs, classifies as ok/dead/blocked/error
  daily-run.ts              Netlify scheduled function — reads profile, calls Anthropic, sends email
build.mjs                   esbuild script: src/main.ts → dist/main.js (IIFE, ES2020)
tsconfig.json               strict, ES2020, DOM + Node types, noEmit (esbuild handles emit)
netlify.toml                build command, /api/* redirect to /.netlify/functions/*
```

## Data model

### `candidate-profile` (Netlify Blobs)

```ts
interface SavedProfile {
  name?: string;
  title?: string;           // current job title
  experience?: string;      // "0–2 years" | "3–5 years" | "6–10 years" | "10+ years"
  location?: string;        // e.g. "Remote only" | "San Francisco, CA"
  jobtype?: string;         // "Full-time" | "Contract" | "Part-time" | "Any"
  notes?: string;           // free-text instructions for the agent
  roles?: string[];         // target role titles
  skills?: string[];        // key skills
  recipients?: string[];    // email addresses to send the daily digest to
  lastRun?: string;         // ISO timestamp of last successful run
  dailyEnabled?: boolean;   // must be true for daily-run.ts to fire; set by "Get daily email" button; off by default
  paused?: boolean;         // if true, daily-run skips entirely
  skipNext?: boolean;       // if true, daily-run skips once then clears this flag
}
```

### `run-result:<runId>` (Netlify Blobs)

Written by `run-background.ts`, read by `run-status.ts`. Exported as `RunResult` from `run-background.ts` and imported as `import type` in `main.ts`.

```ts
interface RunResult {
  status: 'pending' | 'success' | 'error';
  runId: string;
  startedAt: string;
  completedAt?: string;
  jobs?: JobMatch[];
  email_subject?: string;
  email_body?: string;
  emailSent?: boolean;
  error?: string;
}
```

### `run-history` (Netlify Blobs)

Array of `RunRecord` (newest first, capped at 100):
```ts
interface RunRecord {
  id: string;               // ISO timestamp used as unique ID
  timestamp: string;        // ISO timestamp
  type: 'manual' | 'scheduled';
  jobCount: number;
  status: 'success' | 'error';
  error?: string;
}
```

## Key behaviours to know

### Agent flow (manual run)
1. Browser awaits `saveProfile()` → POST `/api/profile` → Netlify Blobs.
2. Browser generates `runId = ISO timestamp + random suffix`, POSTs `{ runId }` to `/api/run-background`.
3. Netlify returns 202 immediately; `run-background.ts` runs asynchronously (up to 15 min on paid plan).
4. `run-background.ts` writes `{ status: 'pending' }` to Blobs, reads profile, runs Anthropic loop (10 turns max), sends email, writes `{ status: 'success', jobs, ... }` or `{ status: 'error' }` to `run-result:<runId>`.
5. Browser polls `/api/run-status?id=<runId>` every 5s (up to 10 min timeout).
6. On success, `renderResults()` renders job cards, stats, email preview, refreshes run history.
7. Job URLs are verified via `/api/check-urls` after rendering — known bot-blockers short-circuited immediately.
8. There is no client-side fallback — if the background function fails, an error state is shown.

> Requires a paid Netlify plan. Background functions are not available on the free tier.

### Daily scheduled run (`daily-run.ts`)
- Skips if no profile, `!dailyEnabled`, no recipients, `paused: true`, or `skipNext: true`. The `dailyEnabled` check means daily emails are opt-in — users must click "Get daily email" in the UI.
- If `skipNext: true`, it clears the flag before returning so the next day runs normally.
- Has its own Anthropic tool-use loop (up to 5 turns, simpler than proxy).
- Appends a `RunRecord` with `type: 'scheduled'` whether it succeeds or fails.

### Schedule & Recipients panel
- Reads `/api/profile` on load independently of the sidebar form.
- Each recipient chip has an × button — clicking it removes that address, saves to Blobs, and syncs the sidebar tag input.
- "Next run" time is computed from 9:00 AM UTC, converted to the browser's local timezone.
- Pause/resume and skip-next write directly to the profile via POST `/api/profile`.

### Proxy (deprecated)
`proxy.ts` is kept but no longer called by the frontend. It was the original synchronous Anthropic proxy with origin allow-list, rate limiting, and an 8-turn tool-use loop. Safe to delete once confirmed unused.

## Environment variables (set in Netlify)

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `MAILGUN_API_KEY` | Mailgun private API key |
| `MAILGUN_DOMAIN` | Mailgun sending domain |

## Build & dev

```bash
npm run build    # esbuild: src/main.ts → dist/main.js
netlify dev      # local dev at http://localhost:8888 (functions + blob emulation)
```

`dist/main.js` is committed — the Netlify build runs `npm run build` and publishes `.` (root).

## Conventions

- All CSS lives in `index.html` in a single `<style>` block. No external stylesheet.
- CSS variables are defined on `:root` — use them for all colours (`--accent`, `--green`, `--red`, `--muted`, etc.).
- The frontend has no framework and no build-time HTML templating — DOM is built with `document.createElement`.
- Functions use native `fetch` — no SDK wrappers. Anthropic requests go to `https://api.anthropic.com/v1/messages` with `anthropic-version: 2023-06-01`.
- TypeScript is strict throughout. Prefer explicit types over `any`. `unknown` + type assertions are fine at API boundaries.
- Do not add a separate CSS file, a bundler config beyond `build.mjs`, or a frontend framework without discussing first.

# Launchpad

A web app that uses Claude to search the web for open job listings matching a candidate's profile, then emails a daily digest to configured recipients via Mailgun.

## What it does

1. User fills in a candidate profile (name, title, experience, target roles, skills, location preference, notes) and a list of recipient email addresses.
2. **"Run agent now"** saves the profile and kicks off a background function immediately. The browser polls every 5 seconds; when the result is ready, job cards, stats, and an email preview are rendered.
3. **"Get daily email"** opts the user into the 9 AM UTC daily schedule by setting `dailyEnabled: true` on the profile. Daily emails are off by default — this button is a one-time opt-in. The button label updates to "✓ Daily email on" once enabled.
4. The background function runs the full Anthropic tool-use loop (claude-sonnet-4-6 with `web_search`, up to 10 turns, no timeout pressure), finds 4–8 ranked job matches, sends a Mailgun email digest, and writes the result to Blobs.
5. Job URLs are verified in the background — badges show whether each listing is confirmed open, may be closed, or is unverifiable (e.g. LinkedIn blocks server-side checks).
6. A "Schedule & Recipients" panel lists every active recipient (× to remove), shows schedule status in local timezone, and provides pause/skip controls (only shown when daily emails are enabled).

> **Note:** Background Functions require a paid Netlify plan. On the free tier the function will not run asynchronously and will hit the synchronous timeout.

## Tech stack

| Layer | Tool |
|---|---|
| Frontend | Vanilla TypeScript, compiled with esbuild to `dist/main.js` |
| Hosting | Netlify (static site + serverless + background functions) |
| Storage | Netlify Blobs (key-value, no database needed) |
| AI | Anthropic API — `claude-sonnet-4-6` with `web_search_20250305` tool |
| Email | Mailgun REST API |
| Scheduling | Netlify scheduled functions (cron) |

## Project structure

```
launchpad/
├── index.html                    # Single-page app shell + all CSS
├── src/
│   └── main.ts                   # Frontend TypeScript — form, tag inputs, polling, results rendering, schedule panel
├── netlify/
│   └── functions/
│       ├── run-background.ts     # POST /api/run-background — background function: Anthropic loop, email, saves result to Blobs
│       ├── run-status.ts         # GET /api/run-status?id=<runId> — returns run result from Blobs (or {status:'pending'})
│       ├── proxy.ts              # POST /api/proxy — legacy synchronous proxy (deprecated for main run; kept for reference)
│       ├── profile.ts            # GET/POST /api/profile — reads/writes candidate profile in Netlify Blobs
│       ├── runs.ts               # GET/POST/DELETE /api/runs — run history in Netlify Blobs
│       ├── send-email.ts         # POST /api/send-email — sends via Mailgun
│       ├── check-urls.ts         # POST /api/check-urls — HEAD-checks job URLs, marks known bot-blockers
│       └── daily-run.ts          # Netlify scheduled function — runs at 9am UTC, reads profile, calls Claude, sends email
├── build.mjs                     # esbuild script (src/main.ts → dist/main.js)
├── tsconfig.json                 # TypeScript config (strict, ES2020, DOM + Node types)
└── netlify.toml                  # Build config, redirects /api/* → /.netlify/functions/*
```

## Manual run flow

```
Browser                         Netlify                         Blobs
  │                                │                              │
  │── POST /api/profile ──────────>│                              │
  │                                │── setJSON candidate-profile ─>│
  │<── 200 ────────────────────────│                              │
  │                                │                              │
  │── POST /api/run-background ───>│ (202 returned immediately)   │
  │<── 202 ────────────────────────│                              │
  │                                │── setJSON run-result:<id> ──>│ {status:'pending'}
  │   [polls every 5s]            │   [callAnthropic, 10 turns]  │
  │── GET /api/run-status?id ─────>│── get run-result:<id> ──────>│
  │<── {status:'pending'} ─────────│<─────────────────────────────│
  │   ...                         │── sendEmail via Mailgun       │
  │── GET /api/run-status?id ─────>│── setJSON run-result:<id> ──>│ {status:'success', jobs:[...]}
  │<── {status:'success', jobs} ───│                              │
  │   [renders results]           │                              │
```

## Netlify Blobs storage

All persistent state lives in the `launchpad` Blobs store:

| Key | Value | Written by |
|---|---|---|
| `candidate-profile` | `SavedProfile` JSON — name, roles, skills, recipients, `paused`, `skipNext`, `lastRun` | `profile.ts`, `run-background.ts`, `daily-run.ts` |
| `run-history` | Array of `RunRecord` (up to 100, newest first) | `runs.ts`, `run-background.ts`, `daily-run.ts` |
| `run-result:<runId>` | `RunResult` — status, jobs, email info, error | `run-background.ts` |

## Schedule management

The daily cron (`0 9 * * *`) respects two flags stored in the profile:

- **`paused: true`** — all future runs are skipped until the user resumes via the UI.
- **`skipNext: true`** — the next single run is skipped. `daily-run.ts` clears the flag after consuming it so the following day runs normally.

Both are toggled from the "Schedule & Recipients" panel on the main page.

## URL verification

After jobs are rendered, `check-urls.ts` HEAD-checks each URL in parallel (6s timeout). Known bot-blocking domains (LinkedIn, Glassdoor, Indeed) are marked "unverifiable" immediately without making a request. Results are shown as inline badges on each job card.

## Environment variables

Set these in Netlify → Site settings → Environment variables:

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `MAILGUN_API_KEY` | Mailgun private API key |
| `MAILGUN_DOMAIN` | Mailgun sending domain (e.g. `mail.yourdomain.com`) |

## Local development

```bash
npm install
npm run build       # compiles src/main.ts → dist/main.js
netlify dev         # runs functions locally at http://localhost:8888
```

Background functions behave synchronously in `netlify dev` — the 202 is not returned immediately, but the function runs and the result is written to Blobs as expected. Polling still works.

## Deployment

Push to the connected Git repo — Netlify runs `npm run build` and deploys automatically. Background functions and the scheduled function are both picked up automatically.

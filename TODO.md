# Launchpad — TODO

## What works today
- On-demand job search: clicking "Run agent now" sends the candidate profile to Claude, which searches the web (via `web_search_20250305`) for real open positions and returns match scores
- Proxy function (`netlify/functions/proxy.ts`) rate-limits requests and forwards to the Anthropic API
- Results are rendered in the UI with match scores, tags, and job links
- Job URL verification: each card shows a live badge (✓ Verified / ~ Unverifiable / ✗ May be closed) via server-side HEAD checks (`netlify/functions/check-urls.ts`). System prompt also instructs Claude to only return URLs confirmed via web search.
- Candidate profile is persisted server-side via Netlify Blobs and restored on page load (`netlify/functions/profile.ts`)
- Job digest email is sent to `celestemricci@gmail.com` via Mailgun after each run (`netlify/functions/send-email.ts`)
- Scheduled daily run fires at 9am UTC (`netlify/functions/daily-run.ts`), reads the saved profile, and sends the digest email automatically
- Rate limit alerts are emailed to `me@traviswhite.dev` via Mailgun when a 429 is triggered

## What's still pending

### 1. ~~Mailgun setup~~ ✅ Done
Mailgun account created, sending domain configured, DNS records added to `traviswhite.dev`, and `MAILGUN_API_KEY` + `MAILGUN_DOMAIN` set in Netlify.

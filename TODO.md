# Launchpad — TODO

## What works today
- On-demand job search: clicking "Run agent now" sends the candidate profile to Claude, which searches the web (via `web_search_20250305`) for real open positions and returns match scores
- Proxy function (`netlify/functions/proxy.ts`) rate-limits requests and forwards to the Anthropic API
- Results are rendered in the UI with match scores, tags, and job links
- Candidate profile is persisted server-side via Netlify Blobs and restored on page load
- Job digest email is sent to `celestemricci@gmail.com` via Mailgun after each run (`netlify/functions/send-email.ts`)
- Scheduled daily run fires at 9am UTC (`netlify/functions/daily-run.ts`), reads the saved profile, and sends the digest email automatically
- Rate limit alerts are emailed to `me@traviswhite.dev` via Mailgun when a 429 is triggered

## What's still pending

### 1. Mailgun setup (blocks email + rate limit alerts)
All email functionality is implemented in code but won't work until Mailgun is live:
- [ ] Create a Mailgun account and get a real API key
- [ ] Add a sending domain in Mailgun (e.g. `mg.traviswhite.dev`)
- [ ] Add the Mailgun DNS records to `traviswhite.dev` (Mailgun provides the exact TXT/MX/CNAME records after you set up the domain)
- [ ] Add `MAILGUN_API_KEY` and `MAILGUN_DOMAIN` as environment variables in Netlify

### 2. Job URL reliability
Claude may occasionally hallucinate job URLs or return listings that have since closed. Possible mitigations:
- Add a link-check step that validates URLs before rendering
- Show a caveat on each card so users know to verify before applying

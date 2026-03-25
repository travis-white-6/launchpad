# Launchpad — TODO

## What works today
- On-demand job search: clicking "Run agent now" sends the candidate profile to Claude, which searches the web (via `web_search_20250305`) for real open positions and returns match scores
- Proxy function rate-limits requests and forwards to the Anthropic API
- Results are rendered in the UI with match scores, tags, and job links

## What's missing

### 1. Scheduled daily runs
The UI says "runs daily" and "next run: tomorrow" but nothing actually triggers automatically. To make this real:
- Add a [Netlify scheduled function](https://docs.netlify.com/functions/scheduled-functions/) (cron syntax in the function config)
- The scheduled function would run the same agent logic server-side on a daily cadence
- Candidate profile/preferences would need to be stored somewhere (see #3)

### 2. Real email delivery
The email preview renders in the UI but is never sent. The `celestemricci@gmail.com` address is hardcoded in `src/main.ts`. To make this real:
- Integrate an email service — [Resend](https://resend.com) or SendGrid are good fits for Netlify functions
- The recipient address should come from a form field or stored profile (see #3)
- Wire the composed `email_body` and `email_subject` from the Claude response into the send call

### 3. Persistent candidate profile
Currently the form resets on every page load — there's no storage. Options:
- `localStorage` for a simple single-user setup
- A database (Netlify's built-in key-value store, Supabase, etc.) if you want multi-user or server-side scheduled runs to access the profile

### 5. ~~Rate limit alert email~~ ✅ Done
Implemented in `netlify/functions/proxy.ts`. Fires a Mailgun email to `me@traviswhite.dev` when a 429 is returned. Requires `MAILGUN_API_KEY` and `MAILGUN_DOMAIN` set as environment variables in Netlify.

**Action items before this is live:**
- [ ] Create a Mailgun account and get a real API key
- [ ] Add a sending domain in Mailgun (e.g. `mg.traviswhite.dev`)
- [ ] Add the Mailgun-required DNS records to `traviswhite.dev` (Mailgun will provide the exact TXT/MX/CNAME records to add after you set up the domain)
- [ ] Add `MAILGUN_API_KEY` and `MAILGUN_DOMAIN` as environment variables in Netlify

### 6. Job URL reliability
Claude may occasionally hallucinate job URLs or return listings that have since closed. Possible mitigations:
- Add a link-check step that validates URLs before rendering
- Show a "posted X days ago" caveat so users know to verify before applying

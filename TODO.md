# TODO

## ~~Migrate manual run to Netlify Background Functions~~ ✓ Done

**Completed.** The manual "Run agent now" flow now uses a background function:

- `netlify/functions/run-background.ts` — background function (named with `-background` suffix). Browser POSTs `{ runId }`, Netlify returns 202 immediately, function runs the full Anthropic tool-use loop (up to 10 turns, no timeout), sends email, writes result to Blobs under `run-result:<runId>`.
- `netlify/functions/run-status.ts` — GET `/api/run-status?id=<runId>`, returns the run result from Blobs or `{ status: 'pending' }`.
- `src/main.ts` — generates runId in browser, triggers background function, polls every 5s with elapsed timer, renders results on completion.
- Agent log UI removed. Results panel shows a pulsing "running" state during the run.
- `proxy.ts` is kept but no longer used for the main run path.

> **Requires a paid Netlify plan** — Background Functions are not available on the free tier.

## Remaining / future work

- **Remove `proxy.ts`** — it's dead code now that `run-background.ts` handles the Anthropic call directly. Safe to delete once confirmed no other callers.
- **Prune old `run-result:*` Blobs** — results accumulate indefinitely. Add a cleanup step (e.g. in `run-background.ts` after writing, delete results older than 7 days).
- **Netlify dev UX** — background functions run synchronously in `netlify dev`, so the 202 isn't returned immediately. The polling still works, but the button stays in "Running…" state until the function returns. No fix needed for prod, but worth noting for local testing.

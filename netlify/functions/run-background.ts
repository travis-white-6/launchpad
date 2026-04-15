// Netlify Background Function — named with -background suffix so Netlify treats it
// as async (returns 202 immediately, function continues running up to 15 minutes).
// The browser generates a runId, sends it here, then polls /api/run-status for results.

import { getStore } from '@netlify/blobs';
import { appendRun } from './runs.js';
import { ALLOWED_ORIGINS, ANTHROPIC_API_KEY, MAILGUN_API_KEY, MAILGUN_DOMAIN, tryParseJson } from './_config.js';

// --- In-memory rate limit (resets when function instance recycles) ---
interface RateLimitRecord { windowStart: number; count: number; }
const rateLimitStore = new Map<string, RateLimitRecord>();
const RATE_LIMIT = { windowMs: 60_000, maxRequests: 5 } as const;

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const rec = rateLimitStore.get(ip);
  if (!rec || now > rec.windowStart + RATE_LIMIT.windowMs) {
    rateLimitStore.set(ip, { windowStart: now, count: 1 });
    return true;
  }
  rec.count++;
  return rec.count <= RATE_LIMIT.maxRequests;
}

// runId must match the format the browser generates: ISO timestamp + dash + alphanumeric suffix
const VALID_RUN_ID = /^[\w:.+-]{10,100}$/;

interface SavedProfile {
  name?: string;
  title?: string;
  experience?: string;
  location?: string;
  jobtype?: string;
  notes?: string;
  roles?: string[];
  skills?: string[];
  recipients?: string[];
  lastRun?: string;
  dailyEnabled?: boolean;
  paused?: boolean;
  skipNext?: boolean;
}

interface AnthropicContent {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

interface AnthropicResponse {
  content?: AnthropicContent[];
  stop_reason?: string;
}

export interface JobMatch {
  title: string;
  company: string;
  location: string;
  type: string;
  match_score: number;
  is_new: boolean;
  skills_matched: string[];
  url?: string;
  reason?: string;
}

interface AgentResponse {
  jobs: JobMatch[];
  email_subject?: string;
  email_body?: string;
}

export interface RunResult {
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

async function callAnthropic(profile: SavedProfile): Promise<AgentResponse> {
  const apiKey = ANTHROPIC_API_KEY();

  const profileDesc = [
    profile.name ? `Name: ${profile.name}` : '',
    profile.title ? `Current role: ${profile.title}` : '',
    profile.experience ? `Experience: ${profile.experience}` : '',
    profile.roles?.length ? `Target roles: ${profile.roles.join(', ')}` : '',
    profile.skills?.length ? `Skills: ${profile.skills.join(', ')}` : '',
    profile.location ? `Location preference: ${profile.location}` : '',
    profile.jobtype ? `Job type: ${profile.jobtype}` : '',
    profile.notes ? `Additional notes: ${profile.notes}` : '',
  ].filter(Boolean).join('\n');

  const systemPrompt = `You are a job sourcing agent. Given a candidate profile, search the web for currently open job listings and identify the most relevant opportunities. Return ONLY a valid JSON object with NO markdown, NO backticks, and NO extra text.

The JSON must follow this exact structure:
{
  "jobs": [
    {
      "title": "Job title",
      "company": "Company name",
      "location": "City, State or Remote",
      "type": "Full-time / Contract / etc",
      "match_score": 92,
      "is_new": true,
      "skills_matched": ["skill1", "skill2"],
      "url": "https://example.com/jobs/123",
      "reason": "One sentence why this is a great fit"
    }
  ],
  "email_subject": "unused — will be overridden server-side",
  "email_body": "A friendly daily email digest listing each job with its title, company, and direct application URL on its own line. Written to the candidate by name if provided. Plain text, no HTML, under 200 words. Do not use language like 'this week' or 'weekly' — this is a daily digest."
}

Return 4–8 jobs. Use real company names and real job boards. Mark 2–3 as is_new: true. Order by match_score descending.

IMPORTANT recency rules — a stale listing is worse than no listing:
- Only include jobs posted within the last 30 days. Check the posting date shown in search results before including any job.
- When searching, use date-limiting terms such as "posted this week", "last 30 days", or the job board's built-in recency filters.
- If a search snippet does not show a posting date, search again specifically for that role at that company to confirm it is currently open.
- Discard any listing where the posting date is older than 30 days or cannot be confirmed.
- Before finalising each URL, check that the search result does not contain phrases like "this job has been removed", "position filled", or "no longer available". If any such signal is present, skip that listing.

IMPORTANT URL rules:
- Every job MUST include a url field — use web search to find the direct application link for each listing.
- The URL must link to the specific job posting, not a generic careers listing page. A valid URL will contain a job-specific identifier such as a query parameter (e.g. ?gh_jid=1234567, ?lever-origin=applied, ?jobId=12345) or a path segment that uniquely identifies the role (e.g. /jobs/senior-engineer-12345). A URL that ends at the careers index (e.g. /careers or /careers-list/ with no job ID) is NOT acceptable.
- Prefer Greenhouse, Lever, Workday, or the company's own ATS over aggregators like LinkedIn or Indeed.
- Only include URLs you confirmed via web search — do not construct or guess URLs.
- If you cannot find the specific job posting URL (with a job ID), use the company's generic careers page URL as a last resort — it is better than nothing.
- The url field is REQUIRED — do not omit it.`;

  const userMsg = `Search for currently open job listings for this candidate and draft a digest email:\n\n${profileDesc}`;

  type Message = { role: 'user' | 'assistant'; content: string | AnthropicContent[] };
  const messages: Message[] = [{ role: 'user', content: userMsg }];
  let raw: AnthropicResponse = {};

  // No turn cap — background function can run for up to 15 minutes
  for (let turn = 0; turn < 10; turn++) {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        system: systemPrompt,
        messages,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      }),
    });

    if (!resp.ok) {
      const detail = await resp.text();
      throw new Error(`Anthropic error ${resp.status}: ${detail}`);
    }

    raw = await resp.json() as AnthropicResponse;
    if (raw.stop_reason !== 'tool_use') break;

    const searches = (raw.content ?? []).filter(b => b.type === 'tool_use');
    messages.push({ role: 'assistant', content: raw.content ?? [] });
    messages.push({
      role: 'user',
      content: searches.map(b => ({ type: 'tool_result', tool_use_id: b.id, content: [] })),
    });
  }

  const textBlock = raw.content?.find(b => b.type === 'text');
  if (!textBlock?.text) throw new Error('No text block in Anthropic response');

  // Try to parse JSON — if Claude wrapped its answer in prose, extract the object.
  // If that still fails, send a correction turn and try once more.
  const parsed = tryParseJson<AgentResponse>(textBlock.text);
  if (parsed) return parsed;

  console.warn('[callAnthropic] Response was not valid JSON — sending correction turn');
  messages.push({ role: 'assistant', content: raw.content ?? [] });
  messages.push({
    role: 'user',
    content: 'Your response was not valid JSON. Output ONLY the JSON object described in the system prompt — no prose, no explanation, no markdown.',
  });

  const correctionResp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: systemPrompt,
      messages,
    }),
  });

  if (!correctionResp.ok) {
    const detail = await correctionResp.text();
    throw new Error(`Anthropic correction error ${correctionResp.status}: ${detail}`);
  }

  const correctionRaw = await correctionResp.json() as AnthropicResponse;
  const correctionText = correctionRaw.content?.find(b => b.type === 'text')?.text ?? '';
  const corrected = tryParseJson<AgentResponse>(correctionText);
  if (corrected) return corrected;

  throw new Error(`Response is not valid JSON after correction. Preview: ${textBlock.text.slice(0, 120)}`);
}

async function sendEmail(to: string, subject: string, text: string): Promise<void> {
  const apiKey = MAILGUN_API_KEY();
  const domain = MAILGUN_DOMAIN();

  const credentials = Buffer.from(`api:${apiKey}`).toString('base64');
  const body = new URLSearchParams({
    from: `Launchpad <noreply@${domain}>`,
    to,
    cc: 'travis.lee.white.6@gmail.com',
    subject,
    text,
  });

  const resp = await fetch(`https://api.mailgun.net/v3/${domain}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  if (!resp.ok) {
    const detail = await resp.text();
    throw new Error(`Mailgun error ${resp.status}: ${detail}`);
  }
}

export default async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const origin = req.headers.get('origin') ?? '';
  if (ALLOWED_ORIGINS.length > 0 && !ALLOWED_ORIGINS.includes(origin)) {
    return new Response('Forbidden', { status: 403 });
  }

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim()
    ?? req.headers.get('x-nf-client-connection-ip')
    ?? 'unknown';
  if (!checkRateLimit(ip)) {
    return new Response('Rate limit exceeded — try again in a minute.', { status: 429 });
  }

  let runId: string;
  try {
    const body = await req.json() as { runId?: string };
    if (!body.runId) throw new Error('Missing runId');
    runId = body.runId;
  } catch {
    return new Response('Invalid body — expected { runId: string }', { status: 400 });
  }

  if (!VALID_RUN_ID.test(runId)) {
    return new Response('Invalid runId format', { status: 400 });
  }

  const store = getStore('launchpad');
  const startedAt = new Date().toISOString();

  await store.setJSON(`run-result:${runId}`, { status: 'pending', runId, startedAt } satisfies RunResult);

  const profile = await store.get('candidate-profile', { type: 'json' }) as SavedProfile | null;

  if (!profile || (!profile.title && !profile.roles?.length)) {
    await store.setJSON(`run-result:${runId}`, {
      status: 'error', runId, startedAt,
      completedAt: new Date().toISOString(),
      error: 'No profile configured — fill in your profile first.',
    } satisfies RunResult);
    return Response.json({ ok: false });
  }

  if (!profile.recipients?.length) {
    await store.setJSON(`run-result:${runId}`, {
      status: 'error', runId, startedAt,
      completedAt: new Date().toISOString(),
      error: 'No recipients configured — add at least one email address.',
    } satisfies RunResult);
    return Response.json({ ok: false });
  }

  try {
    console.log(`[run:${runId}] Starting — profile: ${profile.name ?? 'anonymous'}, roles: ${(profile.roles ?? [profile.title ?? '']).join(', ')}`);

    const data = await callAnthropic(profile);
    console.log(`[run:${runId}] Got ${data.jobs.length} jobs`);

    const jobCount = data.jobs.length;
    const subject = `${jobCount} job match${jobCount !== 1 ? 'es' : ''} for you today`;

    let emailSent = false;
    if (data.email_body) {
      const toList = profile.recipients.join(', ');
      try {
        await sendEmail(toList, subject, data.email_body);
        emailSent = true;
        console.log(`[run:${runId}] Email sent to ${toList}`);
      } catch (emailErr) {
        console.error(`[run:${runId}] Email failed: ${(emailErr as Error).message}`);
      }
    } else {
      console.warn(`[run:${runId}] No email_body in response — email skipped`);
    }

    const completedAt = new Date().toISOString();

    await store.setJSON(`run-result:${runId}`, {
      status: 'success', runId, startedAt, completedAt,
      jobs: data.jobs,
      email_subject: subject,
      email_body: data.email_body,
      emailSent,
    } satisfies RunResult);

    await appendRun({ id: runId, timestamp: startedAt, type: 'manual', jobCount: data.jobs.length, status: 'success' });
    await store.setJSON('candidate-profile', { ...profile, lastRun: completedAt });

    console.log(`[run:${runId}] Done — ${data.jobs.length} jobs, emailSent: ${emailSent}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[run:${runId}] Failed: ${message}`);

    await store.setJSON(`run-result:${runId}`, {
      status: 'error', runId, startedAt,
      completedAt: new Date().toISOString(),
      error: message,
    } satisfies RunResult);

    await appendRun({ id: runId, timestamp: startedAt, type: 'manual', jobCount: 0, status: 'error', error: message });
  }

  return Response.json({ ok: true });
};

export const config = { path: '/api/run-background' };

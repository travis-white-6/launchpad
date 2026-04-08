// Netlify Background Function — named with -background suffix so Netlify treats it
// as async (returns 202 immediately, function continues running up to 15 minutes).
// The browser generates a runId, sends it here, then polls /api/run-status for results.

import { getStore } from '@netlify/blobs';
import { appendRun } from './runs.js';

// --- Origin allow-list ---
const ALLOWED_ORIGINS: string[] = [
  'https://curious-profiterole-6c8c76.netlify.app',
  ...(process.env.NETLIFY_DEV === 'true' ? ['http://localhost:8888'] : []),
];

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
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

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
  "email_subject": "Subject line for the daily digest email",
  "email_body": "A friendly 150-word email digest summarizing the top matches, written to the candidate by name if provided. Use plain text, no HTML."
}

Return 4–8 jobs. Use real company names and real job boards. Mark 2–3 as is_new: true. Order by match_score descending.

IMPORTANT URL rules:
- Only include a URL if you found it directly via web search and confirmed the listing is currently open.
- Prefer direct application URLs (Greenhouse, Lever, Workday, company careers page) over aggregator pages.
- Do not construct or guess URLs — only use URLs you have seen in search results.
- If you cannot confirm a URL, omit the url field entirely.`;

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

  const cleaned = textBlock.text.replace(/```json|```/g, '').trim();
  return JSON.parse(cleaned) as AgentResponse;
}

async function sendEmail(to: string, subject: string, text: string): Promise<void> {
  const apiKey = process.env.MAILGUN_API_KEY;
  const domain = process.env.MAILGUN_DOMAIN;
  if (!apiKey || !domain) throw new Error('Mailgun not configured');

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

  // Origin check
  const origin = req.headers.get('origin') ?? '';
  if (ALLOWED_ORIGINS.length > 0 && !ALLOWED_ORIGINS.includes(origin)) {
    return new Response('Forbidden', { status: 403 });
  }

  // Rate limit by IP
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

  // Sanitize runId before using it as a Blobs key
  if (!VALID_RUN_ID.test(runId)) {
    return new Response('Invalid runId format', { status: 400 });
  }

  const store = getStore('launchpad');
  const startedAt = new Date().toISOString();

  // Write pending state immediately so the poller gets a response on first poll
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

    let emailSent = false;
    if (data.email_body) {
      const toList = profile.recipients.join(', ');
      try {
        await sendEmail(toList, data.email_subject ?? 'Your daily job matches', data.email_body);
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
      status: 'success',
      runId,
      startedAt,
      completedAt,
      jobs: data.jobs,
      email_subject: data.email_subject,
      email_body: data.email_body,
      emailSent,
    } satisfies RunResult);

    await appendRun({ id: runId, timestamp: runId, type: 'manual', jobCount: data.jobs.length, status: 'success' });
    await store.setJSON('candidate-profile', { ...profile, lastRun: completedAt });

    console.log(`[run:${runId}] Done — ${data.jobs.length} jobs, emailSent: ${emailSent}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[run:${runId}] Failed: ${message}`);

    await store.setJSON(`run-result:${runId}`, {
      status: 'error',
      runId,
      startedAt,
      completedAt: new Date().toISOString(),
      error: message,
    } satisfies RunResult);

    await appendRun({ id: runId, timestamp: runId, type: 'manual', jobCount: 0, status: 'error', error: message });
  }

  return Response.json({ ok: true });
};

export const config = { path: '/api/run-background' };

// In-memory rate limit store (resets when function instance recycles, ~few minutes)
// For production, replace with Netlify KV or Upstash Redis

import { ALLOWED_ORIGINS, ANTHROPIC_API_KEY, MAILGUN_API_KEY, MAILGUN_DOMAIN } from './_config.js';

interface RateLimitRecord {
  windowStart: number;
  count: number;
}

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
}

interface AnthropicContentBlock {
  type: string;
  id?: string;
}

interface AnthropicApiResponse {
  content?: AnthropicContentBlock[];
  stop_reason?: string;
  status?: number;
}

const rateLimitStore = new Map<string, RateLimitRecord>();

const RATE_LIMIT = {
  windowMs: 60 * 1000,  // 1 minute window
  maxRequests: 5,        // max requests per IP per window
} as const;

function getRateLimit(ip: string): RateLimitResult {
  const now = Date.now();
  const record = rateLimitStore.get(ip);

  if (!record || now > record.windowStart + RATE_LIMIT.windowMs) {
    const newRecord: RateLimitRecord = { windowStart: now, count: 1 };
    rateLimitStore.set(ip, newRecord);
    return { allowed: true, remaining: RATE_LIMIT.maxRequests - 1 };
  }

  record.count++;
  const remaining = RATE_LIMIT.maxRequests - record.count;
  return { allowed: remaining >= 0, remaining: Math.max(0, remaining) };
}

async function sendRateLimitAlert(ip: string): Promise<void> {
  let apiKey: string, domain: string;
  try { apiKey = MAILGUN_API_KEY(); domain = MAILGUN_DOMAIN(); } catch { return; }

  const credentials = Buffer.from(`api:${apiKey}`).toString('base64');
  const body = new URLSearchParams({
    from: `Launchpad <noreply@${domain}>`,
    to: 'me@traviswhite.dev',
    subject: 'Launchpad — rate limit hit',
    text: `The rate limiter was triggered on the Launchpad proxy.\n\nIP: ${ip}\nTime: ${new Date().toISOString()}\n\nThis IP has exceeded 5 requests per minute.`,
  });

  await fetch(`https://api.mailgun.net/v3/${domain}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  }).catch(() => {});
}

function cleanupStore(): void {
  const now = Date.now();
  for (const [ip, record] of rateLimitStore.entries()) {
    if (now > record.windowStart + RATE_LIMIT.windowMs) {
      rateLimitStore.delete(ip);
    }
  }
}

async function callAnthropic(payload: Record<string, unknown>): Promise<Response> {
  return fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY(),
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(payload),
  });
}

export default async (req: Request): Promise<Response> => {
  // Only allow POST
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  // Origin check — block requests from unknown origins
  const origin = req.headers.get('origin');
  if (ALLOWED_ORIGINS.length > 0 && !ALLOWED_ORIGINS.includes(origin ?? '')) {
    return new Response('Forbidden: unknown origin', { status: 403 });
  }

  // Rate limiting by IP
  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0].trim() ??
    req.headers.get('x-nf-client-connection-ip') ??
    'unknown';

  cleanupStore();
  const { allowed, remaining } = getRateLimit(ip);

  if (!allowed) {
    void sendRateLimitAlert(ip);
    return new Response(
      JSON.stringify({ error: 'Rate limit exceeded. Please wait a minute and try again.' }),
      {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': '60',
          'X-RateLimit-Remaining': '0',
        },
      }
    );
  }

  // Validate request body
  let body: Record<string, unknown>;
  try {
    body = await req.json() as Record<string, unknown>;
  } catch {
    return new Response('Invalid JSON body', { status: 400 });
  }

  // Block oversized initial payloads (guard against prompt stuffing)
  if (JSON.stringify(body).length > 20_000) {
    return new Response('Request too large', { status: 413 });
  }

  // Run the tool-use loop server-side so the browser makes only one request.
  // Anthropic's web_search tool requires multi-turn: the model returns tool_use
  // blocks, we send back tool_result blocks, and repeat until stop_reason is
  // no longer 'tool_use'.
  type Message = { role: string; content: unknown };
  let messages = (body.messages as Message[]) ?? [];
  let apiResponse: AnthropicApiResponse = {};
  let lastStatus = 200;

  for (let turn = 0; turn < 8; turn++) {
    let anthropicResp: Response;
    try {
      anthropicResp = await callAnthropic({ ...body, messages });
    } catch {
      return new Response(
        JSON.stringify({ error: 'Failed to reach Anthropic API' }),
        { status: 502, headers: { 'Content-Type': 'application/json' } }
      );
    }

    lastStatus = anthropicResp.status;
    apiResponse = await anthropicResp.json() as AnthropicApiResponse;

    if (!anthropicResp.ok) {
      return new Response(JSON.stringify(apiResponse), {
        status: lastStatus,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (apiResponse.stop_reason !== 'tool_use') break;

    const content = apiResponse.content ?? [];
    const toolUses = content.filter(b => b.type === 'tool_use');

    messages = [
      ...messages,
      { role: 'assistant', content },
      {
        role: 'user',
        content: toolUses.map(b => ({
          type: 'tool_result',
          tool_use_id: b.id,
          content: [],
        })),
      },
    ];
  }

  return Response.json(apiResponse, {
    status: lastStatus,
    headers: {
      'X-RateLimit-Remaining': String(remaining),
    },
  });
};

export const config = { path: '/api/proxy' };

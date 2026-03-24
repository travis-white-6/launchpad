// In-memory rate limit store (resets when function instance recycles, ~few minutes)
// For production, replace with Netlify KV or Upstash Redis

interface RateLimitRecord {
  windowStart: number;
  count: number;
}

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
}

const rateLimitStore = new Map<string, RateLimitRecord>();

const RATE_LIMIT = {
  windowMs: 60 * 1000,  // 1 minute window
  maxRequests: 5,        // max requests per IP per window
} as const;

const ALLOWED_ORIGINS: string[] = [
  'https://curious-profiterole-6c8c76.netlify.app',
];

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

function cleanupStore(): void {
  const now = Date.now();
  for (const [ip, record] of rateLimitStore.entries()) {
    if (now > record.windowStart + RATE_LIMIT.windowMs) {
      rateLimitStore.delete(ip);
    }
  }
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

  // Validate request body exists
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response('Invalid JSON body', { status: 400 });
  }

  // Block oversized payloads (guard against prompt stuffing)
  const bodyStr = JSON.stringify(body);
  if (bodyStr.length > 20_000) {
    return new Response('Request too large', { status: 413 });
  }

  // Forward to Anthropic
  let response: Response;
  try {
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY ?? '',
        'anthropic-version': '2023-06-01',
      },
      body: bodyStr,
    });
  } catch {
    return new Response(
      JSON.stringify({ error: 'Failed to reach Anthropic API' }),
      { status: 502, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const data = await response.json();

  return Response.json(data, {
    status: response.status,
    headers: {
      'X-RateLimit-Remaining': String(remaining),
    },
  });
};

export const config = { path: '/api/proxy' };

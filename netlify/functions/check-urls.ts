// Job boards that actively block server-side requests — a non-200 from these
// does not mean the listing is dead, just that they block bots.
const BOT_BLOCKED_HOSTS = ['linkedin.com', 'glassdoor.com', 'indeed.com'];

type UrlStatus = 'ok' | 'blocked' | 'dead' | 'error';

function isKnownBlocker(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return BOT_BLOCKED_HOSTS.some(h => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

async function checkUrl(url: string): Promise<UrlStatus> {
  if (isKnownBlocker(url)) return 'blocked';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);

  try {
    const resp = await fetch(url, {
      method: 'HEAD',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      signal: controller.signal,
      redirect: 'follow',
    });

    if (resp.status === 404 || resp.status === 410) return 'dead';
    if (resp.status === 403 || resp.status === 429 || resp.status === 999) return 'blocked';
    if (resp.status >= 200 && resp.status < 400) return 'ok';
    return 'error';
  } catch {
    return 'error';
  } finally {
    clearTimeout(timer);
  }
}

export default async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  let payload: { urls: string[] };
  try {
    payload = await req.json() as { urls: string[] };
  } catch {
    return new Response('Invalid JSON body', { status: 400 });
  }

  const { urls } = payload;
  if (!Array.isArray(urls) || urls.length === 0) {
    return Response.json({ results: {} });
  }

  const results = Object.fromEntries(
    await Promise.all(urls.map(async url => [url, await checkUrl(url)]))
  );

  return Response.json({ results });
};

export const config = { path: '/api/check-urls' };

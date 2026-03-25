import { getStore } from '@netlify/blobs';

const STORE = 'launchpad';
const KEY = 'candidate-profile';

export default async (req: Request): Promise<Response> => {
  const store = getStore(STORE);

  if (req.method === 'GET') {
    const data = await store.get(KEY, { type: 'json' });
    return Response.json(data ?? {});
  }

  if (req.method === 'POST') {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return new Response('Invalid JSON body', { status: 400 });
    }
    await store.setJSON(KEY, body);
    return Response.json({ ok: true });
  }

  return new Response('Method not allowed', { status: 405 });
};

export const config = { path: '/api/profile' };

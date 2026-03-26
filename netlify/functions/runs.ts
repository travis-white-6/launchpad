import { getStore } from '@netlify/blobs';

export interface RunRecord {
  id: string;
  timestamp: string;
  type: 'manual' | 'scheduled';
  jobCount: number;
  status: 'success' | 'error';
  error?: string;
}

const STORE = 'launchpad';
const KEY = 'run-history';

export async function appendRun(run: RunRecord): Promise<void> {
  const store = getStore(STORE);
  const existing = (await store.get(KEY, { type: 'json' }) as RunRecord[] | null) ?? [];
  existing.unshift(run);
  await store.setJSON(KEY, existing.slice(0, 100)); // keep last 100
}

export default async (req: Request): Promise<Response> => {
  const store = getStore(STORE);

  if (req.method === 'GET') {
    const history = (await store.get(KEY, { type: 'json' }) as RunRecord[] | null) ?? [];
    return Response.json(history);
  }

  if (req.method === 'POST') {
    let run: RunRecord;
    try {
      run = await req.json() as RunRecord;
    } catch {
      return new Response('Invalid JSON body', { status: 400 });
    }
    await appendRun(run);
    return Response.json({ ok: true });
  }

  if (req.method === 'DELETE') {
    let payload: { id: string };
    try {
      payload = await req.json() as { id: string };
    } catch {
      return new Response('Invalid JSON body', { status: 400 });
    }
    const existing = (await store.get(KEY, { type: 'json' }) as RunRecord[] | null) ?? [];
    await store.setJSON(KEY, existing.filter(r => r.id !== payload.id));
    return Response.json({ ok: true });
  }

  return new Response('Method not allowed', { status: 405 });
};

export const config = { path: '/api/runs' };

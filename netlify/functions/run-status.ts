import { getStore } from '@netlify/blobs';
import type { RunResult } from './run-background.js';

export default async (req: Request): Promise<Response> => {
  if (req.method !== 'GET') {
    return new Response('Method not allowed', { status: 405 });
  }

  const url = new URL(req.url);
  const id = url.searchParams.get('id');
  if (!id || !/^[\w:.+-]{10,100}$/.test(id)) {
    return new Response('Missing or invalid id parameter', { status: 400 });
  }

  const store = getStore('launchpad');
  const result = await store.get(`run-result:${id}`, { type: 'json' }) as RunResult | null;

  if (!result) {
    return Response.json({ status: 'pending' });
  }

  return Response.json(result);
};

export const config = { path: '/api/run-status' };

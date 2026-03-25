async function sendViaMailgun(to: string, subject: string, text: string): Promise<void> {
  const apiKey = process.env.MAILGUN_API_KEY;
  const domain = process.env.MAILGUN_DOMAIN;
  if (!apiKey || !domain) throw new Error('Mailgun not configured (missing MAILGUN_API_KEY or MAILGUN_DOMAIN)');

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
    throw new Error(`Mailgun responded ${resp.status}: ${detail}`);
  }
}

export default async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  let payload: { to: string; subject: string; text: string };
  try {
    payload = await req.json() as { to: string; subject: string; text: string };
  } catch {
    return new Response('Invalid JSON body', { status: 400 });
  }

  const { to, subject, text } = payload;
  if (!to || !subject || !text) {
    return new Response('Missing required fields: to, subject, text', { status: 400 });
  }

  try {
    await sendViaMailgun(to, subject, text);
    return Response.json({ ok: true });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
};

export const config = { path: '/api/send-email' };

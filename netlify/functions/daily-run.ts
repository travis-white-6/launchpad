import { getStore } from '@netlify/blobs';
import { appendRun } from './runs.js';

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

interface AgentResponse {
  jobs: Array<{
    title: string;
    company: string;
    location: string;
    type: string;
    match_score: number;
    is_new: boolean;
    skills_matched: string[];
    url?: string;
    reason?: string;
  }>;
  email_subject?: string;
  email_body?: string;
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

  const systemPrompt = `You are a job sourcing agent. Given a candidate profile, you search for and identify the most relevant job opportunities. You return ONLY a valid JSON object with NO markdown, NO backticks, and NO extra text.

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

Return 4–8 jobs. Use realistic company names, realistic job boards (LinkedIn, Greenhouse, Lever, Workday), and realistic match scores (60–98). Mark 2–3 jobs as is_new: true. Order by match_score descending.`;

  const userMsg = `Find relevant job openings for this candidate and draft a notification email:\n\n${profileDesc}`;

  type Message = { role: 'user' | 'assistant'; content: string | AnthropicContent[] };
  const messages: Message[] = [{ role: 'user', content: userMsg }];
  let raw: AnthropicResponse = {};

  for (let turn = 0; turn < 5; turn++) {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1800,
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
  const body = new URLSearchParams({ from: `Launchpad <noreply@${domain}>`, to, cc: 'travis.lee.white.6@gmail.com', subject, text });

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

export default async (): Promise<Response> => {
  const store = getStore('launchpad');
  const profile = await store.get('candidate-profile', { type: 'json' }) as SavedProfile | null;

  if (!profile || (!profile.title && !profile.roles?.length)) {
    console.log('Daily run skipped: no profile saved yet.');
    return Response.json({ ok: true, skipped: true, reason: 'no-profile' });
  }

  if (!profile.dailyEnabled) {
    console.log('Daily run skipped: daily emails not enabled by user.');
    return Response.json({ ok: true, skipped: true, reason: 'not-enabled' });
  }

  if (!profile.recipients?.length) {
    console.log('Daily run skipped: no recipients configured.');
    return Response.json({ ok: true, skipped: true, reason: 'no-recipients' });
  }

  if (profile.paused) {
    console.log('Daily run skipped: schedule is paused.');
    return Response.json({ ok: true, skipped: true, reason: 'paused' });
  }

  if (profile.skipNext) {
    // Clear the flag so subsequent runs proceed normally
    await store.setJSON('candidate-profile', { ...profile, skipNext: false });
    console.log('Daily run skipped: skip-next flag was set.');
    return Response.json({ ok: true, skipped: true, reason: 'skip-next' });
  }

  const runId = new Date().toISOString();
  const toList = profile.recipients.join(', ');

  try {
    const data = await callAnthropic(profile);
    await sendEmail(
      toList,
      data.email_subject ?? 'Your daily job matches',
      data.email_body ?? '',
    );

    const jobCount = data.jobs?.length ?? 0;
    await appendRun({ id: runId, timestamp: runId, type: 'scheduled', jobCount, status: 'success' });

    console.log(`Daily run complete. Sent ${jobCount} jobs to ${toList}.`);
    return Response.json({ ok: true, jobs: jobCount });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('Daily run failed:', message);
    await appendRun({ id: runId, timestamp: runId, type: 'scheduled', jobCount: 0, status: 'error', error: message });
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
};

export const config = {
  schedule: '0 9 * * *', // 9am UTC daily
};

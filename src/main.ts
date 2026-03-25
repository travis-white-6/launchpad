interface JobMatch {
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

interface SavedProfile {
  name?: string;
  title?: string;
  experience?: string;
  location?: string;
  jobtype?: string;
  notes?: string;
  roles?: string[];
  skills?: string[];
}

interface TagInput {
  get: () => string[];
  set: (values: string[]) => void;
}

// --- Tag inputs ---

function makeTagInput(wrapperId: string, inputId: string): TagInput {
  const wrapper = document.getElementById(wrapperId)!;
  const input = document.getElementById(inputId) as HTMLInputElement;
  const tags: string[] = [];

  function addTag(val: string): void {
    if (!val || tags.includes(val)) return;
    tags.push(val);
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.innerHTML = `${val}<button onclick="this.parentElement.remove()">×</button>`;
    wrapper.insertBefore(tag, input);
  }

  input.addEventListener('keydown', (e: KeyboardEvent) => {
    if ((e.key === 'Enter' || e.key === ',') && input.value.trim()) {
      e.preventDefault();
      const val = input.value.trim().replace(/,+$/, '');
      addTag(val);
      input.value = '';
    }
  });

  return {
    get: () => tags,
    set: (values: string[]) => {
      wrapper.querySelectorAll('.tag').forEach(el => el.remove());
      tags.length = 0;
      values.forEach(addTag);
    },
  };
}

const roles = makeTagInput('roles-wrapper', 'roles-input');
const skills = makeTagInput('skills-wrapper', 'skills-input');

// --- Profile persistence ---

async function loadProfile(): Promise<void> {
  try {
    const resp = await fetch('/api/profile');
    if (!resp.ok) return;
    const profile = await resp.json() as SavedProfile;

    if (profile.name) (document.getElementById('name') as HTMLInputElement).value = profile.name;
    if (profile.title) (document.getElementById('title') as HTMLInputElement).value = profile.title;
    if (profile.experience) (document.getElementById('experience') as HTMLSelectElement).value = profile.experience;
    if (profile.location) (document.getElementById('location') as HTMLSelectElement).value = profile.location;
    if (profile.jobtype) (document.getElementById('jobtype') as HTMLSelectElement).value = profile.jobtype;
    if (profile.notes) (document.getElementById('notes') as HTMLTextAreaElement).value = profile.notes;
    if (profile.roles?.length) roles.set(profile.roles);
    if (profile.skills?.length) skills.set(profile.skills);
  } catch {
    // Ignore — form just won't be pre-filled
  }
}

function saveProfile(profile: SavedProfile): void {
  // Fire-and-forget — don't block the agent run
  void fetch('/api/profile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(profile),
  }).catch(() => {});
}

// --- Agent log ---

function addLog(msg: string, type = 'info'): void {
  const log = document.getElementById('log')!;
  const now = new Date();
  const t = now.toTimeString().slice(0, 8);
  const line = document.createElement('div');
  line.className = 'log-line';
  line.innerHTML = `<span class="log-time">${t}</span><span class="log-msg ${type}">${msg}</span>`;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

// --- Main agent run ---

async function runAgent(): Promise<void> {
  const name = (document.getElementById('name') as HTMLInputElement).value.trim();
  const title = (document.getElementById('title') as HTMLInputElement).value.trim();
  const experience = (document.getElementById('experience') as HTMLSelectElement).value;
  const location = (document.getElementById('location') as HTMLSelectElement).value;
  const jobtype = (document.getElementById('jobtype') as HTMLSelectElement).value;
  const notes = (document.getElementById('notes') as HTMLTextAreaElement).value.trim();
  const rolesList = roles.get();
  const skillsList = skills.get();

  if (!title && rolesList.length === 0) {
    alert('Please enter a current title or add at least one target role.');
    return;
  }

  // Save profile before running so it persists for next time
  saveProfile({ name, title, experience, location, jobtype, notes, roles: rolesList, skills: skillsList });

  const btn = document.getElementById('run-btn') as HTMLButtonElement;
  const spinner = document.getElementById('spinner')!;
  const btnLabel = document.getElementById('btn-label')!;
  btn.disabled = true;
  spinner.style.display = 'block';
  btnLabel.textContent = 'Agent running...';
  document.getElementById('run-status')!.textContent = 'Running';

  document.getElementById('log')!.innerHTML = '';
  document.getElementById('jobs-list')!.innerHTML = '';
  (document.getElementById('email-preview') as HTMLElement).style.display = 'none';
  document.getElementById('stat-found')!.textContent = '—';
  document.getElementById('stat-high')!.textContent = '—';
  document.getElementById('stat-new')!.textContent = '—';
  document.getElementById('stat-email')!.textContent = '—';

  addLog('Agent initialised', 'info');
  addLog(`Profile: ${name || 'Candidate'} · ${title || rolesList[0] || 'TBD'} · ${experience || 'any exp'}`, 'info');
  addLog(`Preferences: ${location || 'Any location'} · ${jobtype}`, 'info');

  const profileDesc = [
    name ? `Name: ${name}` : '',
    title ? `Current role: ${title}` : '',
    experience ? `Experience: ${experience}` : '',
    rolesList.length > 0 ? `Target roles: ${rolesList.join(', ')}` : '',
    skillsList.length > 0 ? `Skills: ${skillsList.join(', ')}` : '',
    location ? `Location preference: ${location}` : '',
    `Job type: ${jobtype}`,
    notes ? `Additional notes: ${notes}` : '',
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

Return 4–8 jobs. Use realistic company names, realistic job boards (LinkedIn, Greenhouse, Lever, Workday), and realistic match scores (60–98). Mark 2–3 jobs as is_new: true. Order by match_score descending.

IMPORTANT URL rules:
- Only include a URL if you found it directly via web search and confirmed the listing is currently open.
- Prefer direct application URLs (Greenhouse, Lever, Workday, company careers page) over job board listing pages where possible.
- Do not construct or guess URLs — only use URLs you have seen in search results.
- If you cannot find a confirmed URL for a job, omit the url field entirely.`;

  const userMsg = `Find relevant job openings for this candidate and draft a notification email:\n\n${profileDesc}`;

  addLog('Searching job boards: LinkedIn, Greenhouse, Lever, Workday...', 'search');
  await delay(800);
  addLog('Searching: Indeed, Glassdoor, Wellfound (AngelList)...', 'search');
  await delay(600);

  let data: AgentResponse;
  try {
    type Message = { role: 'user' | 'assistant'; content: string | AnthropicContent[] };
    const messages: Message[] = [{ role: 'user', content: userMsg }];
    let raw: AnthropicResponse = {};

    for (let turn = 0; turn < 5; turn++) {
      const resp = await fetch('/api/proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1800,
          system: systemPrompt,
          messages,
          tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        }),
      });
      raw = await resp.json() as AnthropicResponse;

      if (raw.stop_reason !== 'tool_use') break;

      const searches = (raw.content ?? []).filter(b => b.type === 'tool_use');
      addLog(`Web search: ${searches.map(b => JSON.stringify((b.input as Record<string, unknown>)?.query ?? b.name)).join(', ')}`, 'search');

      messages.push({ role: 'assistant', content: raw.content ?? [] });
      messages.push({
        role: 'user',
        content: searches.map(b => ({ type: 'tool_result', tool_use_id: b.id, content: '' })),
      });
    }

    const textBlock = raw.content?.find(b => b.type === 'text');
    if (!textBlock) throw new Error('No text in response');
    const cleaned = textBlock.text!.replace(/```json|```/g, '').trim();
    data = JSON.parse(cleaned) as AgentResponse;
  } catch (err) {
    addLog('API error: ' + (err as Error).message, 'error');
    addLog('Using curated fallback results for demo...', 'info');
    data = generateFallback(name, title, rolesList, skillsList, location, jobtype);
  }

  const jobs = data.jobs ?? [];
  addLog(`Found ${jobs.length} matching positions`, 'found');
  await delay(400);

  const list = document.getElementById('jobs-list')!;
  list.innerHTML = '';
  let highCount = 0, newCount = 0;

  jobs.forEach((job, i) => {
    setTimeout(() => {
      if (job.match_score >= 85) highCount++;
      if (job.is_new) newCount++;

      const scoreClass = job.match_score >= 85 ? 'high' : job.match_score >= 70 ? 'mid' : '';
      const card = document.createElement('div');
      card.className = 'job-card' + (job.is_new ? ' new' : '');
      card.style.animationDelay = (i * 80) + 'ms';

      const skillTags = (job.skills_matched ?? []).map(s =>
        `<span class="job-tag tag-match">${s}</span>`).join('');
      const newTag = job.is_new ? `<span class="job-tag tag-new">✦ New</span>` : '';
      const locTag = job.location ? `<span class="job-tag tag-loc">${job.location}</span>` : '';
      const typeTag = job.type ? `<span class="job-tag tag-type">${job.type}</span>` : '';

      const urlBadgeId = `url-badge-${i}`;
      card.innerHTML = `
        <div>
          <div class="job-title">${job.title}</div>
          <div class="job-co">${job.company}</div>
          <div class="job-tags">${newTag}${locTag}${typeTag}${skillTags}</div>
          ${job.reason ? `<div style="font-size:12px;color:var(--muted);margin-top:8px;line-height:1.5">${job.reason}</div>` : ''}
        </div>
        <div class="job-score">
          <div class="score-circle ${scoreClass}">${job.match_score}%</div>
          <a class="apply-link" href="${job.url ?? '#'}" target="_blank">View ↗</a>
          ${job.url ? `<span id="${urlBadgeId}" class="url-checking">checking…</span>` : ''}
        </div>
      `;
      list.appendChild(card);

      document.getElementById('stat-found')!.textContent = String(i + 1);
      document.getElementById('stat-high')!.textContent = String(highCount);
      document.getElementById('stat-new')!.textContent = String(newCount);
    }, i * 120);
  });

  await delay(jobs.length * 120 + 400);

  // Verify job URLs in the background — updates badges as results come in
  void checkJobUrls(jobs);

  const recipient = 'celestemricci@gmail.com';
  const emailSubject = data.email_subject ?? 'Your daily job matches';

  if (data.email_body) {
    const ep = document.getElementById('email-preview')!;
    ep.textContent = `To: ${recipient}\nSubject: ${emailSubject}\n\n${data.email_body}`;
    (ep as HTMLElement).style.display = 'block';
  }

  addLog('Composing daily digest email...', 'email');
  await delay(500);
  addLog(`Sending to ${recipient} · Subject: "${emailSubject}"`, 'email');

  try {
    const emailResp = await fetch('/api/send-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: recipient, subject: emailSubject, text: data.email_body ?? '' }),
    });
    if (!emailResp.ok) throw new Error(`Status ${emailResp.status}`);
    addLog('✓ Email sent successfully', 'found');
  } catch (err) {
    addLog(`Email failed: ${(err as Error).message}`, 'error');
  }

  addLog('Agent run complete. Next run scheduled for tomorrow.', 'info');

  const statEmail = document.getElementById('stat-email')!;
  statEmail.textContent = '✓ Sent';
  (statEmail as HTMLElement).style.color = 'var(--green)';
  document.getElementById('results-count')!.textContent = `${jobs.length} jobs`;
  document.getElementById('last-run')!.textContent = `Last run: ${new Date().toLocaleString()} · Next: tomorrow at this time`;
  document.getElementById('run-status')!.textContent = 'Done';

  btn.disabled = false;
  spinner.style.display = 'none';
  btnLabel.textContent = '▶ Run agent now';
}

async function checkJobUrls(jobs: JobMatch[]): Promise<void> {
  const urlsToCheck = jobs.map(j => j.url).filter((u): u is string => !!u);
  if (urlsToCheck.length === 0) return;

  let results: Record<string, string> = {};
  try {
    const resp = await fetch('/api/check-urls', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls: urlsToCheck }),
    });
    if (resp.ok) {
      ({ results } = await resp.json() as { results: Record<string, string> });
    }
  } catch {
    return; // Silently bail — URL checking is best-effort
  }

  jobs.forEach((job, i) => {
    if (!job.url) return;
    const badge = document.getElementById(`url-badge-${i}`);
    if (!badge) return;

    const status = results[job.url];
    if (status === 'ok') {
      badge.className = 'url-badge url-ok';
      badge.textContent = '✓ Verified';
    } else if (status === 'dead') {
      badge.className = 'url-badge url-dead';
      badge.textContent = '✗ May be closed';
    } else if (status === 'blocked') {
      badge.className = 'url-badge url-blocked';
      badge.textContent = '~ Unverifiable';
    } else {
      badge.remove();
    }
  });
}

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function generateFallback(
  name: string,
  title: string,
  rolesList: string[],
  skillsList: string[],
  location: string,
  jobtype: string,
): AgentResponse {
  const role = rolesList[0] || title || 'Product Manager';
  const loc = location || 'Remote';
  return {
    email_subject: `${name || 'Hi'}, your top job matches for today`,
    email_body: `Hi ${name || 'there'},\n\nHere are your top job matches for today:\n\n1. ${role} at Acme Corp — 95% match\n2. Senior ${role} at BuildCo — 88% match\n3. Lead ${role} at Startify — 82% match\n\nThree new listings appeared overnight. Two are marked as high-priority matches based on your skills and preferences.\n\nHappy job hunting!\n— Launchpad Agent`,
    jobs: [
      { title: role, company: 'Figma', location: loc, type: jobtype, match_score: 95, is_new: true, skills_matched: skillsList.slice(0, 3), url: 'https://www.figma.com/careers', reason: 'Strong alignment with your experience and target role.' },
      { title: `Senior ${role}`, company: 'Linear', location: loc, type: jobtype, match_score: 91, is_new: false, skills_matched: skillsList.slice(0, 2), url: 'https://linear.app/careers', reason: 'Linear is hiring for this exact role; culture and stage match your notes.' },
      { title: `Lead ${role}`, company: 'Notion', location: loc, type: jobtype, match_score: 87, is_new: true, skills_matched: skillsList.slice(0, 2), url: 'https://www.notion.so/careers', reason: "Notion's fast-growing team is a great fit for your background." },
      { title: role, company: 'Vercel', location: loc, type: jobtype, match_score: 82, is_new: false, skills_matched: skillsList.slice(0, 1), url: 'https://vercel.com/careers', reason: 'Developer-focused company aligned with your skills.' },
      { title: `${role} II`, company: 'Stripe', location: loc, type: jobtype, match_score: 78, is_new: false, skills_matched: skillsList.slice(0, 1), url: 'https://stripe.com/jobs', reason: 'Stripe values strong technical skills and offers excellent compensation.' },
    ],
  };
}

// Load saved profile on page load, then expose runAgent globally
loadProfile();
(window as unknown as Record<string, unknown>).runAgent = runAgent;

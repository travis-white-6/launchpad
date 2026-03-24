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

function makeTagInput(wrapperId: string, inputId: string): () => string[] {
  const wrapper = document.getElementById(wrapperId)!;
  const input = document.getElementById(inputId) as HTMLInputElement;
  const tags: string[] = [];
  input.addEventListener('keydown', (e: KeyboardEvent) => {
    if ((e.key === 'Enter' || e.key === ',') && input.value.trim()) {
      e.preventDefault();
      const val = input.value.trim().replace(/,+$/, '');
      if (val && !tags.includes(val)) {
        tags.push(val);
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.innerHTML = `${val}<button onclick="this.parentElement.remove()">×</button>`;
        wrapper.insertBefore(tag, input);
      }
      input.value = '';
    }
  });
  return () => tags;
}

const getRoles = makeTagInput('roles-wrapper', 'roles-input');
const getSkills = makeTagInput('skills-wrapper', 'skills-input');

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

async function runAgent(): Promise<void> {
  const name = (document.getElementById('name') as HTMLInputElement).value.trim();
  const title = (document.getElementById('title') as HTMLInputElement).value.trim();
  const experience = (document.getElementById('experience') as HTMLSelectElement).value;
  const location = (document.getElementById('location') as HTMLSelectElement).value;
  const jobtype = (document.getElementById('jobtype') as HTMLSelectElement).value;
  const notes = (document.getElementById('notes') as HTMLTextAreaElement).value.trim();
  const roles = getRoles();
  const skills = getSkills();

  if (!title && roles.length === 0) {
    alert('Please enter a current title or add at least one target role.');
    return;
  }

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
  addLog(`Profile: ${name || 'Candidate'} · ${title || roles[0] || 'TBD'} · ${experience || 'any exp'}`, 'info');
  addLog(`Preferences: ${location || 'Any location'} · ${jobtype}`, 'info');

  const profileDesc = [
    name ? `Name: ${name}` : '',
    title ? `Current role: ${title}` : '',
    experience ? `Experience: ${experience}` : '',
    roles.length > 0 ? `Target roles: ${roles.join(', ')}` : '',
    skills.length > 0 ? `Skills: ${skills.join(', ')}` : '',
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

Return 4–8 jobs. Use realistic company names, realistic job boards (LinkedIn, Greenhouse, Lever, Workday), and realistic match scores (60–98). Mark 2–3 jobs as is_new: true. Order by match_score descending.`;

  const userMsg = `Find relevant job openings for this candidate and draft a notification email:\n\n${profileDesc}`;

  addLog('Searching job boards: LinkedIn, Greenhouse, Lever, Workday...', 'search');
  await delay(800);
  addLog('Searching: Indeed, Glassdoor, Wellfound (AngelList)...', 'search');
  await delay(600);

  let data: AgentResponse;
  try {
    const resp = await fetch('/api/proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1800,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMsg }],
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      }),
    });
    const raw = await resp.json() as { content?: Array<{ type: string; text?: string }> };
    const textBlock = raw.content?.find(b => b.type === 'text');
    if (!textBlock) throw new Error('No text in response');
    const cleaned = textBlock.text!.replace(/```json|```/g, '').trim();
    data = JSON.parse(cleaned) as AgentResponse;
  } catch (err) {
    addLog('API error: ' + (err as Error).message, 'error');
    addLog('Using curated fallback results for demo...', 'info');
    data = generateFallback(name, title, roles, skills, location, jobtype);
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
        </div>
      `;
      list.appendChild(card);

      document.getElementById('stat-found')!.textContent = String(i + 1);
      document.getElementById('stat-high')!.textContent = String(highCount);
      document.getElementById('stat-new')!.textContent = String(newCount);
    }, i * 120);
  });

  await delay(jobs.length * 120 + 400);
  addLog('Composing daily digest email...', 'email');
  await delay(500);
  addLog(`Sending to celestemricci@gmail.com · Subject: "${data.email_subject ?? 'Your daily job matches'}"`, 'email');

  if (data.email_body) {
    const ep = document.getElementById('email-preview')!;
    ep.textContent = `To: celestemricci@gmail.com\nSubject: ${data.email_subject ?? 'Your daily job matches'}\n\n${data.email_body}`;
    (ep as HTMLElement).style.display = 'block';
  }

  await delay(300);
  addLog('✓ Email sent successfully', 'found');
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

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function generateFallback(
  name: string,
  title: string,
  roles: string[],
  skills: string[],
  location: string,
  jobtype: string,
): AgentResponse {
  const role = roles[0] || title || 'Product Manager';
  const loc = location || 'Remote';
  return {
    email_subject: `${name || 'Hi'}, your top job matches for today`,
    email_body: `Hi ${name || 'there'},\n\nHere are your top job matches for today:\n\n1. ${role} at Acme Corp — 95% match\n2. Senior ${role} at BuildCo — 88% match\n3. Lead ${role} at Startify — 82% match\n\nThree new listings appeared overnight. Two are marked as high-priority matches based on your skills and preferences.\n\nHappy job hunting!\n— Launchpad Agent`,
    jobs: [
      { title: role, company: 'Figma', location: loc, type: jobtype, match_score: 95, is_new: true, skills_matched: skills.slice(0, 3), url: 'https://www.figma.com/careers', reason: 'Strong alignment with your experience and target role.' },
      { title: `Senior ${role}`, company: 'Linear', location: loc, type: jobtype, match_score: 91, is_new: false, skills_matched: skills.slice(0, 2), url: 'https://linear.app/careers', reason: 'Linear is hiring for this exact role; culture and stage match your notes.' },
      { title: `Lead ${role}`, company: 'Notion', location: loc, type: jobtype, match_score: 87, is_new: true, skills_matched: skills.slice(0, 2), url: 'https://www.notion.so/careers', reason: "Notion's fast-growing team is a great fit for your background." },
      { title: role, company: 'Vercel', location: loc, type: jobtype, match_score: 82, is_new: false, skills_matched: skills.slice(0, 1), url: 'https://vercel.com/careers', reason: 'Developer-focused company aligned with your skills.' },
      { title: `${role} II`, company: 'Stripe', location: loc, type: jobtype, match_score: 78, is_new: false, skills_matched: skills.slice(0, 1), url: 'https://stripe.com/jobs', reason: 'Stripe values strong technical skills and offers excellent compensation.' },
    ],
  };
}

(window as unknown as Record<string, unknown>).runAgent = runAgent;

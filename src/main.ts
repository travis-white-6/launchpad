import type { JobMatch, RunResult } from '../netlify/functions/run-background.js';

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
  lastRun?: string;
  dailyEnabled?: boolean;
  paused?: boolean;
  skipNext?: boolean;
}

interface TagInput {
  get: () => string[];
  set: (values: string[]) => void;
}

interface RunRecord {
  id: string;
  timestamp: string;
  type: 'manual' | 'scheduled';
  jobCount: number;
  status: 'success' | 'error';
  error?: string;
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
    const btn = document.createElement('button');
    btn.textContent = '×';
    btn.addEventListener('click', () => {
      tag.remove();
      const idx = tags.indexOf(val);
      if (idx !== -1) tags.splice(idx, 1);
    });
    tag.append(document.createTextNode(val), btn);
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

  input.addEventListener('paste', (e: ClipboardEvent) => {
    const text = e.clipboardData?.getData('text') ?? '';
    if (!text.includes(',')) return;
    e.preventDefault();
    text.split(',').map(s => s.trim()).filter(Boolean).forEach(addTag);
    input.value = '';
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
const recipients = makeTagInput('recipients-wrapper', 'recipients-input');

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
    if (profile.recipients?.length) recipients.set(profile.recipients);
    if (profile.lastRun) {
      document.getElementById('last-run')!.textContent = `Last run: ${new Date(profile.lastRun).toLocaleString()} · Next: ${nextRunLabel()}`;
    }
  } catch {
    // Ignore — form just won't be pre-filled
  }
}

async function saveProfile(profile: SavedProfile): Promise<void> {
  await fetch('/api/profile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(profile),
  }).catch(() => {});
}

// --- Next run label ---

function nextRunLabel(): string {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 9, 0, 0));
  if (now >= next) next.setUTCDate(next.getUTCDate() + 1);
  return next.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
}

// --- Job URL verification ---

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
    return;
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

// --- Results rendering ---

function renderResults(result: RunResult): void {
  const jobs = result.jobs ?? [];

  // Hide pending message
  document.getElementById('run-pending-msg')!.style.display = 'none';

  // Job cards
  const list = document.getElementById('jobs-list')!;
  list.innerHTML = '';
  let highCount = 0, newCount = 0;

  if (jobs.length === 0) {
    list.innerHTML = `<div class="empty"><div class="empty-icon">🔍</div><div class="empty-title">No jobs found</div><div class="empty-sub">Try broadening your target roles or skills.</div></div>`;
  } else {
    jobs.forEach((job, i) => {
      if (job.match_score >= 85) highCount++;
      if (job.is_new) newCount++;

      const scoreClass = job.match_score >= 85 ? 'high' : job.match_score >= 70 ? 'mid' : '';
      const card = document.createElement('div');
      card.className = 'job-card' + (job.is_new ? ' new' : '');

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
    });
  }

  // Stats
  document.getElementById('stat-found')!.textContent = String(jobs.length);
  document.getElementById('stat-high')!.textContent = String(highCount);
  document.getElementById('stat-new')!.textContent = String(newCount);

  const statEmail = document.getElementById('stat-email')!;
  if (result.emailSent) {
    statEmail.textContent = '✓ Sent';
    (statEmail as HTMLElement).style.color = 'var(--green)';
  } else {
    statEmail.textContent = '✗ Not sent';
    (statEmail as HTMLElement).style.color = 'var(--red)';
  }

  // Email preview
  if (result.email_body) {
    const ep = document.getElementById('email-preview')!;
    const toList = recipients.get().join(', ');
    ep.textContent = `To: ${toList}\nSubject: ${result.email_subject ?? ''}\n\n${result.email_body}`;
    (ep as HTMLElement).style.display = 'block';
  }

  // Header
  document.getElementById('results-count')!.textContent = `${jobs.length} jobs`;
  document.getElementById('run-status')!.textContent = 'Done';
  if (result.completedAt) {
    document.getElementById('last-run')!.textContent = `Last run: ${new Date(result.completedAt).toLocaleString()} · Next: ${nextRunLabel()}`;
  }

  void loadRunHistory();
  void loadScheduleStatus();

  // Verify URLs in background
  void checkJobUrls(jobs);
}

function showRunError(message: string): void {
  document.getElementById('run-pending-msg')!.style.display = 'none';
  const list = document.getElementById('jobs-list')!;
  list.innerHTML = `<div class="empty"><div class="empty-icon">⚠</div><div class="empty-title">Run failed</div><div class="empty-sub">${message}</div></div>`;
  document.getElementById('run-status')!.textContent = 'Error';
}

// --- Polling ---

async function pollRunStatus(runId: string): Promise<void> {
  const startedAt = Date.now();
  const maxAttempts = 120; // 10 minutes at 5s intervals
  const pendingSub = document.getElementById('pending-sub')!;

  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, 5000));

    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    const elapsedStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
    pendingSub.textContent = `Searching job boards · ${elapsedStr} elapsed`;

    try {
      const resp = await fetch(`/api/run-status?id=${encodeURIComponent(runId)}`);
      if (!resp.ok) continue;

      const result = await resp.json() as RunResult;

      if (result.status === 'success') {
        renderResults(result);
        return;
      }
      if (result.status === 'error') {
        showRunError(result.error ?? 'Agent run failed.');
        return;
      }
      // 'pending' — keep polling
    } catch {
      // Network hiccup — keep polling
    }
  }

  showRunError('Agent run timed out after 10 minutes. Check Netlify function logs for details.');
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
  const recipientsList = recipients.get();

  if (!title && rolesList.length === 0) {
    alert('Please enter a current title or add at least one target role.');
    return;
  }
  if (recipientsList.length === 0) {
    alert('Please add at least one recipient email address.');
    return;
  }

  // Await profile save so the background function reads the latest data
  await saveProfile({ name, title, experience, location, jobtype, notes, roles: rolesList, skills: skillsList, recipients: recipientsList });

  const btn = document.getElementById('run-btn') as HTMLButtonElement;
  const spinner = document.getElementById('spinner')!;
  const btnLabel = document.getElementById('btn-label')!;
  btn.disabled = true;
  spinner.style.display = 'block';
  btnLabel.textContent = 'Running…';
  document.getElementById('run-status')!.textContent = 'Running';

  // Clear previous results
  document.getElementById('jobs-list')!.innerHTML = '';
  (document.getElementById('email-preview') as HTMLElement).style.display = 'none';
  document.getElementById('stat-found')!.textContent = '—';
  document.getElementById('stat-high')!.textContent = '—';
  document.getElementById('stat-new')!.textContent = '—';
  document.getElementById('stat-email')!.textContent = '—';

  // Show pending message
  const pendingMsg = document.getElementById('run-pending-msg')!;
  const pendingSub = document.getElementById('pending-sub')!;
  pendingSub.textContent = 'Searching job boards · 0s elapsed';
  pendingMsg.style.display = 'flex';

  // Generate run ID in browser — background function uses it as the Blobs key
  const runId = new Date().toISOString() + '-' + Math.random().toString(36).slice(2, 8);

  try {
    const resp = await fetch('/api/run-background', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId }),
    });

    // Background functions return 202; anything else is a startup error
    if (resp.status !== 200 && resp.status !== 202) {
      throw new Error(`Unexpected status ${resp.status} from run-background`);
    }
  } catch (err) {
    showRunError(`Failed to start agent: ${(err as Error).message}`);
    btn.disabled = false;
    spinner.style.display = 'none';
    btnLabel.textContent = '▶ Run agent now';
    return;
  }

  // Poll until done (handles its own timeout)
  await pollRunStatus(runId);

  btn.disabled = false;
  spinner.style.display = 'none';
  btnLabel.textContent = '▶ Run agent now';
}

// --- Run history ---

function renderRunHistory(runs: RunRecord[]): void {
  const list = document.getElementById('run-history-list')!;
  const count = document.getElementById('run-history-count')!;
  count.textContent = `${runs.length} run${runs.length !== 1 ? 's' : ''}`;

  if (runs.length === 0) {
    list.innerHTML = `<div class="empty"><div class="empty-icon">📋</div><div class="empty-title">No runs yet — configure your profile and run the agent.</div></div>`;
    return;
  }

  list.innerHTML = '';
  runs.forEach(run => {
    const row = document.createElement('div');
    row.className = 'run-row';
    row.dataset.id = run.id;

    const statusHtml = run.status === 'success'
      ? `<span class="run-status-ok">✓ Success</span>`
      : `<span class="run-status-error">✗ Error</span>`;

    row.innerHTML = `
      <span class="run-time">${new Date(run.timestamp).toLocaleString()}</span>
      <span class="run-type">${run.type}</span>
      <span class="run-jobs">${run.jobCount} job${run.jobCount !== 1 ? 's' : ''}</span>
      ${statusHtml}
      <button class="run-delete">Delete</button>
    `;

    row.querySelector('.run-delete')!.addEventListener('click', () => void deleteRun(run.id));
    list.appendChild(row);
  });
}

async function loadRunHistory(): Promise<void> {
  try {
    const resp = await fetch('/api/runs');
    if (!resp.ok) return;
    const runs = await resp.json() as RunRecord[];
    renderRunHistory(runs);
  } catch {
    // Ignore
  }
}

async function deleteRun(id: string): Promise<void> {
  try {
    await fetch('/api/runs', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    document.querySelector(`.run-row[data-id="${CSS.escape(id)}"]`)?.remove();
    const list = document.getElementById('run-history-list')!;
    const remaining = list.querySelectorAll('.run-row').length;
    document.getElementById('run-history-count')!.textContent = `${remaining} run${remaining !== 1 ? 's' : ''}`;
    if (remaining === 0) {
      list.innerHTML = `<div class="empty"><div class="empty-icon">📋</div><div class="empty-title">No runs yet — configure your profile and run the agent.</div></div>`;
    }
  } catch {
    // Ignore
  }
}

// --- Schedule management ---

let currentProfile: SavedProfile = {};

async function loadScheduleStatus(): Promise<void> {
  try {
    const resp = await fetch('/api/profile');
    if (!resp.ok) return;
    currentProfile = await resp.json() as SavedProfile;
    renderScheduleStatus(currentProfile);
  } catch {
    // Ignore
  }
}

function renderScheduleStatus(profile: SavedProfile): void {
  const recipientsEl = document.getElementById('sched-recipients')!;
  const statusEl = document.getElementById('sched-status')!;
  const pauseBtn = document.getElementById('pause-btn') as HTMLButtonElement;
  const skipBtn = document.getElementById('skip-btn') as HTMLButtonElement;
  const schedActions = document.getElementById('sched-actions')!;
  const dailyBtn = document.getElementById('daily-btn') as HTMLButtonElement;

  // Recipients
  recipientsEl.innerHTML = '';
  if (profile.recipients?.length) {
    profile.recipients.forEach(r => {
      const chip = document.createElement('span');
      chip.className = 'sched-email';
      const label = document.createTextNode(r);
      const btn = document.createElement('button');
      btn.className = 'sched-email-remove';
      btn.textContent = '×';
      btn.title = `Remove ${r}`;
      btn.addEventListener('click', () => void removeRecipient(r));
      chip.append(label, btn);
      recipientsEl.appendChild(chip);
    });
  } else {
    recipientsEl.innerHTML = `<span style="color:var(--muted);font-size:12px">No recipients configured — add emails in the sidebar.</span>`;
  }

  // Schedule status + actions depend on dailyEnabled state
  if (!profile.dailyEnabled) {
    statusEl.innerHTML = `<span class="sched-badge inactive">○ Not scheduled</span> Click "Get daily email" to enable 9 AM UTC runs.`;
    schedActions.style.display = 'none';
    dailyBtn.textContent = '📅 Get daily email';
    dailyBtn.className = 'daily-btn';
  } else if (profile.paused) {
    statusEl.innerHTML = `<span class="sched-badge paused">⏸ Paused</span> Daily emails are suspended.`;
    schedActions.style.display = 'flex';
    pauseBtn.textContent = '▶ Resume';
    pauseBtn.dataset.action = 'resume';
    skipBtn.disabled = true;
    dailyBtn.textContent = '✓ Daily email on';
    dailyBtn.className = 'daily-btn active';
  } else if (profile.skipNext) {
    statusEl.innerHTML = `<span class="sched-badge skip">⏭ Skipping next run</span> Next: ${nextRunLabel()}.`;
    schedActions.style.display = 'flex';
    pauseBtn.textContent = '⏸ Pause';
    pauseBtn.dataset.action = 'pause';
    skipBtn.disabled = true;
    dailyBtn.textContent = '✓ Daily email on';
    dailyBtn.className = 'daily-btn active';
  } else {
    statusEl.innerHTML = `<span class="sched-badge active">● Active</span> Next run: ${nextRunLabel()}.`;
    schedActions.style.display = 'flex';
    pauseBtn.textContent = '⏸ Pause';
    pauseBtn.dataset.action = 'pause';
    skipBtn.disabled = false;
    dailyBtn.textContent = '✓ Daily email on';
    dailyBtn.className = 'daily-btn active';
  }
}

async function enableDailyEmail(): Promise<void> {
  const btn = document.getElementById('daily-btn') as HTMLButtonElement;
  btn.disabled = true;
  try {
    const updated = { ...currentProfile, dailyEnabled: true, paused: false, skipNext: false };
    await fetch('/api/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updated),
    });
    currentProfile = updated;
    renderScheduleStatus(currentProfile);
  } finally {
    btn.disabled = false;
  }
}

async function removeRecipient(email: string): Promise<void> {
  const updated = { ...currentProfile, recipients: (currentProfile.recipients ?? []).filter(r => r !== email) };
  await fetch('/api/profile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updated),
  });
  currentProfile = updated;
  recipients.set(updated.recipients ?? []);
  renderScheduleStatus(currentProfile);
}

async function togglePause(): Promise<void> {
  const btn = document.getElementById('pause-btn') as HTMLButtonElement;
  const action = btn.dataset.action ?? 'pause';
  const newPaused = action === 'pause';

  btn.disabled = true;
  try {
    const updated = { ...currentProfile, paused: newPaused, skipNext: false };
    await fetch('/api/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updated),
    });
    currentProfile = updated;
    renderScheduleStatus(currentProfile);
  } finally {
    btn.disabled = false;
  }
}

async function skipNextRun(): Promise<void> {
  const btn = document.getElementById('skip-btn') as HTMLButtonElement;
  btn.disabled = true;
  try {
    const updated = { ...currentProfile, skipNext: true };
    await fetch('/api/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updated),
    });
    currentProfile = updated;
    renderScheduleStatus(currentProfile);
  } finally {
    btn.disabled = false;
  }
}

// --- Boot ---

loadProfile();
loadRunHistory();
loadScheduleStatus();

(window as unknown as Record<string, unknown>).runAgent = runAgent;
(window as unknown as Record<string, unknown>).enableDailyEmail = enableDailyEmail;
(window as unknown as Record<string, unknown>).togglePause = togglePause;
(window as unknown as Record<string, unknown>).skipNextRun = skipNextRun;

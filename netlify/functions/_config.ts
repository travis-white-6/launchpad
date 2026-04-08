// Shared configuration for all Netlify functions.
// The _ prefix prevents Netlify treating this file as a function endpoint.

// --- Allowed origins ---

export const ALLOWED_ORIGINS: string[] = [
  'https://curious-profiterole-6c8c76.netlify.app',
  ...(process.env.NETLIFY_DEV === 'true' ? ['http://localhost:8888'] : []),
];

// --- Environment variable accessors ---
// Each throws immediately with a clear message if the variable is missing,
// so misconfigured deployments fail loudly at the point of first use.

export const ANTHROPIC_API_KEY = (): string => {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set');
  return key;
};

export const MAILGUN_API_KEY = (): string => {
  const key = process.env.MAILGUN_API_KEY;
  if (!key) throw new Error('MAILGUN_API_KEY is not set');
  return key;
};

export const MAILGUN_DOMAIN = (): string => {
  const domain = process.env.MAILGUN_DOMAIN;
  if (!domain) throw new Error('MAILGUN_DOMAIN is not set');
  return domain;
};

// --- JSON parsing helper ---
// Strips markdown fences, tries a direct parse, then falls back to
// extracting the outermost { ... } in case the model wraps JSON in prose.

export function tryParseJson<T>(text: string): T | null {
  const stripped = text.replace(/```json|```/g, '').trim();

  try { return JSON.parse(stripped) as T; } catch {}

  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try { return JSON.parse(stripped.slice(start, end + 1)) as T; } catch {}
  }

  return null;
}

/**
 * The only sites Candor will open in the system browser (provider key pages and docs). Everything else, including
 * every non-https scheme (file:, ms-msdt:, javascript:, custom protocol handlers), is refused.
 */
const ALLOWED_HOSTS = [
  'anthropic.com',
  'openai.com',
  'google.com',
  'deepgram.com',
  'assemblyai.com',
  'ollama.com',
  'lmstudio.ai',
  'github.com',
  'microsoft.com',
  'console.groq.com',
  'openrouter.ai',
];

export function isAllowedExternalUrl(raw: string): boolean {
  if (raw.length > 500) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  return ALLOWED_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

import type { ProviderKind } from './types';

/**
 * A key pasted for the wrong service would be sent to that service's servers (which is how a Google key once ended up
 * at OpenAI). Vendors' key prefixes are distinctive, so a clear mismatch is caught before anything is sent.
 * When the prefix or the provider is unfamiliar there is no opinion: custom and local endpoints are never blocked.
 */

export type KeyOwner = 'google' | 'anthropic' | 'openai' | 'groq' | 'openrouter';

const OWNER_LABEL: Record<KeyOwner, string> = { google: 'Google', anthropic: 'Anthropic', openai: 'OpenAI', groq: 'Groq', openrouter: 'OpenRouter' };
/** How each service is named in the Service list. */
const SERVICE_OPTION: Record<KeyOwner, string> = {
  google: 'Google Gemini — API key (free tier available)',
  anthropic: 'Anthropic Claude (paid — prepaid credit)',
  openai: 'OpenAI (paid — prepaid credit)',
  groq: 'Groq — very fast (has a free plan)',
  openrouter: 'OpenRouter — some models are free',
};

/** Which service a key belongs to, judging by its prefix; null when it is not recognisable. */
export function keyOwner(key: string): KeyOwner | null {
  const k = key.trim();
  if (/^AIza/.test(k) || /^AQ\./.test(k)) return 'google';
  if (/^sk-ant-/.test(k)) return 'anthropic';
  if (/^sk-or-/.test(k)) return 'openrouter';
  if (/^gsk_/.test(k)) return 'groq';
  if (/^sk-/.test(k)) return 'openai';
  return null;
}

/** Which service a provider talks to; null for custom, local or unfamiliar endpoints. */
export function providerOwner(kind: ProviderKind, baseUrl: string): KeyOwner | null {
  if (kind === 'google') return 'google';
  if (kind === 'anthropic') return 'anthropic';
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (host === 'api.openai.com') return 'openai';
  if (host === 'api.groq.com') return 'groq';
  if (host === 'openrouter.ai' || host.endsWith('.openrouter.ai')) return 'openrouter';
  return null;
}

/** A sentence explaining the mismatch, or null when the key is plausible for this provider (or nothing can be said). */
export function keyMismatch(kind: ProviderKind, baseUrl: string, key: string | undefined): string | null {
  if (!key?.trim()) return null;
  const has = keyOwner(key);
  const wants = providerOwner(kind, baseUrl);
  if (!has || !wants || has === wants) return null;
  return `That looks like a ${OWNER_LABEL[has]} key, but this provider is ${OWNER_LABEL[wants]}. Choose “${SERVICE_OPTION[has]}” in the Service list or paste the matching key. Nothing was sent.`;
}

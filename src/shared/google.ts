import type { GoogleAuthConfig, ProviderConfig } from './types';

/**
 * Pure helpers for the Google (Gemini) provider: which endpoint a configuration talks to, and where Google
 * credentials may be sent. Kept free of Node/Electron so the renderer and the tests can share them.
 */

export const GEMINI_API_HOST = 'https://generativelanguage.googleapis.com';

/** What an existing (pre-ADC) Google provider means: a Gemini Developer API key. */
export const API_KEY_AUTH: GoogleAuthConfig = { mode: 'apiKey', backend: 'gemini-api', project: '', location: '' };

/** Vertex AI host for a location ("global" has no region prefix). */
export function vertexHost(location: string): string {
  const l = (location || 'global').trim().toLowerCase();
  return l === 'global' ? 'https://aiplatform.googleapis.com' : `https://${l}-aiplatform.googleapis.com`;
}

export function googleBaseUrl(cfg: GoogleAuthConfig): string {
  return cfg.backend === 'vertex' ? vertexHost(cfg.location) : GEMINI_API_HOST;
}

/** The sign-in configuration of a provider; providers saved before ADC existed use an API key. */
export function googleAuthOf(p: Pick<ProviderConfig, 'kind' | 'google'>): GoogleAuthConfig {
  return p.kind === 'google' && p.google ? p.google : API_KEY_AUTH;
}

export function usesAdc(p: Pick<ProviderConfig, 'kind' | 'google'>): boolean {
  return p.kind === 'google' && p.google?.mode === 'adc';
}

/**
 * Hosts a Google OAuth access token may be sent to. Tokens are bearer credentials: a mistyped or malicious base URL
 * must never receive one. Loopback is allowed for local development and the test-suite.
 */
export function isGoogleApiHost(url: string): boolean {
  try {
    const u = new URL(url);
    const h = u.hostname.toLowerCase();
    if (u.protocol === 'https:') return h === 'googleapis.com' || h.endsWith('.googleapis.com');
    return u.protocol === 'http:' && (h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1');
  } catch {
    return false;
  }
}

/** "models/gemini-2.5-flash" and "publishers/google/models/gemini-2.5-flash" both mean "gemini-2.5-flash". */
export function stripGeminiPrefix(model: string): string {
  return model.trim().replace(/^publishers\/google\/models\//, '').replace(/^models\//, '');
}

/** A project id as accepted by Google Cloud (also allows the legacy "domain.com:project" form). Empty means "not set". */
export const PROJECT_ID_PATTERN = /^$|^[a-z][a-z0-9.:-]{4,61}[a-z0-9]$/i;
export const LOCATION_PATTERN = /^$|^[a-z][a-z0-9-]{1,38}[a-z0-9]$/i;

import { describe, expect, it } from 'vitest';
import { GEMINI_API_HOST, googleBaseUrl, isGoogleApiHost, stripGeminiPrefix, vertexHost } from '../../src/shared/google';
import { geminiCandidates, isGeminiChatModel, pickDefaultModels } from '../../src/shared/models';

/** A realistic slice of what Google lists: text models mixed with image, speech, live, embedding and robotics ones. */
const GOOGLE_LIST = [
  'gemini-2.0-flash',
  'gemini-2.0-flash-001',
  'gemini-2.0-flash-lite',
  'gemini-2.5-flash',
  'gemini-2.5-flash-image',
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash-native-audio-preview',
  'gemini-2.5-flash-preview-tts',
  'gemini-2.5-pro',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.5-flash-live',
  'gemini-3.6-flash-preview',
  'gemini-3.1-pro-preview',
  'gemini-embedding-001',
  'gemini-robotics-er-1.5-preview',
  'gemini-flash-latest',
  'gemma-3-27b-it',
];

describe('choosing default models from a provider list', () => {
  it('keeps only models that can answer text questions', () => {
    const chat = GOOGLE_LIST.filter(isGeminiChatModel);
    for (const bad of ['gemini-2.5-flash-image', 'gemini-2.5-flash-native-audio-preview', 'gemini-2.5-flash-preview-tts', 'gemini-3.5-flash-live', 'gemini-embedding-001', 'gemini-robotics-er-1.5-preview', 'gemma-3-27b-it']) {
      expect(chat, bad).not.toContain(bad);
    }
    expect(chat).toContain('gemini-3.5-flash');
  });

  it('prefers the newest stable Flash for live answers — not the alphabetically first (oldest) one', () => {
    const c = geminiCandidates(GOOGLE_LIST, 'fast');
    expect(c[0]).toBe('gemini-3.5-flash');
    expect(c.indexOf('gemini-2.5-flash')).toBeLessThan(c.indexOf('gemini-2.0-flash'));
    expect(c.indexOf('gemini-3.5-flash')).toBeLessThan(c.indexOf('gemini-3.5-flash-lite')); // Flash before Flash-Lite
    expect(c.indexOf('gemini-3.5-flash-lite')).toBeLessThan(c.indexOf('gemini-3.6-flash-preview')); // stable before preview
    expect(c[c.length - 1]).toBe('gemini-flash-latest'); // aliases can move under you: last
  });

  it('prefers a stable Pro for preparation, then Flash', () => {
    const c = geminiCandidates(GOOGLE_LIST, 'quality');
    expect(c[0]).toBe('gemini-2.5-pro');
    expect(c[1]).toBe('gemini-3.5-flash');
  });

  it('offers alternatives to try when the first choice has no quota', () => {
    const d = pickDefaultModels('google', GOOGLE_LIST, { fast: 'gemini-2.5-flash', quality: 'gemini-2.5-pro' });
    expect(d.fast).toBe('gemini-3.5-flash');
    expect(d.fastAlternatives.length).toBeGreaterThanOrEqual(3);
    expect(d.fastAlternatives).not.toContain(d.fast);
    expect(d.quality).toBe('gemini-2.5-pro');
  });

  it('falls back to the preset when the list is empty', () => {
    expect(pickDefaultModels('google', [], { fast: 'gemini-2.5-flash', quality: 'gemini-2.5-pro' })).toMatchObject({ fast: 'gemini-2.5-flash', quality: 'gemini-2.5-pro', fastAlternatives: [] });
  });

  it('is unchanged for other providers', () => {
    expect(pickDefaultModels('openai-compatible', ['gpt-4.1', 'gpt-4o-mini', 'text-embedding-3-small'], { fast: 'gpt-4.1-mini', quality: 'gpt-4.1' })).toMatchObject({ fast: 'gpt-4o-mini', quality: 'gpt-4.1' });
    expect(pickDefaultModels('anthropic', ['claude-haiku-4-5-20251001', 'claude-sonnet-5'], { fast: '', quality: '' })).toMatchObject({ fast: 'claude-haiku-4-5-20251001', quality: 'claude-sonnet-5' });
  });
});

describe('Google endpoints and where credentials may go', () => {
  it('derives the Vertex AI host from the location', () => {
    expect(vertexHost('global')).toBe('https://aiplatform.googleapis.com');
    expect(vertexHost('')).toBe('https://aiplatform.googleapis.com');
    expect(vertexHost('us-central1')).toBe('https://us-central1-aiplatform.googleapis.com');
    expect(googleBaseUrl({ mode: 'adc', backend: 'vertex', project: 'p', location: 'europe-west4' })).toBe('https://europe-west4-aiplatform.googleapis.com');
    expect(googleBaseUrl({ mode: 'adc', backend: 'gemini-api', project: 'p', location: '' })).toBe(GEMINI_API_HOST);
  });

  it('only Google API hosts (and loopback for development) may receive a token', () => {
    for (const ok of ['https://aiplatform.googleapis.com/v1/x', 'https://us-central1-aiplatform.googleapis.com/v1/x', GEMINI_API_HOST, 'http://127.0.0.1:8080/x', 'http://localhost:3000/']) expect(isGoogleApiHost(ok), ok).toBe(true);
    for (const bad of ['https://evil.example.com', 'https://googleapis.com.evil.example', 'https://notgoogleapis.com', 'http://aiplatform.googleapis.com', 'http://192.168.1.5/x', 'ftp://aiplatform.googleapis.com', 'not a url', '']) expect(isGoogleApiHost(bad), bad).toBe(false);
  });

  it('normalises model ids', () => {
    expect(stripGeminiPrefix('models/gemini-2.5-flash')).toBe('gemini-2.5-flash');
    expect(stripGeminiPrefix('publishers/google/models/gemini-2.5-flash')).toBe('gemini-2.5-flash');
    expect(stripGeminiPrefix(' gemini-2.5-flash ')).toBe('gemini-2.5-flash');
  });
});

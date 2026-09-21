import { describe, expect, it } from 'vitest';
import { keyMismatch, keyOwner, providerOwner } from '../../src/shared/keys';

describe('keys pasted for the wrong service are caught before anything is sent', () => {
  it('recognises where a key comes from', () => {
    expect(keyOwner('AIzaSyA1234567890abcdefghijklmnopqrstuv')).toBe('google');
    expect(keyOwner('AQ.Zx9Kq6abcdefghijklmnopqrstuvwxyz0123456789')).toBe('google');
    expect(keyOwner('sk-ant-api03-abcdefghijklmnop')).toBe('anthropic');
    expect(keyOwner('sk-or-v1-abcdefghijklmnop')).toBe('openrouter');
    expect(keyOwner('gsk_abcdefghijklmnop')).toBe('groq');
    expect(keyOwner('sk-proj-abcdefghijklmnop')).toBe('openai');
    expect(keyOwner('some-custom-token')).toBeNull();
    expect(keyOwner('')).toBeNull();
  });

  it('a Google key given to OpenAI is refused with an explanation (the exact mistake that sent a key to the wrong vendor)', () => {
    const m = keyMismatch('openai-compatible', 'https://api.openai.com/v1', 'AQ.Zx9Kq6abcdefghijklmnopqrstuvwxyz0123456789');
    expect(m).toMatch(/looks like a Google key, but this provider is OpenAI/);
    expect(m).toMatch(/Nothing was sent/);
    expect(m).not.toContain('AQ.Zx9Kq6'); // the message never repeats the key
  });

  it('catches the other common mix-ups', () => {
    expect(keyMismatch('anthropic', 'https://api.anthropic.com', 'sk-proj-abcdefghijklmnop')).toMatch(/OpenAI key.*Anthropic/);
    expect(keyMismatch('google', 'https://generativelanguage.googleapis.com', 'sk-ant-api03-abcdefghijklmnop')).toMatch(/Anthropic.*Google/);
    expect(keyMismatch('openai-compatible', 'https://api.groq.com/openai/v1', 'sk-proj-abcdefghijklmnop')).toMatch(/OpenAI key.*Groq/);
    expect(keyMismatch('openai-compatible', 'https://openrouter.ai/api/v1', 'gsk_abcdefghijklmnop')).toMatch(/Groq key.*OpenRouter/);
  });

  it('never blocks a plausible key, a custom endpoint, or a local server', () => {
    expect(keyMismatch('openai-compatible', 'https://api.openai.com/v1', 'sk-proj-abcdefghijklmnop')).toBeNull();
    expect(keyMismatch('google', 'https://generativelanguage.googleapis.com', 'AIzaSyA1234567890abcdefghijklmnopqrstuv')).toBeNull();
    expect(keyMismatch('anthropic', 'https://api.anthropic.com', 'sk-ant-api03-abcdefghijklmnop')).toBeNull();
    expect(keyMismatch('openai-compatible', 'https://my-company-gateway.example.com/v1', 'AQ.Zx9Kq6abcdefghijklmnopqrstuvwxyz')).toBeNull(); // unknown endpoint: no opinion
    expect(keyMismatch('openai-compatible', 'http://localhost:11434/v1', 'anything')).toBeNull();
    expect(keyMismatch('openai-compatible', 'https://api.openai.com/v1', undefined)).toBeNull();
    expect(keyMismatch('openai-compatible', 'https://api.openai.com/v1', '   ')).toBeNull();
  });

  it('knows which service a provider talks to', () => {
    expect(providerOwner('openai-compatible', 'https://api.openai.com/v1')).toBe('openai');
    expect(providerOwner('openai-compatible', 'not a url')).toBeNull();
    expect(providerOwner('google', 'https://aiplatform.googleapis.com')).toBe('google');
  });
});

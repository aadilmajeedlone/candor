import { resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveAppPath } from '../../src/main/electron/appPath';
import { isAllowedExternalUrl } from '../../src/main/security/links';
import { forgetSecret, redact, registerSecret } from '../../src/main/logging';

describe('external links', () => {
  it('opens provider sites over https and nothing else', () => {
    for (const ok of ['https://platform.openai.com/api-keys', 'https://console.anthropic.com/', 'https://aistudio.google.com/app/apikey', 'https://console.deepgram.com/', 'https://www.assemblyai.com/dashboard/signup', 'https://github.com/ollama/ollama', 'https://OpenAI.com/']) {
      expect(isAllowedExternalUrl(ok), ok).toBe(true);
    }
  });

  it('refuses look-alike hosts, credentials, other schemes and oversized input', () => {
    for (const bad of [
      'http://openai.com/', // not https
      'https://openai.com.evil.example/',
      'https://evil-openai.com/',
      'https://notopenai.com/',
      'https://evil.example/?next=https://openai.com/',
      'https://openai.com@evil.example/',
      'https://user:pw@openai.com/',
      'https://evil.example/#@openai.com',
      'file:///C:/Windows/System32/calc.exe',
      'javascript:alert(1)',
      'ms-msdt:/id PCWDiagnostic',
      'search-ms:query=x',
      'openai.com',
      '',
      `https://openai.com/${'a'.repeat(600)}`,
    ]) {
      expect(isAllowedExternalUrl(bad), bad).toBe(false);
    }
  });
});

describe('candor:// file serving', () => {
  const root = resolve('/srv/candor/renderer');
  const inside = (p: string | null): boolean => p === null || p.startsWith(root + sep);

  it('serves the app shell and its assets', () => {
    expect(resolveAppPath(root, '/')).toBe(resolve(root, 'index.html'));
    expect(resolveAppPath(root, '/index.html')).toBe(resolve(root, 'index.html'));
    expect(resolveAppPath(root, '/assets/index-abc123.js')).toBe(resolve(root, 'assets', 'index-abc123.js'));
    expect(resolveAppPath(root, '/assets/Inter%20Variable.woff2')).toBe(resolve(root, 'assets', 'Inter Variable.woff2'));
  });

  it('never resolves outside the renderer folder, whatever the encoding', () => {
    const nasty = [
      '/../secret.txt',
      '/../../etc/passwd',
      '/assets/../../../secret',
      '/..%2f..%2fsecret',
      '/%2e%2e/%2e%2e/secret',
      '/..%5c..%5csecret',
      '/..\\..\\secret',
      '/assets\\..\\..\\secret',
      '/C:/Windows/win.ini',
      '/C%3A%5CWindows%5Cwin.ini',
      '//server/share/file',
      '/\\\\server\\share\\file',
      '/%252e%252e/secret', // double-encoded: stays a literal folder name
      '/index.html/../../secret',
    ];
    for (const p of nasty) expect(inside(resolveAppPath(root, p)), p).toBe(true);
  });

  it('rejects malformed input outright', () => {
    expect(resolveAppPath(root, '/%E0%A4%A')).toBeNull(); // bad percent-encoding
    expect(resolveAppPath(root, '/x%00.png')).toBeNull(); // NUL byte
  });
});

describe('log redaction', () => {
  it('masks registered secrets and common credential shapes wherever they appear', () => {
    registerSecret('super-secret-value-123');
    const out = redact('request failed: super-secret-value-123 | Authorization: Bearer abcdef1234567890xyz | ?key=AIzaSyA1234567890123456789 | sk-ant-api03-abcdefghijklmnop | sk-abcdefghijklmnopqrstuvwx');
    expect(out).not.toContain('super-secret-value-123');
    expect(out).not.toContain('abcdef1234567890xyz');
    expect(out).not.toContain('AIzaSyA1234567890123456789');
    expect(out).not.toContain('sk-ant-api03');
    expect(out).not.toContain('sk-abcdefghijklmnopqrstuvwx');
    forgetSecret('super-secret-value-123');
    expect(redact('hello world, nothing secret here')).toBe('hello world, nothing secret here');
  });
});

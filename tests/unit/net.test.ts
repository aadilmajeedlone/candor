import { describe, expect, it } from 'vitest';
import { adviceFor } from '../../src/shared/errors';
import { endpointScope } from '../../src/shared/net';
import { mapNetworkError } from '../../src/main/ai/errors';
import { isLocalUrl } from '../../src/main/ai/gateway';

describe('where a server is', () => {
  it.each([
    'http://localhost:11434/v1',
    'http://127.0.0.1:1234/v1',
    'http://127.5.6.7/v1',
    'http://[::1]:8000/v1',
    'http://my-model.localhost:8000/v1',
  ])('%s is on this PC', (url) => {
    expect(endpointScope(url)).toBe('this-pc');
  });

  it.each([
    'http://10.0.0.5:8000/v1',
    'http://192.168.1.50:8000/v1',
    'http://172.16.0.9/v1',
    'http://172.31.255.254/v1',
    'http://169.254.10.10/v1', // link-local
    'http://100.64.0.1:8000/v1', // Tailscale / carrier-grade NAT range
    'http://100.101.102.103:8000/v1',
    'http://100.127.255.255/v1',
    'http://[fd12:3456:789a::1]:8000/v1', // IPv6 unique-local
    'http://[fe80::1]:8000/v1',
    'http://gaming-pc.local:8000/v1', // mDNS
    'https://friend-pc.tail1234.ts.net/v1', // Tailscale MagicDNS
  ])('%s is on your own network', (url) => {
    expect(endpointScope(url)).toBe('private-network');
  });

  it.each([
    'https://api.openai.com/v1',
    'http://8.8.8.8/v1',
    'http://172.32.0.1/v1', // just outside 172.16/12
    'http://172.15.255.255/v1',
    'http://100.63.255.255/v1', // just below the CGNAT range
    'http://100.128.0.1/v1', // just above it
    'http://192.169.0.1/v1',
    'http://11.0.0.1/v1',
    'https://friend.example.com/v1',
    'http://[2001:db8::1]/v1',
    'not a url',
    '',
  ])('%s is the internet', (url) => {
    expect(endpointScope(url)).toBe('internet');
  });

  it('a name cannot pose as a local server', () => {
    expect(endpointScope('http://localhost.evil.com/v1')).toBe('internet');
    expect(endpointScope('http://192.168.1.1.evil.com/v1')).toBe('internet');
    expect(endpointScope('http://10.0.0.1@evil.com/v1')).toBe('internet'); // the host is what follows the @
    expect(endpointScope('http://evil.com.local.attacker.net/v1')).toBe('internet');
    expect(endpointScope('http://mylocal/v1')).toBe('internet'); // a bare name is not assumed to be on this network
  });

  it('plain http and keyless use follow the same rule', () => {
    expect(isLocalUrl('http://192.168.1.50:8000/v1')).toBe(true);
    expect(isLocalUrl('http://100.101.102.103:8000/v1')).toBe(true);
    expect(isLocalUrl('http://203.0.113.5:8000/v1')).toBe(false);
  });
});

describe('connection failures name the right problem', () => {
  const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), { cause: { code: 'ECONNREFUSED' } });

  it('a model on this PC that is not running says so, and how to start it', () => {
    const e = mapNetworkError(refused, { name: 'Ollama', baseUrl: 'http://localhost:11434/v1' });
    expect(e.code).toBe('network');
    expect(e.message).toBe('Could not connect to Ollama on this PC. Is it running? For Ollama, start the Ollama app; for LM Studio or llama.cpp, start the local server. Then try again.');
    expect(e.retryable).toBe(true);
    expect(e.message).not.toMatch(/Internet/i);
  });

  it("a friend's server that cannot be reached points at the machine, the server and the network", () => {
    const e = mapNetworkError(refused, { name: "Friend's GPU", baseUrl: 'http://192.168.1.50:8000/v1' });
    expect(e.message).toContain("Could not reach Friend's GPU on your network");
    expect(e.message).toMatch(/machine is on.*server is running.*address and port.*same network or VPN/);
    expect(e.message).not.toMatch(/Internet/i);
  });

  it('a cloud service keeps the internet wording', () => {
    const e = mapNetworkError(refused, { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1' });
    expect(e.message).toBe('Internet connection unavailable — could not reach OpenAI.');
    expect(mapNetworkError(refused, 'OpenAI').message).toBe('Internet connection unavailable — could not reach OpenAI.');
  });

  it('the advice shown in the interface does not tell a local user their internet is down', () => {
    const local = adviceFor('network', mapNetworkError(refused, { name: 'Ollama', baseUrl: 'http://localhost:11434/v1' }).message);
    expect(local.title).toBe('Cannot reach your model server');
    expect(local.actions).toContain('open-providers');
    expect(adviceFor('network', 'Internet connection unavailable — could not reach OpenAI.').title).toBe('Internet connection unavailable');
  });

  it('other failures are unchanged', () => {
    const e = mapNetworkError(new Error('something odd'), { name: 'Ollama', baseUrl: 'http://localhost:11434/v1' });
    expect(e.message).toBe('Could not reach Ollama: something odd');
  });
});

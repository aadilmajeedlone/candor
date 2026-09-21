/**
 * Where a server is, from its address alone — so the app can tell the user whether a question stays on this PC, on
 * their own network, or crosses the internet, and can decide when plain http (no TLS) is acceptable.
 *
 * Only literal IP addresses and reserved names are classified as local. A public-looking host name is always
 * "internet", even if it happens to resolve to a private address, so a hostile name cannot pose as a local server.
 */
export type EndpointScope = 'this-pc' | 'private-network' | 'internet';

function ipv4(host: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const p = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] as [number, number, number, number];
  return p.every((n) => n <= 255) ? p : null;
}

export function endpointScope(url: string): EndpointScope {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return 'internet';
  }
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);

  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '0:0:0:0:0:0:0:1') return 'this-pc';
  const v4 = ipv4(host);
  if (v4) {
    const [a, b] = v4;
    if (a === 127) return 'this-pc';
    if (a === 10) return 'private-network';
    if (a === 192 && b === 168) return 'private-network';
    if (a === 172 && b >= 16 && b <= 31) return 'private-network';
    if (a === 169 && b === 254) return 'private-network'; // link-local
    if (a === 100 && b >= 64 && b <= 127) return 'private-network'; // carrier-grade NAT range, used by Tailscale
    return 'internet';
  }
  if (host.includes(':')) {
    // IPv6 literal: unique-local (fc00::/7) and link-local (fe80::/10).
    if (/^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)) return 'private-network';
    return 'internet';
  }
  // Reserved names: multicast DNS on the local network, and Tailscale's own encrypted network.
  if (host.endsWith('.local') || host.endsWith('.ts.net')) return 'private-network';
  return 'internet';
}

export const SCOPE_LABEL: Record<EndpointScope, string> = {
  'this-pc': 'This PC',
  'private-network': 'Your network',
  internet: 'Internet',
};

export const SCOPE_HINT: Record<EndpointScope, string> = {
  'this-pc': 'Runs on this computer: nothing you say leaves it.',
  'private-network': 'Runs on another computer on your own network (LAN or VPN): your questions travel there, not to the public internet.',
  internet: 'A service on the internet: your questions are sent to it, and it may charge for use.',
};

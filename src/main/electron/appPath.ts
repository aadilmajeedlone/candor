import { join, normalize, resolve, sep } from 'node:path';

/**
 * Map a request path under candor://app/ onto a file inside `root`. Returns null for anything that is malformed
 * or would leave the folder, so the protocol handler can answer 403 without touching the disk.
 */
export function resolveAppPath(root: string, pathname: string): string | null {
  let rel: string;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return null; // malformed percent-encoding
  }
  if (rel.includes('\0')) return null;
  if (rel === '/' || rel === '') rel = '/index.html';
  const base = resolve(root);
  const full = resolve(join(base, normalize(rel)));
  return full.startsWith(base + sep) ? full : null;
}

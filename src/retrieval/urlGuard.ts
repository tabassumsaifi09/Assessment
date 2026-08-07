import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export class UrlRejectedError extends Error {
  readonly code: string;

  constructor(message: string, code = 'URL_REJECTED') {
    super(message);
    this.name = 'UrlRejectedError';
    this.code = code;
  }
}

export interface UrlGuardOptions {
  /**
   * Permits loopback and private addresses. The batch entry point sets this
   * because company sites under evaluation may be served from localhost; in
   * production it stays false and this function is the SSRF guard.
   */
  allowPrivateNetwork: boolean;
}

const BLOCKED_PORTS = new Set([22, 23, 25, 445, 3306, 5432, 6379, 9200, 11211, 27017]);

/** Normalises and rejects anything we should not be fetching. */
export async function assertSafeUrl(raw: string, options: UrlGuardOptions): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new UrlRejectedError(`not a valid absolute URL: ${raw}`, 'URL_INVALID');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UrlRejectedError(`unsupported scheme ${url.protocol}`, 'URL_SCHEME');
  }
  if (url.username || url.password) {
    throw new UrlRejectedError('credentials in URL are not accepted', 'URL_CREDENTIALS');
  }
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  if (BLOCKED_PORTS.has(port)) {
    throw new UrlRejectedError(`port ${port} is not fetchable`, 'URL_PORT');
  }

  if (options.allowPrivateNetwork) return url;

  const addresses = await resolveAll(url.hostname);
  if (addresses.length === 0) {
    throw new UrlRejectedError(`host does not resolve: ${url.hostname}`, 'DNS_FAILED');
  }
  for (const address of addresses) {
    if (isPrivateAddress(address)) {
      throw new UrlRejectedError(
        `host ${url.hostname} resolves to a private address (${address})`,
        'URL_PRIVATE',
      );
    }
  }
  return url;
}

async function resolveAll(hostname: string): Promise<string[]> {
  if (isIP(hostname)) return [hostname];
  try {
    const records = await lookup(hostname, { all: true });
    return records.map((record) => record.address);
  } catch {
    return [];
  }
}

/** RFC1918, loopback, link-local, CGNAT, unique-local and mapped equivalents. */
export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isPrivateV4(address);
  if (version === 6) return isPrivateV6(address);
  return true;
}

function isPrivateV4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return true;
  const [a = 0, b = 0] = parts;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true; // multicast and reserved
  return false;
}

function isPrivateV6(address: string): boolean {
  const value = address.toLowerCase();
  if (value === '::1' || value === '::') return true;
  if (value.startsWith('fc') || value.startsWith('fd')) return true;
  if (value.startsWith('fe80')) return true;
  const mapped = value.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped?.[1]) return isPrivateV4(mapped[1]);
  return false;
}

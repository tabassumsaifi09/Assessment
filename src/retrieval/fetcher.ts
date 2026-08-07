import { assertSafeUrl, UrlRejectedError } from './urlGuard';
import { EMPTY_ROBOTS, isAllowed, parseRobots, type RobotsRules } from './robots';
import { parseHtml, type ParsedPage } from './html';
import { sleep, withTimeout } from '../util/async';
import { logger } from '../util/logger';

export interface FetchedPage {
  requestedUrl: string;
  url: string;
  status: number;
  contentType: string;
  bytes: number;
  body: string;
  parsed: ParsedPage;
}

export interface FetchFailure {
  url: string;
  code: string;
  message: string;
}

export type FetchResult =
  | { ok: true; page: FetchedPage }
  | { ok: false; error: FetchFailure };

export interface FetcherOptions {
  timeoutMs: number;
  maxBytes: number;
  crawlDelayMs: number;
  allowPrivateNetwork: boolean;
  userAgent?: string;
  /** robots.txt is advisory for XML sitemaps we fetch from robots itself. */
  respectRobots?: boolean;
}

const ALLOWED_CONTENT_TYPES = [
  'text/html',
  'application/xhtml+xml',
  'text/plain',
  'application/xml',
  'text/xml',
];

/**
 * One place where the open internet touches this application.
 *
 * Every request is guarded (scheme, port, private address), time-boxed,
 * content-type checked and byte-capped, redirects are followed manually so
 * each hop is re-validated, and per-host politeness plus robots.txt are
 * applied. Failures are returned, never thrown: a source that cannot be
 * retrieved is skipped and reported, and the run continues.
 */
export class PageFetcher {
  private readonly robotsCache = new Map<string, RobotsRules>();
  private readonly lastRequestAt = new Map<string, number>();
  private readonly cache = new Map<string, FetchResult>();
  readonly failures: FetchFailure[] = [];

  constructor(private readonly options: FetcherOptions) {}

  get userAgent(): string {
    return this.options.userAgent ?? 'interview-prep-kit/1.0 (+assessment project)';
  }

  /** Pages successfully retrieved during this fetcher's lifetime. */
  get fetchedUrls(): string[] {
    return [...this.cache.entries()]
      .filter(([, result]) => result.ok)
      .map(([url]) => url);
  }

  async fetchPage(rawUrl: string): Promise<FetchResult> {
    const cached = this.cache.get(rawUrl);
    if (cached) return cached;
    const result = await this.execute(rawUrl);
    this.cache.set(rawUrl, result);
    if (!result.ok) this.failures.push(result.error);
    return result;
  }

  private async execute(rawUrl: string): Promise<FetchResult> {
    let url: URL;
    try {
      url = await assertSafeUrl(rawUrl, {
        allowPrivateNetwork: this.options.allowPrivateNetwork,
      });
    } catch (error) {
      const code = error instanceof UrlRejectedError ? error.code : 'URL_REJECTED';
      return { ok: false, error: { url: rawUrl, code, message: (error as Error).message } };
    }

    if (this.options.respectRobots !== false) {
      const rules = await this.robotsFor(url);
      if (!isAllowed(rules, url.toString())) {
        return {
          ok: false,
          error: { url: rawUrl, code: 'ROBOTS_DISALLOWED', message: 'robots.txt disallows this path' },
        };
      }
      await this.waitForPoliteness(url.host, rules.crawlDelayMs);
    } else {
      await this.waitForPoliteness(url.host, null);
    }

    let current = url;
    for (let hop = 0; hop < 5; hop += 1) {
      let response: Response;
      try {
        response = await withTimeout(
          (signal) =>
            fetch(current, {
              signal,
              redirect: 'manual',
              headers: {
                'user-agent': this.userAgent,
                accept: 'text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.5',
                'accept-language': 'en',
              },
            }),
          this.options.timeoutMs,
          `fetch ${current.host}`,
        );
      } catch (error) {
        const timedOut = (error as Error).name === 'TimeoutError';
        return {
          ok: false,
          error: {
            url: current.toString(),
            code: timedOut ? 'FETCH_TIMEOUT' : 'FETCH_FAILED',
            message: (error as Error).message,
          },
        };
      }

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) {
          return {
            ok: false,
            error: { url: current.toString(), code: 'REDIRECT_INVALID', message: 'redirect without location' },
          };
        }
        let next: URL;
        try {
          next = new URL(location, current);
        } catch {
          return {
            ok: false,
            error: { url: current.toString(), code: 'REDIRECT_INVALID', message: `bad redirect target ${location}` },
          };
        }
        try {
          // Re-validate every hop: a redirect is an untrusted instruction.
          current = await assertSafeUrl(next.toString(), {
            allowPrivateNetwork: this.options.allowPrivateNetwork,
          });
        } catch (error) {
          return {
            ok: false,
            error: {
              url: next.toString(),
              code: 'REDIRECT_BLOCKED',
              message: (error as Error).message,
            },
          };
        }
        continue;
      }

      if (!response.ok) {
        return {
          ok: false,
          error: {
            url: current.toString(),
            code: `HTTP_${response.status}`,
            message: `${response.status} ${response.statusText}`.trim(),
          },
        };
      }

      const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
      if (contentType && !ALLOWED_CONTENT_TYPES.some((allowed) => contentType.includes(allowed))) {
        return {
          ok: false,
          error: {
            url: current.toString(),
            code: 'CONTENT_TYPE_REJECTED',
            message: `unsupported content-type ${contentType}`,
          },
        };
      }

      const declaredLength = Number(response.headers.get('content-length') ?? '0');
      if (declaredLength > this.options.maxBytes) {
        return {
          ok: false,
          error: {
            url: current.toString(),
            code: 'CONTENT_TOO_LARGE',
            message: `content-length ${declaredLength} exceeds ${this.options.maxBytes}`,
          },
        };
      }

      const body = await this.readCapped(response);
      if (body === null) {
        return {
          ok: false,
          error: {
            url: current.toString(),
            code: 'CONTENT_TOO_LARGE',
            message: `body exceeded ${this.options.maxBytes} bytes`,
          },
        };
      }

      const finalUrl = current.toString();
      return {
        ok: true,
        page: {
          requestedUrl: rawUrl,
          url: finalUrl,
          status: response.status,
          contentType,
          bytes: body.length,
          body,
          parsed: parseHtml(body, finalUrl),
        },
      };
    }

    return {
      ok: false,
      error: { url: rawUrl, code: 'TOO_MANY_REDIRECTS', message: 'redirect chain too long' },
    };
  }

  /** Streams the body and stops the moment it exceeds the cap. */
  private async readCapped(response: Response): Promise<string | null> {
    if (!response.body) return await response.text();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > this.options.maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
  }

  private async waitForPoliteness(host: string, robotsDelay: number | null): Promise<void> {
    const delay = Math.max(this.options.crawlDelayMs, robotsDelay ?? 0);
    if (delay <= 0) return;
    const last = this.lastRequestAt.get(host);
    const now = Date.now();
    if (last !== undefined) {
      const wait = delay - (now - last);
      if (wait > 0) await sleep(wait);
    }
    this.lastRequestAt.set(host, Date.now());
  }

  async robotsFor(url: URL): Promise<RobotsRules> {
    const key = url.origin;
    const cached = this.robotsCache.get(key);
    if (cached) return cached;
    let rules = EMPTY_ROBOTS;
    try {
      const response = await withTimeout(
        (signal) =>
          fetch(new URL('/robots.txt', url.origin), {
            signal,
            headers: { 'user-agent': this.userAgent },
          }),
        Math.min(this.options.timeoutMs, 5000),
        'fetch robots.txt',
      );
      if (response.ok) {
        const body = (await response.text()).slice(0, 100_000);
        rules = parseRobots(body);
      }
    } catch (error) {
      logger.debug(`robots.txt unavailable for ${key}`, { message: (error as Error).message });
    }
    this.robotsCache.set(key, rules);
    return rules;
  }
}

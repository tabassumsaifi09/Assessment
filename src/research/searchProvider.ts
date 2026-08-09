import { withTimeout } from '../util/async';
import { decode } from '../retrieval/html';
import { logger } from '../util/logger';

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchProvider {
  readonly name: string;
  search(query: string, limit: number): Promise<SearchHit[]>;
}

/**
 * Web search sits behind an interface for the same reason the model does: the
 * free options change. DuckDuckGo's HTML endpoint needs no key, Brave needs
 * one, and `none` disables the stage entirely. Every implementation returns
 * an empty list rather than throwing, because a failed search must degrade the
 * kit, not the run.
 */
export class DuckDuckGoProvider implements SearchProvider {
  readonly name = 'duckduckgo-html';

  constructor(private readonly timeoutMs = 8000) {}

  async search(query: string, limit: number): Promise<SearchHit[]> {
    try {
      const response = await withTimeout(
        (signal) =>
          fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
            signal,
            headers: {
              'user-agent': 'interview-prep-kit/1.0 (+assessment project)',
              accept: 'text/html',
            },
          }),
        this.timeoutMs,
        'search',
      );
      if (!response.ok) return [];
      const html = (await response.text()).slice(0, 400_000);
      return parseDuckDuckGoResults(html).slice(0, limit);
    } catch (error) {
      logger.debug('search failed', { query, message: (error as Error).message });
      return [];
    }
  }
}

export function parseDuckDuckGoResults(html: string): SearchHit[] {
  const hits: SearchHit[] = [];
  const pattern =
    /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]{0,600}?)(?=<a[^>]+class="[^"]*result__a|<\/div>\s*<\/div>\s*<\/div>|$)/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    const href = unwrapRedirect(decode(match[1]!));
    if (!href) continue;
    const title = decode(match[2]!.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    const snippet = decode(
      (match[3]!.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i)?.[1] ?? '').replace(
        /<[^>]+>/g,
        ' ',
      ),
    )
      .replace(/\s+/g, ' ')
      .trim();
    hits.push({ title, url: href, snippet });
  }
  return hits;
}

function unwrapRedirect(href: string): string | null {
  try {
    const url = new URL(href, 'https://duckduckgo.com');
    const target = url.searchParams.get('uddg');
    const resolved = target ? new URL(target) : url;
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null;
    if (/duckduckgo\.com/i.test(resolved.host)) return null;
    return resolved.toString();
  } catch {
    return null;
  }
}

export class BraveProvider implements SearchProvider {
  readonly name = 'brave';

  constructor(
    private readonly apiKey: string,
    private readonly timeoutMs = 8000,
  ) {}

  async search(query: string, limit: number): Promise<SearchHit[]> {
    try {
      const response = await withTimeout(
        (signal) =>
          fetch(
            `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`,
            { signal, headers: { accept: 'application/json', 'x-subscription-token': this.apiKey } },
          ),
        this.timeoutMs,
        'search',
      );
      if (!response.ok) return [];
      const payload = (await response.json()) as {
        web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
      };
      return (payload.web?.results ?? [])
        .filter((result) => Boolean(result.url))
        .map((result) => ({
          title: result.title ?? '',
          url: result.url!,
          snippet: (result.description ?? '').replace(/<[^>]+>/g, ''),
        }));
    } catch (error) {
      logger.debug('brave search failed', { message: (error as Error).message });
      return [];
    }
  }
}

export class NullSearchProvider implements SearchProvider {
  readonly name = 'disabled';

  async search(): Promise<SearchHit[]> {
    return [];
  }
}

export function createSearchProvider(provider: string, braveApiKey: string): SearchProvider {
  switch (provider) {
    case 'none':
      return new NullSearchProvider();
    case 'brave':
      return braveApiKey ? new BraveProvider(braveApiKey) : new NullSearchProvider();
    default:
      return new DuckDuckGoProvider();
  }
}

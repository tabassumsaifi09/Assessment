import type { PageFetcher, FetchedPage, FetchFailure } from '../retrieval/fetcher';
import { extractSitemapUrls } from '../retrieval/html';
import { rankLinks, type RankedLink } from './linkRanker';
import { logger } from '../util/logger';

export interface CrawledPage extends FetchedPage {
  depth: number;
  score: number;
  reasons: string[];
}

export interface CrawlResult {
  entryUrl: string | null;
  /** Set when the URL we were given failed and a variant was used instead. */
  entryFallbackFrom: string | null;
  pages: CrawledPage[];
  skipped: FetchFailure[];
  /** Links we ranked but had no budget to fetch - useful when explaining gaps. */
  consideredLinks: RankedLink[];
}

export interface CrawlOptions {
  maxPages: number;
  maxDepth: number;
  /** Fetch the sitemap when one is advertised; it often exposes buried pages. */
  useSitemap?: boolean;
}

/**
 * Breadth-first crawl driven by link scores rather than a path list.
 *
 * The frontier is a priority queue: after each page we re-rank everything we
 * have seen and fetch the most promising link next, so a hiring page three
 * clicks down a handbook still gets found while a pricing page never does.
 * Nothing here assumes a hostname, and every link is resolved relative to the
 * page it was found on, so a site served from http://localhost:8099/acme/
 * crawls exactly like a public one.
 */
export async function crawlSite(
  fetcher: PageFetcher,
  startUrl: string,
  options: CrawlOptions,
): Promise<CrawlResult> {
  const skipped: FetchFailure[] = [];
  const entry = await fetchEntryPoint(fetcher, startUrl, skipped);
  if (!entry) {
    return {
      entryUrl: null,
      entryFallbackFrom: null,
      pages: [],
      skipped,
      consideredLinks: [],
    };
  }
  const entryFallbackFrom =
    normalise(entry.requestedUrl) === normalise(startUrl) ? null : startUrl;

  const baseHost = new URL(entry.url).host;
  const visited = new Set<string>([normalise(entry.url), normalise(startUrl)]);
  const pages: CrawledPage[] = [
    { ...entry, depth: 0, score: 100, reasons: ['entry point'] },
  ];

  const frontier = new Map<string, RankedLink>();
  for (const link of rankLinks(entry.parsed.links, 1, baseHost)) {
    if (!visited.has(normalise(link.url))) frontier.set(normalise(link.url), link);
  }

  if (options.useSitemap !== false) {
    for (const link of await sitemapCandidates(fetcher, entry.url, baseHost)) {
      const key = normalise(link.url);
      if (!visited.has(key) && !frontier.has(key)) frontier.set(key, link);
    }
  }

  while (pages.length < options.maxPages && frontier.size > 0) {
    const next = bestCandidate(frontier);
    if (!next) break;
    frontier.delete(normalise(next.url));
    // Once the queue is down to links with no positive signal, stop: fetching
    // a company's press archive helps nobody and costs the run time.
    if (next.score <= 0 && pages.length > 1) break;
    if (next.depth > options.maxDepth) continue;

    visited.add(normalise(next.url));
    const result = await fetcher.fetchPage(next.url);
    if (!result.ok) {
      skipped.push(result.error);
      continue;
    }

    pages.push({
      ...result.page,
      depth: next.depth,
      score: next.score,
      reasons: next.reasons,
    });

    if (next.depth < options.maxDepth) {
      // Links found on a page that already looked like hiring material inherit
      // part of that relevance: an index page such as /handbook/people is
      // rarely the answer itself, but it is usually one click away from it.
      const inherited = next.intents.includes('hiring') ? 3 : 0;
      for (const link of rankLinks(result.page.parsed.links, next.depth + 1, baseHost)) {
        const key = normalise(link.url);
        if (visited.has(key) || frontier.has(key)) continue;
        const boosted =
          inherited > 0
            ? { ...link, score: link.score + inherited, reasons: [...link.reasons, 'linked from a hiring page'] }
            : link;
        if (boosted.score <= 0) continue;
        frontier.set(key, boosted);
      }
    }
  }

  return {
    entryUrl: entry.url,
    entryFallbackFrom,
    pages,
    skipped,
    consideredLinks: [...frontier.values()].sort((a, b) => b.score - a.score).slice(0, 20),
  };
}

function bestCandidate(frontier: Map<string, RankedLink>): RankedLink | undefined {
  let best: RankedLink | undefined;
  for (const link of frontier.values()) {
    if (!best || link.score > best.score || (link.score === best.score && link.depth < best.depth)) {
      best = link;
    }
  }
  return best;
}

function normalise(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    const path = parsed.pathname.replace(/\/+$/, '') || '/';
    return `${parsed.origin}${path}${parsed.search}`.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

/**
 * A company URL can be wrong in ordinary ways: a trailing path that 404s, the
 * wrong scheme, a missing www. Try a short list of variants before declaring
 * the site unreachable.
 */
async function fetchEntryPoint(
  fetcher: PageFetcher,
  startUrl: string,
  skipped: FetchFailure[],
): Promise<FetchedPage | null> {
  for (const candidate of entryCandidates(startUrl)) {
    const result = await fetcher.fetchPage(candidate);
    if (result.ok) return result.page;
    skipped.push(result.error);
    logger.debug(`entry point ${candidate} unusable`, result.error);
  }
  return null;
}

export function entryCandidates(startUrl: string): string[] {
  const raw = startUrl.trim();
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  const candidates: string[] = [withScheme];
  try {
    const url = new URL(withScheme);
    if (url.pathname !== '/' && url.pathname !== '') candidates.push(url.origin + '/');
    if (url.protocol === 'https:') {
      candidates.push(withScheme.replace(/^https:/i, 'http:'));
    } else {
      candidates.push(withScheme.replace(/^http:/i, 'https:'));
    }
    if (!url.hostname.startsWith('www.') && url.hostname.includes('.')) {
      candidates.push(`${url.protocol}//www.${url.host}${url.pathname}`);
    }
  } catch {
    /* handled by the URL guard when the candidate is fetched */
  }
  return [...new Set(candidates)];
}

async function sitemapCandidates(
  fetcher: PageFetcher,
  entryUrl: string,
  baseHost: string,
): Promise<RankedLink[]> {
  const origin = new URL(entryUrl).origin;
  const robots = await fetcher.robotsFor(new URL(entryUrl));
  const sitemapUrls = robots.sitemaps.length > 0 ? robots.sitemaps : [`${origin}/sitemap.xml`];
  const links: RankedLink[] = [];

  for (const sitemapUrl of sitemapUrls.slice(0, 2)) {
    const result = await fetcher.fetchPage(sitemapUrl);
    if (!result.ok) continue;
    const urls = extractSitemapUrls(result.page.body).slice(0, 200);
    const ranked = rankLinks(
      urls.map((url) => ({ url, text: '', internal: safeHost(url) === baseHost })),
      1,
      baseHost,
    );
    // Only the entries the sitemap suggests are worth a look; a sitemap can
    // list hundreds of pages and we have a budget of a dozen.
    links.push(...ranked.filter((link) => link.score > 4).slice(0, 8));
  }
  return links;
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

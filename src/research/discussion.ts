import type { SearchProvider, SearchHit } from './searchProvider';
import type { PageFetcher } from '../retrieval/fetcher';
import { normaliseWhitespace, truncate } from '../util/text';
import { logger } from '../util/logger';

export interface DiscussionSource {
  url: string;
  title: string;
  snippet: string;
  /** Whether we managed to read the page itself or only the search snippet. */
  retrieved: boolean;
}

export interface DiscussionResult {
  searched: boolean;
  queries: string[];
  sources: DiscussionSource[];
  notes: string[];
}

/** Places where people actually discuss interview processes. */
const DISCUSSION_HOSTS =
  /(reddit\.com|glassdoor\.[a-z.]+|teamblind\.com|blind\.com|levels\.fyi|news\.ycombinator\.com|medium\.com|dev\.to|substack\.com|quora\.com|indeed\.[a-z.]+|stackexchange\.com|interviewing\.io|hashnode|blogspot|wordpress\.com|github\.io)/i;

/**
 * Looks for public discussion of how a company interviews.
 *
 * This is best-effort by nature: search can be unavailable, and the sites that
 * host the discussion often disallow crawling, which the fetcher respects. A
 * dry run is a normal outcome and is reported as one - the kit says "nothing
 * found" rather than inventing a process.
 */
export async function findInterviewDiscussion(
  search: SearchProvider,
  fetcher: PageFetcher,
  company: string,
  options: { maxSources?: number; readPages?: boolean } = {},
): Promise<DiscussionResult> {
  const maxSources = options.maxSources ?? 3;
  const notes: string[] = [];

  if (!company.trim()) {
    return {
      searched: false,
      queries: [],
      sources: [],
      notes: ['No company name could be established, so no discussion search was run.'],
    };
  }
  if (search.name === 'disabled') {
    return {
      searched: false,
      queries: [],
      sources: [],
      notes: ['Public discussion search is disabled by configuration (SEARCH_PROVIDER=none).'],
    };
  }

  const queries = [
    `${company} interview process`,
    `${company} interview questions experience`,
  ];

  const hits: SearchHit[] = [];
  for (const query of queries) {
    const results = await search.search(query, 8);
    hits.push(...results);
    if (hits.length >= maxSources * 3) break;
  }

  const relevant = hits
    .filter((hit) => DISCUSSION_HOSTS.test(hit.url))
    .filter((hit, index, all) => all.findIndex((other) => other.url === hit.url) === index)
    .slice(0, maxSources);

  if (relevant.length === 0) {
    notes.push(
      hits.length === 0
        ? 'Web search returned nothing for this company, so no public discussion of the interview process was found.'
        : 'Search returned results, but none were from sites where interview processes are discussed.',
    );
    return { searched: true, queries, sources: [], notes };
  }

  const sources: DiscussionSource[] = [];
  for (const hit of relevant) {
    let snippet = normaliseWhitespace(hit.snippet);
    let retrieved = false;
    if (options.readPages !== false) {
      const result = await fetcher.fetchPage(hit.url);
      if (result.ok) {
        retrieved = true;
        const text = result.page.parsed.text;
        const sentences = text
          .split(/(?<=[.!?])\s+/)
          .filter((sentence) => /interview|process|round|take[- ]home|screen|onsite|offer/i.test(sentence))
          .slice(0, 6)
          .join(' ');
        if (sentences) snippet = normaliseWhitespace(sentences);
      } else {
        logger.debug('discussion source not retrievable', result.error);
        notes.push(`Could not read ${hit.url} (${result.error.code}); using the search snippet only.`);
      }
    }
    sources.push({
      url: hit.url,
      title: truncate(hit.title || hit.url, 140),
      snippet: truncate(snippet, 600),
      retrieved,
    });
  }

  return { searched: true, queries, sources, notes };
}

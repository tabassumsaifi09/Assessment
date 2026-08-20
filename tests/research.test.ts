import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureServer } from '../scripts/serve-fixture-site';
import { PageFetcher } from '../src/retrieval/fetcher';
import { crawlSite, entryCandidates } from '../src/research/crawler';
import { classifyPages } from '../src/research/hiringPage';
import { scoreLink } from '../src/research/linkRanker';
import { parseRobots, isAllowed } from '../src/retrieval/robots';
import { parseHtml } from '../src/retrieval/html';
import { researchCompany } from '../src/research/companyResearch';
import { NullSearchProvider } from '../src/research/searchProvider';
import { createLlmClient } from '../src/llm';
import { OfflineModelProvider } from '../src/llm/providers/offline';

let server: { url: string; close: () => Promise<void> };

beforeAll(async () => {
  server = await startFixtureServer(0);
});

afterAll(async () => {
  await server.close();
});

const fetcher = () =>
  new PageFetcher({
    timeoutMs: 5000,
    maxBytes: 1_000_000,
    crawlDelayMs: 0,
    allowPrivateNetwork: true,
  });

describe('link ranking', () => {
  it('prefers hiring wording over peripheral pages', () => {
    const hiring = scoreLink({ url: 'https://x.test/handbook/how-we-hire', text: 'How we hire', internal: true }, 1, 'x.test');
    const pricing = scoreLink({ url: 'https://x.test/pricing', text: 'Pricing', internal: true }, 1, 'x.test');
    const privacy = scoreLink({ url: 'https://x.test/legal/privacy', text: 'Privacy', internal: true }, 1, 'x.test');
    expect(hiring.score).toBeGreaterThan(pricing.score);
    expect(pricing.score).toBeGreaterThan(privacy.score);
    expect(hiring.intents).toContain('hiring');
  });

  it('recognises an off-site applicant tracker as a careers destination', () => {
    const ats = scoreLink({ url: 'https://boards.greenhouse.io/acme', text: 'Open roles', internal: false }, 1, 'acme.test');
    const random = scoreLink({ url: 'https://twitter.com/acme', text: 'Twitter', internal: false }, 1, 'acme.test');
    expect(ats.score).toBeGreaterThan(random.score);
  });

  it('penalises assets it cannot read', () => {
    const pdf = scoreLink({ url: 'https://x.test/careers/brochure.pdf', text: 'Careers brochure', internal: true }, 1, 'x.test');
    expect(pdf.score).toBeLessThan(0);
  });
});

describe('html handling', () => {
  it('resolves relative links against the page they were found on', () => {
    const page = parseHtml(
      '<a href="about.html">About</a><a href="/root.html">Root</a><a href="https://other.test/x">Other</a>',
      'http://127.0.0.1:8099/acme/handbook/',
    );
    const urls = page.links.map((link) => link.url);
    expect(urls).toContain('http://127.0.0.1:8099/acme/handbook/about.html');
    expect(urls).toContain('http://127.0.0.1:8099/root.html');
    expect(page.links.find((link) => link.url.includes('other.test'))?.internal).toBe(false);
  });

  it('keeps block boundaries so navigation does not merge into prose', () => {
    const page = parseHtml(
      '<nav><a href="/a">Home</a><a href="/b">Pricing</a></nav><p>We build robots for warehouses.</p>',
      'https://x.test/',
    );
    expect(page.text.split('\n')).toContain('We build robots for warehouses.');
  });
});

describe('robots.txt', () => {
  it('honours disallow rules and wildcards', () => {
    const rules = parseRobots('User-agent: *\nDisallow: /private/\nDisallow: /*.json$\nAllow: /private/public.html');
    expect(isAllowed(rules, 'https://x.test/private/secret.html')).toBe(false);
    expect(isAllowed(rules, 'https://x.test/private/public.html')).toBe(true);
    expect(isAllowed(rules, 'https://x.test/data/file.json')).toBe(false);
    expect(isAllowed(rules, 'https://x.test/about')).toBe(true);
  });
});

describe('crawling a company site', () => {
  it('finds a hiring page that lives inside a handbook, three links deep', async () => {
    const result = await crawlSite(fetcher(), `${server.url}/deeporg/`, { maxPages: 14, maxDepth: 3 });
    const classified = classifyPages(result.pages);
    const hiring = classified.filter((page) => page.kind === 'hiring');
    expect(hiring.map((page) => page.url).join(' ')).toContain('/handbook/people/interviewing.html');
  });

  it('finds a hiring page linked only from an about page', async () => {
    const result = await crawlSite(fetcher(), `${server.url}/acme/`, { maxPages: 14, maxDepth: 3 });
    const hiring = classifyPages(result.pages).filter((page) => page.kind === 'hiring');
    expect(hiring.map((page) => page.url).join(' ')).toContain('/acme/handbook/how-we-hire.html');
  });

  it('reports honestly when a site has no hiring page at all', async () => {
    const research = await researchCompany(
      fetcher(),
      createLlmClient(new OfflineModelProvider()),
      new NullSearchProvider(),
      `${server.url}/quietco/`,
      { maxPages: 10, maxDepth: 3 },
    );
    expect(research.reachable).toBe(true);
    expect(research.hiringPages).toHaveLength(0);
    expect(research.process.stages).toHaveLength(0);
    expect(research.notes.join(' ')).toMatch(/No hiring or careers page/i);
  });

  it('respects robots.txt while crawling', async () => {
    const result = await crawlSite(fetcher(), `${server.url}/deeporg/`, { maxPages: 14, maxDepth: 3 });
    expect(result.pages.map((page) => page.url).join(' ')).not.toContain('/private/');
  });

  it('records an unreachable site instead of throwing', async () => {
    const research = await researchCompany(
      fetcher(),
      createLlmClient(new OfflineModelProvider()),
      new NullSearchProvider(),
      'http://127.0.0.1:9/definitely-not-here/',
      { maxPages: 6, maxDepth: 2 },
    );
    expect(research.reachable).toBe(false);
    expect(research.skipped.length).toBeGreaterThan(0);
    expect(research.notes.join(' ')).toMatch(/No page could be retrieved/i);
  });

  it('tries sensible variants of a company URL before giving up', () => {
    const candidates = entryCandidates('https://acme.test/careers');
    expect(candidates[0]).toBe('https://acme.test/careers');
    expect(candidates).toContain('https://acme.test/');
  });

  it('does not assume a hostname: a locally served site crawls like any other', async () => {
    const result = await crawlSite(fetcher(), `${server.url}/acme/`, { maxPages: 6, maxDepth: 2 });
    expect(result.entryUrl).toContain('127.0.0.1');
    expect(result.pages.length).toBeGreaterThan(2);
  });
});

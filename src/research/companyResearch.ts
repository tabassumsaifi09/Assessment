import type { PageFetcher, FetchFailure } from '../retrieval/fetcher';
import type { LlmClient } from '../llm/client';
import type { SearchProvider } from './searchProvider';
import { crawlSite, type CrawlResult } from './crawler';
import { classifyPages, type ClassifiedPage } from './hiringPage';
import { findInterviewDiscussion, type DiscussionResult } from './discussion';
import { UNTRUSTED_SYSTEM_RULE, wrapUntrusted } from '../security/untrusted';
import { dedupe, truncate } from '../util/text';
import { logger } from '../util/logger';

export interface HiringProcess {
  stages: string[];
  signals: {
    take_home: boolean;
    system_design: boolean;
    pairing: boolean;
    values: boolean;
    recruiter_screen: boolean;
  };
  summary: string;
}

export const NO_HIRING_PROCESS: HiringProcess = {
  stages: [],
  signals: {
    take_home: false,
    system_design: false,
    pairing: false,
    values: false,
    recruiter_screen: false,
  },
  summary: 'No description of the interview process was found.',
};

export interface CompanyResearch {
  companyName: string;
  entryUrl: string | null;
  reachable: boolean;
  pages: ClassifiedPage[];
  hiringPages: ClassifiedPage[];
  aboutPages: ClassifiedPage[];
  process: HiringProcess;
  discussion: DiscussionResult;
  skipped: FetchFailure[];
  notes: string[];
}

export interface ResearchOptions {
  maxPages: number;
  maxDepth: number;
  companyNameHint?: string;
  onStage?: (stage: string, detail?: string) => void;
}

/**
 * Sequenced company research.
 *
 * crawl -> classify what came back -> read the hiring page if there is one ->
 * look for public discussion. Each step consumes the previous one's output,
 * and each one can come up empty without taking the run down with it. What
 * failed is recorded rather than smoothed over.
 */
export async function researchCompany(
  fetcher: PageFetcher,
  llm: LlmClient,
  search: SearchProvider,
  companyUrl: string,
  options: ResearchOptions,
): Promise<CompanyResearch> {
  const notes: string[] = [];

  options.onStage?.('crawl', `crawling ${companyUrl}`);
  const crawl: CrawlResult = await crawlSite(fetcher, companyUrl, {
    maxPages: options.maxPages,
    maxDepth: options.maxDepth,
  });

  if (crawl.entryFallbackFrom) {
    notes.push(
      `The URL supplied (${crawl.entryFallbackFrom}) could not be retrieved; ${crawl.entryUrl} was used instead.`,
    );
  }

  if (!crawl.entryUrl) {
    const companyName = options.companyNameHint?.trim() || hostToName(companyUrl);
    notes.push(
      `No page could be retrieved from ${companyUrl}. The kit is built from the job description alone.`,
    );
    options.onStage?.('crawl', 'company site unreachable');

    // The site is unreachable, but the company may still be discussed
    // publicly, so the search stage still runs.
    const discussion = await findInterviewDiscussion(search, fetcher, companyName);
    return {
      companyName,
      entryUrl: null,
      reachable: false,
      pages: [],
      hiringPages: [],
      aboutPages: [],
      process: NO_HIRING_PROCESS,
      discussion,
      skipped: crawl.skipped,
      notes: [...notes, ...discussion.notes],
    };
  }

  options.onStage?.('classify', `classifying ${crawl.pages.length} pages`);
  const classified = classifyPages(crawl.pages);
  const hiringPages = classified
    .filter((page) => page.kind === 'hiring')
    .sort((a, b) => b.confidence - a.confidence);
  const aboutPages = classified
    .filter((page) => page.kind === 'about')
    .sort((a, b) => b.confidence - a.confidence);

  const companyName =
    options.companyNameHint?.trim() ||
    deriveCompanyName(classified, crawl.entryUrl) ||
    hostToName(crawl.entryUrl);

  let process = NO_HIRING_PROCESS;
  if (hiringPages.length > 0) {
    options.onStage?.('hiring-process', `reading ${hiringPages[0]!.url}`);
    process = await summariseHiringProcess(llm, hiringPages);
    if (process.stages.length === 0) {
      notes.push(
        'A hiring page was found, but it does not describe the interview process in any detail.',
      );
    }
  } else {
    notes.push(
      `No hiring or careers page was discoverable on ${new URL(crawl.entryUrl).host} within ${options.maxPages} pages.`,
    );
    logger.info('no hiring page found', { url: crawl.entryUrl });
  }

  options.onStage?.('discussion', `searching public discussion for ${companyName}`);
  const discussion = await findInterviewDiscussion(search, fetcher, companyName);

  return {
    companyName,
    entryUrl: crawl.entryUrl,
    reachable: true,
    pages: classified,
    hiringPages,
    aboutPages,
    process,
    discussion,
    skipped: [...crawl.skipped, ...fetcher.failures.filter((failure) => !crawl.skipped.includes(failure))],
    notes: dedupe([...notes, ...discussion.notes]),
  };
}

async function summariseHiringProcess(
  llm: LlmClient,
  hiringPages: ClassifiedPage[],
): Promise<HiringProcess> {
  const pages = hiringPages.slice(0, 2).map((page) => ({
    url: page.url,
    title: page.title,
    text: truncate(page.text, 6000),
  }));

  const { value } = await llm.jsonOrFallback<HiringProcess>(
    {
      task: 'summarise_hiring_process',
      system: `You summarise how a company runs its interviews, using only the supplied pages. ${UNTRUSTED_SYSTEM_RULE} Answer as JSON: {"stages": string[], "signals": {"take_home": boolean, "system_design": boolean, "pairing": boolean, "values": boolean, "recruiter_screen": boolean}, "summary": string}. If a page does not describe the process, return empty stages and say so in the summary.`,
      user: pages
        .map((page) => wrapUntrusted(`hiring-page ${page.url}`, `${page.title}\n${page.text}`, 6000))
        .join('\n\n'),
      payload: { pages },
      label: 'hiring-process',
    },
    (value) => parseProcess(value),
    NO_HIRING_PROCESS,
  );
  return value;
}

function parseProcess(value: unknown): HiringProcess {
  if (typeof value !== 'object' || value === null) throw new Error('expected an object');
  const record = value as Record<string, unknown>;
  const stages = Array.isArray(record.stages)
    ? record.stages.filter((stage): stage is string => typeof stage === 'string')
    : [];
  const rawSignals = (record.signals ?? {}) as Record<string, unknown>;
  return {
    stages: stages.slice(0, 10),
    signals: {
      take_home: Boolean(rawSignals.take_home),
      system_design: Boolean(rawSignals.system_design),
      pairing: Boolean(rawSignals.pairing),
      values: Boolean(rawSignals.values),
      recruiter_screen: Boolean(rawSignals.recruiter_screen),
    },
    summary: typeof record.summary === 'string' ? record.summary : NO_HIRING_PROCESS.summary,
  };
}

function deriveCompanyName(pages: ClassifiedPage[], entryUrl: string): string {
  const homepage = pages.find((page) => page.url === entryUrl) ?? pages[0];
  const title = homepage?.title ?? '';
  if (!title) return '';
  // "Acme - We build things" / "Acme | Careers" -> "Acme"
  const [first] = title.split(/\s+[|–—-]\s+/);
  const candidate = (first ?? title).trim();
  if (candidate.length >= 2 && candidate.length <= 60) return candidate;
  return '';
}

export function hostToName(url: string): string {
  try {
    const { hostname, pathname } = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    if (hostname === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
      const segment = pathname.split('/').filter(Boolean)[0];
      if (segment) return titleiseSlug(segment);
      return hostname;
    }
    const parts = hostname.replace(/^www\./, '').split('.');
    return titleiseSlug(parts[0] ?? hostname);
  } catch {
    return '';
  }
}

function titleiseSlug(slug: string): string {
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

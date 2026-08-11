import type { LlmClient } from '../llm/client';
import type { CompanyBrief } from '../domain/types';
import type { CompanyResearch } from '../research/companyResearch';
import { UNTRUSTED_SYSTEM_RULE, wrapUntrusted } from '../security/untrusted';
import { dedupe, truncate } from '../util/text';

export interface BriefResult {
  brief: CompanyBrief;
  /** Grounded snippets reused by company-fit questions and flashcards. */
  facts: string[];
}

interface ModelBrief {
  summary: string;
  what_they_do: string;
  facts: string[];
}

/**
 * The brief is written from pages we actually retrieved, and `sources` is set
 * by code from those URLs - never by the model, which would happily invent a
 * plausible link. When nothing was retrievable the brief says so; an honest
 * empty brief is worth more than a fluent guess.
 */
export async function generateCompanyBrief(
  llm: LlmClient,
  research: CompanyResearch,
): Promise<BriefResult> {
  const pages = [...research.aboutPages, ...research.hiringPages, ...research.pages]
    .filter((page, index, all) => all.findIndex((other) => other.url === page.url) === index)
    .slice(0, 5)
    .map((page) => ({ url: page.url, title: page.title, text: truncate(page.text, 4000) }));

  const sources = dedupe([
    ...pages.map((page) => page.url),
    ...research.discussion.sources.map((source) => source.url),
  ]);

  if (pages.length === 0) {
    const summary = [
      `No pages could be retrieved from ${research.entryUrl ?? 'the company site'}.`,
      research.discussion.sources.length > 0
        ? `Public discussion was found on ${research.discussion.sources.length} source(s), summarised below.`
        : 'No public discussion of the company was found either.',
      'This brief is intentionally empty rather than guessed; prepare from the job description.',
    ].join(' ');
    return {
      brief: {
        summary,
        what_they_do: 'Not established - no company page could be read.',
        sources,
      },
      facts: [],
    };
  }

  const fallback: ModelBrief = {
    summary: `Researched ${pages.length} page(s) from ${research.entryUrl}. The summary could not be generated, so only the raw sources are listed.`,
    what_they_do: truncate(pages[0]?.text ?? '', 400),
    facts: [],
  };

  const { value } = await llm.jsonOrFallback<ModelBrief>(
    {
      task: 'company_brief',
      system:
        'You write a short factual brief about a company for an interview candidate, using only the supplied pages. ' +
        'If the pages do not say something, say that it is not stated. Do not invent products, funding, size or customers. ' +
        UNTRUSTED_SYSTEM_RULE +
        ' Reply as JSON: {"summary": string, "what_they_do": string, "facts": string[]}.',
      user: pages
        .map((page) => wrapUntrusted(`page ${page.url}`, `${page.title}\n${page.text}`, 4000))
        .join('\n\n'),
      payload: {
        company: research.companyName,
        pages,
        discussion: research.discussion.sources.map((source) => ({
          url: source.url,
          text: source.snippet,
        })),
      },
      label: 'company-brief',
    },
    validateBrief,
    fallback,
  );

  const processLine =
    research.process.stages.length > 0
      ? ` Their published hiring process: ${truncate(research.process.summary, 400)}`
      : ' No published description of their interview process was found on the site.';
  const discussionLine =
    research.discussion.sources.length > 0
      ? ` Public discussion was found on: ${research.discussion.sources.map((source) => source.url).join(', ')}.`
      : ' No public discussion of their interview process was found.';

  return {
    brief: {
      summary: truncate(`${value.summary}${processLine}${discussionLine}`, 1600),
      what_they_do: truncate(value.what_they_do, 800),
      sources,
    },
    facts: dedupe(value.facts).slice(0, 6),
  };
}

function validateBrief(raw: unknown): ModelBrief {
  if (typeof raw !== 'object' || raw === null) throw new Error('expected an object');
  const record = raw as Record<string, unknown>;
  const summary = typeof record.summary === 'string' ? record.summary.trim() : '';
  if (summary.length < 10) throw new Error('summary missing');
  return {
    summary,
    what_they_do:
      typeof record.what_they_do === 'string' && record.what_they_do.trim().length > 0
        ? record.what_they_do.trim()
        : 'Not stated on the pages retrieved.',
    facts: Array.isArray(record.facts)
      ? record.facts.filter((fact): fact is string => typeof fact === 'string')
      : [],
  };
}

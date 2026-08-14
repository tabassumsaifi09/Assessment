import type { BuildKitInput, Kit, Question, ResearchReport } from '../domain/types';
import type { LlmClient } from '../llm/client';
import type { SearchProvider } from '../research/searchProvider';
import { PageFetcher } from '../retrieval/fetcher';
import { researchCompany, hostToName } from '../research/companyResearch';
import { extractRole } from '../extraction/jdExtractor';
import { generateCompanyBrief } from '../generation/brief';
import { generateBatch, planQuestionBatches } from '../generation/questions';
import { generateFlashcards } from '../generation/flashcards';
import { closeCoverageGaps, nextQuestionId } from '../coverage/gapFiller';
import { checkCoverage } from '../coverage/checker';
import { buildSchedule, clampDays } from '../schedule/allocator';
import { validateKit } from '../validation/kitValidator';
import type { GenerationContext } from '../generation/context';
import type { ProgressReporter } from './stages';
import { dedupe, truncate } from '../util/text';
import { logger } from '../util/logger';

export class KitBuildError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'KitBuildError';
    this.code = code;
  }
}

export interface BuildKitDeps {
  llm: LlmClient;
  fetcher: PageFetcher;
  search: SearchProvider;
}

export interface BuildKitOptions {
  maxPages: number;
  maxDepth: number;
  maxCoveragePasses: number;
  /** Time after which the optional research steps are skipped. */
  researchBudgetMs?: number;
  onProgress?: ProgressReporter;
}

export interface BuildKitResult {
  kit: Kit;
  warnings: string[];
}

/**
 * The pipeline.
 *
 * Read the posting -> crawl the company -> classify what came back -> read the
 * hiring page if there is one -> look for public discussion -> write the brief
 * -> generate questions per category -> check coverage in code -> close the
 * gaps -> flashcards -> allocate the schedule in code -> validate.
 *
 * Each step consumes the previous step's output: the hiring process changes
 * which question categories are planned, the requirements decide which
 * batches exist, and the questions decide the schedule. Nothing is produced by
 * one prompt that returns everything at once.
 */
export async function buildKit(
  input: BuildKitInput,
  deps: BuildKitDeps,
  options: BuildKitOptions,
): Promise<BuildKitResult> {
  const startedAt = Date.now();
  const report = options.onProgress ?? (() => undefined);
  const warnings: string[] = [];

  report({ stage: 'validate-input', status: 'running' });
  const jd = (input.jd ?? '').trim();
  if (jd.length === 0) {
    throw new KitBuildError('JD_EMPTY', 'the job description is empty');
  }
  const days = clampDays(input.days);
  if (days !== input.days) {
    warnings.push(`days was adjusted from ${input.days} to ${days}.`);
  }
  report({ stage: 'validate-input', status: 'done', detail: `${jd.length} characters, ${days} days` });

  // --- 1. the posting -------------------------------------------------------
  report({ stage: 'extract-requirements', status: 'running' });
  const role = await extractRole(deps.llm, jd);
  report({
    stage: 'extract-requirements',
    status: 'done',
    detail: `${role.requirements.length} requirements (${role.requirements.filter((r) => r.priority === 'must').length} must)`,
  });

  // --- 2. the company -------------------------------------------------------
  report({ stage: 'crawl-company', status: 'running' });
  const research = await researchCompany(
    deps.fetcher,
    deps.llm,
    deps.search,
    input.company_url,
    {
      maxPages: options.maxPages,
      maxDepth: options.maxDepth,
      companyNameHint: hostToName(input.company_url),
      onStage: (stage, detail) => {
        if (stage === 'crawl') report({ stage: 'crawl-company', status: 'running', detail });
        if (stage === 'classify') report({ stage: 'classify-pages', status: 'done', detail });
        if (stage === 'hiring-process') report({ stage: 'hiring-process', status: 'running', detail });
        if (stage === 'discussion') report({ stage: 'public-discussion', status: 'running', detail });
      },
    },
  );
  report({
    stage: 'crawl-company',
    status: research.reachable ? 'done' : 'failed',
    detail: research.reachable
      ? `${research.pages.length} pages, ${research.hiringPages.length} hiring`
      : 'company site unreachable',
  });
  report({
    stage: 'hiring-process',
    status: research.hiringPages.length > 0 ? 'done' : 'skipped',
    detail: research.process.stages.length > 0 ? `${research.process.stages.length} stages` : 'not published',
  });
  report({
    stage: 'public-discussion',
    status: research.discussion.searched ? 'done' : 'skipped',
    detail: `${research.discussion.sources.length} sources`,
  });

  if (options.researchBudgetMs && Date.now() - startedAt > options.researchBudgetMs) {
    warnings.push('Research took longer than its budget; later research steps were skipped.');
  }

  // --- 3. the brief ---------------------------------------------------------
  report({ stage: 'company-brief', status: 'running' });
  const { brief, facts } = await generateCompanyBrief(deps.llm, research);
  report({ stage: 'company-brief', status: 'done' });

  const context: GenerationContext = {
    company: research.companyName,
    companyUrl: input.company_url,
    seniority: role.seniority,
    facts,
    process: research.process,
    thin: role.thin,
  };

  // --- 4. questions, one call per category batch ----------------------------
  report({ stage: 'generate-questions', status: 'running' });
  const batches = planQuestionBatches(role.requirements, context);
  const firstPass: Question[] = [];
  for (const batch of batches) {
    const generated = await generateBatch(deps.llm, batch, context);
    for (const question of generated) {
      firstPass.push({ ...question, id: nextQuestionId(firstPass) });
    }
  }
  report({
    stage: 'generate-questions',
    status: 'done',
    detail: `${firstPass.length} questions from ${batches.length} batches`,
  });

  // --- 5. coverage, in code, with a second pass -----------------------------
  report({ stage: 'coverage-check', status: 'running' });
  const gapResult = await closeCoverageGaps(deps.llm, role.requirements, firstPass, context, {
    maxPasses: options.maxCoveragePasses,
    onPass: (pass, uncovered) =>
      report({
        stage: 'coverage-check',
        status: 'running',
        detail: `pass ${pass}: ${uncovered} uncovered`,
      }),
  });
  const questions = gapResult.questions;
  const coverage = checkCoverage(role.requirements, questions);
  report({
    stage: 'coverage-check',
    status: 'done',
    detail: `${coverage.coveredCount}/${coverage.totalCount} covered after ${gapResult.passes} pass(es)`,
  });
  warnings.push(...gapResult.notes);

  // --- 6. flashcards --------------------------------------------------------
  report({ stage: 'flashcards', status: 'running' });
  const flashcards = await generateFlashcards(deps.llm, role.requirements, context);
  report({ stage: 'flashcards', status: 'done', detail: `${flashcards.length} cards` });

  // --- 7. schedule, in code -------------------------------------------------
  report({ stage: 'schedule', status: 'running' });
  const schedule = buildSchedule({
    daysAvailable: days,
    questions,
    requirements: role.requirements,
  });
  report({ stage: 'schedule', status: 'done', detail: `${schedule.days.length} days` });

  // --- 8. assemble and validate --------------------------------------------
  const pagesUsed = dedupe([
    ...research.pages.map((page) => page.url),
    ...research.discussion.sources.filter((source) => source.retrieved).map((source) => source.url),
  ]);

  const researchReport: ResearchReport = {
    hiring_page_found: research.hiringPages.length > 0,
    hiring_pages: research.hiringPages.map((page) => page.url),
    about_pages: research.aboutPages.map((page) => page.url),
    discussion_sources: research.discussion.sources.map((source) => source.url),
    discussion_searched: research.discussion.searched,
    skipped_sources: research.skipped.map((failure) => ({
      url: failure.url,
      reason: `${failure.code}: ${failure.message}`,
    })),
    notes: dedupe([...research.notes, ...role.notes, ...gapResult.notes]),
  };

  const kit: Kit = {
    source: {
      company: research.companyName,
      company_url: input.company_url,
      role: role.title,
      location: role.location,
      jd_chars: jd.length,
      researched_at: new Date().toISOString(),
      pages_used: pagesUsed,
    },
    company_brief: brief,
    role: {
      title: role.title,
      seniority: role.seniority,
      responsibilities: role.responsibilities.map((item) => truncate(item, 300)),
      requirements: role.requirements,
    },
    questions,
    flashcards,
    schedule,
    coverage: {
      uncovered_requirement_ids: coverage.uncovered.map((requirement) => requirement.id),
      passes: gapResult.passes,
    },
    research: researchReport,
  };

  report({ stage: 'validate-kit', status: 'running' });
  const validation = validateKit(kit);
  if (!validation.valid) {
    logger.error('kit failed structural validation', validation.errors.slice(0, 5));
    report({ stage: 'validate-kit', status: 'failed' });
    throw new KitBuildError(
      'KIT_INVALID',
      `generated kit failed structural validation: ${validation.errors
        .slice(0, 3)
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  report({ stage: 'validate-kit', status: 'done' });

  return {
    kit,
    warnings: dedupe([...warnings, ...validation.warnings.map((issue) => `${issue.path}: ${issue.message}`)]),
  };
}

import type {
  ItemState,
  Kit,
  KitDocument,
  Question,
  QuestionCategory,
} from '../domain/types';
import type { BuildKitDeps, BuildKitOptions } from './buildKit';
import { researchCompany, hostToName } from '../research/companyResearch';
import { generateCompanyBrief } from '../generation/brief';
import { generateBatch, planQuestionBatches } from '../generation/questions';
import { closeCoverageGaps, nextQuestionId } from '../coverage/gapFiller';
import { checkCoverage } from '../coverage/checker';
import { buildSchedule } from '../schedule/allocator';
import { validateKit } from '../validation/kitValidator';
import type { GenerationContext } from '../generation/context';
import { logger } from '../util/logger';

export type RegenerateTarget =
  | { section: 'company_brief' }
  | { section: 'questions'; category: QuestionCategory }
  | { section: 'schedule' };

export interface RegenerateResult {
  kit: Kit;
  itemState: Record<string, ItemState>;
  preserved: string[];
  notes: string[];
}

/**
 * Regenerating one section without losing work elsewhere.
 *
 * The rule is simple and lives in one place: an item is *ours* to replace only
 * while its state is `generated` and it is not pinned. Anything the user wrote
 * (`manual`) or changed (`edited`), and anything they pinned, survives a
 * regeneration of its own section - the model is asked to fill what is left,
 * not to redo the lot.
 *
 * Sections the user did not ask for are never touched. The schedule is the one
 * exception: it is a pure function of the questions, so when the question set
 * changes it is recomputed - unless the user pinned it, in which case the
 * existing days are kept and only ids that no longer exist are dropped.
 */
export async function regenerateSection(
  document: KitDocument,
  target: RegenerateTarget,
  deps: BuildKitDeps,
  options: BuildKitOptions,
): Promise<RegenerateResult> {
  const kit = document.kit;
  if (!kit) throw new Error('cannot regenerate a kit that has not been generated yet');

  const itemState = { ...document.item_state };
  const preserved: string[] = [];
  const notes: string[] = [];

  const isProtected = (id: string): boolean => {
    const state = itemState[id];
    if (!state) return false;
    return state.pinned || state.origin === 'edited' || state.origin === 'manual';
  };

  if (target.section === 'company_brief') {
    if (isProtected('company_brief')) {
      notes.push('The company brief was edited or pinned, so it was left untouched.');
      return { kit, itemState, preserved: ['company_brief'], notes };
    }
    const research = await researchCompany(deps.fetcher, deps.llm, deps.search, kit.source.company_url, {
      maxPages: options.maxPages,
      maxDepth: options.maxDepth,
      companyNameHint: kit.source.company || hostToName(kit.source.company_url),
    });
    const { brief } = await generateCompanyBrief(deps.llm, research);
    return {
      kit: { ...kit, company_brief: brief },
      itemState,
      preserved,
      notes: ['The company brief was regenerated from a fresh crawl.'],
    };
  }

  if (target.section === 'schedule') {
    const schedule = buildSchedule({
      daysAvailable: kit.schedule.days_available,
      questions: kit.questions,
      requirements: kit.role.requirements,
    });
    return { kit: { ...kit, schedule }, itemState, preserved, notes: ['The schedule was reallocated.'] };
  }

  // --- questions in one category -------------------------------------------
  const category = target.category;
  const keptInCategory = kit.questions.filter(
    (question) => question.category === category && isProtected(question.id),
  );
  const untouched = kit.questions.filter((question) => question.category !== category);
  preserved.push(...keptInCategory.map((question) => question.id));

  const context: GenerationContext = {
    company: kit.source.company,
    companyUrl: kit.source.company_url,
    seniority: kit.role.seniority,
    facts: [],
    // The process signals are re-derived cheaply from the stored brief rather
    // than re-crawling: regeneration of one category should be fast.
    process: {
      stages: [],
      signals: {
        take_home: /take[- ]home/i.test(kit.company_brief.summary),
        system_design: /system design/i.test(kit.company_brief.summary),
        pairing: /pair(ing)?/i.test(kit.company_brief.summary),
        values: /values/i.test(kit.company_brief.summary),
        recruiter_screen: /recruiter/i.test(kit.company_brief.summary),
      },
      summary: kit.company_brief.summary,
    },
    thin: kit.role.requirements.length <= 2,
  };

  // Only requirements this category is responsible for, minus the ones the
  // preserved questions already cover.
  const alreadyCovered = new Set(keptInCategory.flatMap((question) => question.requirement_ids));
  const plan = planQuestionBatches(kit.role.requirements, context)
    .filter((batch) => batch.category === category)
    .map((batch) => ({
      ...batch,
      requirements: batch.requirements.filter((requirement) => !alreadyCovered.has(requirement.id)),
    }))
    .filter((batch) => batch.requirements.length > 0);

  const regenerated: Question[] = [...untouched, ...keptInCategory];
  for (const batch of plan) {
    const generated = await generateBatch(deps.llm, batch, context);
    for (const question of generated) {
      const id = nextQuestionId([...regenerated, ...kit.questions]);
      regenerated.push({ ...question, id });
      itemState[id] = { origin: 'generated', pinned: false, pass: 1 };
    }
  }

  // Dropped questions lose their state entry; kept ones keep theirs.
  const liveIds = new Set(regenerated.map((question) => question.id));
  for (const id of Object.keys(itemState)) {
    if (id.startsWith('q') && !liveIds.has(id)) delete itemState[id];
  }

  const gapResult = await closeCoverageGaps(deps.llm, kit.role.requirements, regenerated, context, {
    maxPasses: options.maxCoveragePasses,
  });
  for (const question of gapResult.questions) {
    if (!itemState[question.id]) {
      itemState[question.id] = { origin: 'generated', pinned: false, pass: gapResult.passes };
    }
  }

  const coverage = checkCoverage(kit.role.requirements, gapResult.questions);
  const scheduleIsPinned = isProtected('schedule');
  const schedule = scheduleIsPinned
    ? pruneSchedule(kit, gapResult.questions)
    : buildSchedule({
        daysAvailable: kit.schedule.days_available,
        questions: gapResult.questions,
        requirements: kit.role.requirements,
      });
  if (scheduleIsPinned) notes.push('The schedule was pinned, so only stale question ids were removed.');

  const next: Kit = {
    ...kit,
    questions: gapResult.questions,
    schedule,
    coverage: {
      uncovered_requirement_ids: coverage.uncovered.map((requirement) => requirement.id),
      passes: gapResult.passes,
    },
  };

  const validation = validateKit(next);
  if (!validation.valid) {
    logger.error('regenerated kit failed validation', validation.errors.slice(0, 3));
    throw new Error(
      `regeneration produced an invalid kit: ${validation.errors[0]?.path} ${validation.errors[0]?.message}`,
    );
  }

  return {
    kit: next,
    itemState,
    preserved,
    notes: [
      ...notes,
      `${preserved.length} edited or pinned question(s) in ${category} were preserved.`,
      ...gapResult.notes,
    ],
  };
}

/** Keeps a pinned schedule but drops ids for questions that no longer exist. */
function pruneSchedule(kit: Kit, questions: Question[]): Kit['schedule'] {
  const live = new Set(questions.map((question) => question.id));
  return {
    ...kit.schedule,
    days: kit.schedule.days.map((day) => ({
      ...day,
      question_ids: day.question_ids.filter((id) => live.has(id)),
    })),
  };
}

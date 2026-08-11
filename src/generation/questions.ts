import type { LlmClient } from '../llm/client';
import type { Question, QuestionCategory, Requirement } from '../domain/types';
import { QUESTION_CATEGORIES } from '../domain/types';
import { SYSTEM_DESIGN_MARKERS } from '../domain/lexicon';
import type { GenerationContext } from './context';
import { UNTRUSTED_SYSTEM_RULE, wrapUntrusted } from '../security/untrusted';
import { truncate } from '../util/text';
import { logger } from '../util/logger';

export interface QuestionBatch {
  category: QuestionCategory;
  requirements: Requirement[];
  /** Questions to ask per requirement in this batch. */
  perRequirement: number;
}

const BATCH_SIZE = 4;

/**
 * Decides which categories a requirement earns.
 *
 * "Five years of React" and "mentoring junior engineers" must not come from
 * the same call with the same instructions, so the plan splits requirements by
 * kind first and the generator issues one call per category batch. What the
 * company publishes about its process feeds in here too: a documented system
 * design round adds a system-design batch that a posting alone would not.
 */
export function planQuestionBatches(
  requirements: Requirement[],
  context: GenerationContext,
): QuestionBatch[] {
  const byCategory = new Map<QuestionCategory, Requirement[]>(
    QUESTION_CATEGORIES.map((category) => [category, []]),
  );

  for (const requirement of requirements) {
    switch (requirement.kind) {
      case 'behavioural':
        byCategory.get('behavioural')!.push(requirement);
        break;
      case 'domain':
        byCategory.get('company-fit')!.push(requirement);
        break;
      default:
        byCategory.get('technical')!.push(requirement);
        if (SYSTEM_DESIGN_MARKERS.test(requirement.text)) {
          byCategory.get('system-design')!.push(requirement);
        }
    }
  }

  // Seniority earns a design round even when no single requirement mentions
  // architecture - but two questions, not one per requirement.
  const designed = byCategory.get('system-design')!;
  if (isSeniorEnoughForDesign(context.seniority) && designed.length < 2) {
    const technicalMusts = byCategory
      .get('technical')!
      .filter((requirement) => requirement.priority === 'must' && !designed.includes(requirement));
    designed.push(...technicalMusts.slice(0, 2 - designed.length));
  }
  // More than a handful of design questions is noise, whatever the posting says.
  byCategory.set('system-design', designed.slice(0, 4));

  // A published system-design round means the candidate will face one whether
  // or not the posting mentions architecture.
  if (context.process.signals.system_design && byCategory.get('system-design')!.length === 0) {
    const technical = byCategory.get('technical')!.filter((requirement) => requirement.priority === 'must');
    byCategory.get('system-design')!.push(...technical.slice(0, 2));
  }
  // Likewise a values or culture round earns company-fit questions.
  if (
    (context.process.signals.values || context.facts.length > 0) &&
    byCategory.get('company-fit')!.length === 0
  ) {
    const anchor = requirements.filter((requirement) => requirement.priority === 'must').slice(0, 2);
    byCategory.get('company-fit')!.push(...(anchor.length > 0 ? anchor : requirements.slice(0, 1)));
  }

  const batches: QuestionBatch[] = [];
  for (const category of QUESTION_CATEGORIES) {
    const items = byCategory.get(category) ?? [];
    for (let index = 0; index < items.length; index += BATCH_SIZE) {
      batches.push({
        category,
        requirements: items.slice(index, index + BATCH_SIZE),
        perRequirement: category === 'technical' ? 2 : 1,
      });
    }
  }
  return batches;
}

function isSeniorEnoughForDesign(seniority: string): boolean {
  return ['senior', 'staff', 'principal', 'lead', 'leadership'].includes(seniority.toLowerCase());
}

interface ModelQuestion {
  requirement_ids: string[];
  category: string;
  prompt: string;
  answer_outline: string;
  difficulty: number;
}

/** One model call. Returns questions without ids; the caller numbers them. */
export async function generateBatch(
  llm: LlmClient,
  batch: QuestionBatch,
  context: GenerationContext,
): Promise<Omit<Question, 'id'>[]> {
  const validIds = new Set(batch.requirements.map((requirement) => requirement.id));

  const { value } = await llm.jsonOrFallback<ModelQuestion[]>(
    {
      task: 'generate_questions',
      system: buildSystemPrompt(batch.category, context),
      user: [
        `Company: ${context.company || 'unknown'}`,
        context.process.stages.length > 0
          ? wrapUntrusted('published-hiring-process', context.process.stages.join('\n'), 2000)
          : 'Published hiring process: none found.',
        'Requirements to cover, each with the id you must reference:',
        batch.requirements
          .map((requirement) => `- ${requirement.id} [${requirement.priority}] ${requirement.text}`)
          .join('\n'),
        `Return JSON: {"questions": [{"requirement_ids": string[], "category": "${batch.category}", "prompt": string, "answer_outline": string, "difficulty": 1|2|3}]}`,
      ].join('\n\n'),
      payload: {
        category: batch.category,
        requirements: batch.requirements,
        company: context.company,
        process_signals: context.process.signals,
        per_requirement: batch.perRequirement,
      },
      label: `questions:${batch.category}`,
    },
    (raw) => validateQuestions(raw, batch.category),
    [],
  );

  const questions: Omit<Question, 'id'>[] = [];
  for (const candidate of value) {
    const requirementIds = candidate.requirement_ids.filter((id) => validIds.has(id));
    if (requirementIds.length === 0) {
      // A question that references nothing we asked about cannot be scored
      // for coverage, so anchor it to the batch's first requirement.
      const anchor = batch.requirements[0];
      if (!anchor) continue;
      requirementIds.push(anchor.id);
    }
    const prompt = candidate.prompt.trim();
    if (prompt.length < 12) continue;
    questions.push({
      requirement_ids: [...new Set(requirementIds)],
      category: batch.category,
      prompt: truncate(prompt, 600),
      answer_outline: truncate((candidate.answer_outline ?? '').trim(), 900),
      difficulty: clampDifficulty(candidate.difficulty),
    });
  }

  if (questions.length === 0) {
    logger.info(`no usable questions returned for ${batch.category}; the gap pass will cover it`);
  }
  return questions;
}

function buildSystemPrompt(category: QuestionCategory, context: GenerationContext): string {
  const shared = `You write interview questions for one category only: ${category}. Every question must reference the ids of the requirements it covers. ${UNTRUSTED_SYSTEM_RULE} Reply with JSON only.`;
  switch (category) {
    case 'technical':
      return `${shared} Ask about mechanism and trade-offs in the named technology, not trivia. Difficulty 3 is reserved for questions that need production experience.`;
    case 'system-design':
      return `${shared} Ask the candidate to design or scale something implied by the requirement. State the constraint you want them to discover.`;
    case 'behavioural':
      return `${shared} Ask for a specific past situation. No hypotheticals, no "how would you feel" questions.`;
    default:
      return `${shared} Ask what connects the candidate to ${context.company || 'this company'} and to how it works. Ground the question in a fact from the research, never in a guess.`;
  }
}

function validateQuestions(raw: unknown, category: QuestionCategory): ModelQuestion[] {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as Record<string, unknown> | null)?.questions)
      ? ((raw as Record<string, unknown>).questions as unknown[])
      : null;
  if (!list) throw new Error('expected {"questions": [...]}');

  const questions = list
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map((item) => ({
      requirement_ids: Array.isArray(item.requirement_ids)
        ? item.requirement_ids.filter((id): id is string => typeof id === 'string')
        : [],
      category: typeof item.category === 'string' ? item.category : category,
      prompt: typeof item.prompt === 'string' ? item.prompt : '',
      answer_outline: typeof item.answer_outline === 'string' ? item.answer_outline : '',
      difficulty: typeof item.difficulty === 'number' ? item.difficulty : 2,
    }))
    .filter((item) => item.prompt.trim().length > 0);

  if (questions.length === 0) throw new Error('no usable questions in reply');
  return questions;
}

export function clampDifficulty(value: unknown): number {
  const parsed = Math.round(Number(value));
  if (!Number.isFinite(parsed)) return 2;
  return Math.min(3, Math.max(1, parsed));
}

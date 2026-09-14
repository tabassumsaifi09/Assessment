import type { LlmClient } from '../llm/client';
import type { Question, QuestionCategory, Requirement } from '../domain/types';
import type { GenerationContext } from '../generation/context';
import { generateBatch, planQuestionBatches } from '../generation/questions';
import { checkCoverage, type CoverageReport } from './checker';
import { truncate } from '../util/text';
import { logger } from '../util/logger';

export interface GapFillResult {
  questions: Question[];
  passes: number;
  report: CoverageReport;
  notes: string[];
}

export interface GapFillOptions {
  /** Total generation passes allowed, including the first draft. */
  maxPasses: number;
  onPass?: (pass: number, uncovered: number) => void;
}

/**
 * The second pass.
 *
 * After the first draft, coverage is checked in code; every requirement with
 * no question against it comes back as a gap, and the gaps - and only the gaps
 * - are sent back to the model. Then it checks again. We stop when coverage is
 * clean, when a pass adds nothing new (the model has said all it has to say),
 * or at MAX_COVERAGE_PASSES.
 *
 * Anything still uncovered at that point is closed in code by deriving a
 * question directly from the requirement text. It is a blunt instrument, but a
 * kit that ships with an uncovered must-have has failed at its one job, and a
 * plainly-worded question beats a hole.
 */
export async function closeCoverageGaps(
  llm: LlmClient,
  requirements: Requirement[],
  initialQuestions: Question[],
  context: GenerationContext,
  options: GapFillOptions,
): Promise<GapFillResult> {
  const questions = [...initialQuestions];
  const notes: string[] = [];
  let passes = 1;
  let report = checkCoverage(requirements, questions);
  options.onPass?.(passes, report.uncovered.length);

  while (report.uncovered.length > 0 && passes < options.maxPasses) {
    passes += 1;
    // Must-haves first: if the model only has one useful pass in it, it should
    // spend it on the requirements that decide the interview.
    const targets = [...report.uncoveredMust, ...report.uncoveredNice];
    logger.info(`coverage pass ${passes}: ${targets.length} requirement(s) uncovered`);

    const batches = planQuestionBatches(targets, context);
    const before = questions.length;

    for (const batch of batches) {
      const generated = await generateBatch(llm, batch, context);
      for (const question of generated) {
        questions.push({ ...question, id: nextQuestionId(questions) });
      }
    }

    report = checkCoverage(requirements, questions);
    options.onPass?.(passes, report.uncovered.length);

    if (questions.length === before) {
      notes.push(`Coverage pass ${passes} produced no new questions; stopping the loop.`);
      break;
    }
  }

  if (report.uncovered.length > 0) {
    for (const requirement of report.uncovered) {
      questions.push({
        ...synthesiseQuestion(requirement, context),
        id: nextQuestionId(questions),
      });
    }
    notes.push(
      `${report.uncovered.length} requirement(s) were still uncovered after ${passes} pass(es); ` +
        'questions for them were derived directly from the requirement text.',
    );
    report = checkCoverage(requirements, questions);
  }

  return { questions, passes, report, notes };
}

export function nextQuestionId(questions: Array<{ id: string }>): string {
  let highest = 0;
  for (const question of questions) {
    const match = /^q(\d+)$/.exec(question.id);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `q${highest + 1}`;
}

/** Code-authored fallback question - deterministic, grounded, never invented. */
export function synthesiseQuestion(
  requirement: Requirement,
  context: GenerationContext,
): Omit<Question, 'id'> {
  const category: QuestionCategory =
    requirement.kind === 'behavioural'
      ? 'behavioural'
      : requirement.kind === 'domain'
        ? 'company-fit'
        : 'technical';

  const text = truncate(requirement.text, 160);
  const prompt =
    category === 'behavioural'
      ? `Tell me about a specific time you demonstrated: "${text}". What was the situation, what did you do, and what came of it?`
      : category === 'company-fit'
        ? `The role calls for "${text}". How does that connect to what ${context.company || 'this company'} does, and where would you apply it first?`
        : `The posting requires "${text}". Take us through your experience with it: what you built, the trade-offs you made, and how you verified it worked.`;

  return {
    requirement_ids: [requirement.id],
    category,
    prompt,
    answer_outline:
      'Answer with one concrete example rather than a general description. Name the system, your part in it, ' +
      'the decision you made and what it cost, then finish with the outcome you can measure.',
    difficulty: requirement.priority === 'must' ? 2 : 1,
  };
}

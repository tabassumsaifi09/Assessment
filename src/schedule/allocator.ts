import type { Question, Requirement, Schedule, ScheduleDay } from '../domain/types';
import { tokenise, truncate } from '../util/text';

export interface ScheduleOptions {
  daysAvailable: number;
  questions: Question[];
  requirements: Requirement[];
  /** Session length target used to size a day before front-loading. */
  minutesPerDay?: number;
  /**
   * Optional per-question weakness weight (0..1) from the readiness report.
   * When present it outranks difficulty, so a re-plan puts the material the
   * user is shakiest on at the front. Everything else about the allocation is
   * unchanged, which keeps the guarantees above intact.
   */
  weakness?: Record<string, number>;
}

const MINUTES_BY_DIFFICULTY: Record<number, number> = { 1: 10, 2: 15, 3: 20 };
const MIN_DAY_MINUTES = 20;
const MAX_DAY_MINUTES = 240;
export const MAX_DAYS = 365;

/**
 * Schedule allocation. Arithmetic, so it belongs in code.
 *
 * Rules, in order of precedence:
 *  1. the schedule has exactly the number of days requested;
 *  2. every question is allocated to some day, so every covered requirement -
 *     and therefore every must-have - appears in the schedule;
 *  3. harder and higher-priority material lands earlier, because the night
 *     before the interview is not when you want to meet a system design
 *     question for the first time;
 *  4. when there are more days than material, the surplus becomes spaced
 *     review of the material that matters most, rather than empty days.
 *
 * Minutes are integers throughout: estimated from difficulty, then scaled to
 * the front-loaded shape of the plan.
 */
export function buildSchedule(options: ScheduleOptions): Schedule {
  const daysAvailable = clampDays(options.daysAvailable);
  const ordered = orderQuestions(options.questions, options.requirements, options.weakness);
  const minutesFor = (question: Question) => estimateMinutes(question, options.requirements);
  const describe = (questionIds: string[], review: boolean) =>
    focusFor(questionIds, options.questions, options.requirements, review);

  if (ordered.length === 0) {
    return {
      days_available: daysAvailable,
      days: Array.from({ length: daysAvailable }, (_, index) => ({
        day: index + 1,
        focus:
          'No questions could be generated from this posting - re-read the description and add your own.',
        question_ids: [],
        minutes: 30,
      })),
    };
  }

  const days: ScheduleDay[] =
    ordered.length >= daysAvailable
      ? packDenseSchedule(ordered, daysAvailable, minutesFor, describe)
      : packSparseSchedule(ordered, daysAvailable, minutesFor, describe);

  return {
    days_available: daysAvailable,
    days: days.map((day, index) => ({
      ...day,
      day: index + 1,
      minutes: clampMinutes(day.minutes),
      focus: truncate(day.focus, 160),
    })),
  };
}

export function clampDays(days: number): number {
  const rounded = Math.round(Number(days));
  if (!Number.isFinite(rounded) || rounded < 1) return 1;
  return Math.min(MAX_DAYS, rounded);
}

function clampMinutes(minutes: number): number {
  const value = Math.round(minutes);
  if (!Number.isFinite(value)) return MIN_DAY_MINUTES;
  return Math.min(MAX_DAY_MINUTES, Math.max(MIN_DAY_MINUTES, value));
}

export function estimateMinutes(question: Question, requirements: Requirement[]): number {
  let minutes = MINUTES_BY_DIFFICULTY[question.difficulty] ?? 15;
  if (question.category === 'system-design') minutes += 5;
  if (coversMust(question, requirements)) minutes += 5;
  return minutes;
}

function coversMust(question: Question, requirements: Requirement[]): boolean {
  return question.requirement_ids.some((id) =>
    requirements.some((requirement) => requirement.id === id && requirement.priority === 'must'),
  );
}

const CATEGORY_ORDER: Record<string, number> = {
  technical: 0,
  'system-design': 1,
  behavioural: 2,
  'company-fit': 3,
};

/** Hardest, highest-priority material first. */
export function orderQuestions(
  questions: Question[],
  requirements: Requirement[],
  weakness?: Record<string, number>,
): Question[] {
  return [...questions].sort((a, b) => {
    const mustDelta = Number(coversMust(b, requirements)) - Number(coversMust(a, requirements));
    if (mustDelta !== 0) return mustDelta;
    if (weakness) {
      const weaknessDelta = (weakness[b.id] ?? 0) - (weakness[a.id] ?? 0);
      if (Math.abs(weaknessDelta) > 0.001) return weaknessDelta;
    }
    if (b.difficulty !== a.difficulty) return b.difficulty - a.difficulty;
    const categoryDelta =
      (CATEGORY_ORDER[a.category] ?? 9) - (CATEGORY_ORDER[b.category] ?? 9);
    if (categoryDelta !== 0) return categoryDelta;
    return numericId(a.id) - numericId(b.id);
  });
}

function numericId(id: string): number {
  const match = /(\d+)$/.exec(id);
  return match ? Number(match[1]) : 0;
}

/**
 * More questions than days: give each day a share of the total minutes, with
 * the early days deliberately heavier.
 */
function packDenseSchedule(
  ordered: Question[],
  daysAvailable: number,
  minutesFor: (question: Question) => number,
  describe: (questionIds: string[], review: boolean) => string,
): ScheduleDay[] {
  const totalMinutes = ordered.reduce((sum, question) => sum + minutesFor(question), 0);
  const shares = frontLoadedShares(daysAvailable);

  // Cumulative targets rather than per-day ones: a day that overshoots is
  // corrected by the next day instead of pushing the remainder onto the last
  // one, which is how schedules end up with an eight-question final evening.
  const cumulative: number[] = [];
  let running = 0;
  for (const share of shares) {
    running += share * totalMinutes;
    cumulative.push(running);
  }

  const days: ScheduleDay[] = Array.from({ length: daysAvailable }, (_, index) => ({
    day: index + 1,
    focus: '',
    question_ids: [],
    minutes: 0,
  }));

  let cursor = 0;
  let allocated = 0;
  for (let index = 0; index < daysAvailable; index += 1) {
    const day = days[index]!;
    const remainingDays = daysAvailable - index - 1;
    const target = cumulative[index]!;

    // Always take at least one, and never take so many that a later day would
    // be left with nothing to do.
    do {
      const question = ordered[cursor]!;
      day.question_ids.push(question.id);
      day.minutes += minutesFor(question);
      allocated += minutesFor(question);
      cursor += 1;
    } while (
      cursor < ordered.length &&
      ordered.length - cursor > remainingDays &&
      allocated < target
    );
  }

  // Anything left over (rounding) goes on the last day rather than nowhere.
  while (cursor < ordered.length) {
    const day = days[daysAvailable - 1]!;
    const question = ordered[cursor]!;
    day.question_ids.push(question.id);
    day.minutes += minutesFor(question);
    cursor += 1;
  }

  return days.map((day) => ({ ...day, focus: describe(day.question_ids, false) }));
}

/**
 * More days than questions: introduce the material first, then spend the
 * surplus on spaced review, weighted towards the hard must-have questions.
 */
function packSparseSchedule(
  ordered: Question[],
  daysAvailable: number,
  minutesFor: (question: Question) => number,
  describe: (questionIds: string[], review: boolean) => string,
): ScheduleDay[] {
  const days: ScheduleDay[] = [];

  for (let index = 0; index < ordered.length; index += 1) {
    const question = ordered[index]!;
    days.push({
      day: index + 1,
      focus: describe([question.id], false),
      question_ids: [question.id],
      minutes: minutesFor(question) + 10,
    });
  }

  const reviewDays = daysAvailable - ordered.length;
  const reviewPool = ordered.length <= 3 ? ordered : ordered.slice(0, Math.ceil(ordered.length * 0.8));
  let cursor = 0;

  for (let index = 0; index < reviewDays; index += 1) {
    const take = Math.min(reviewPool.length, 3);
    const ids: string[] = [];
    let minutes = 0;
    for (let offset = 0; offset < take; offset += 1) {
      const question = reviewPool[(cursor + offset) % reviewPool.length]!;
      ids.push(question.id);
      minutes += Math.round(minutesFor(question) * 0.6);
    }
    cursor = (cursor + take) % reviewPool.length;
    days.push({
      day: days.length + 1,
      focus: describe(ids, true),
      question_ids: ids,
      minutes,
    });
  }

  return days;
}

/** Even split, tilted so the first day carries ~1.4x the last day's load. */
function frontLoadedShares(days: number): number[] {
  if (days === 1) return [1];
  const raw = Array.from({ length: days }, (_, index) => 1.2 - (0.4 * index) / (days - 1));
  const total = raw.reduce((sum, value) => sum + value, 0);
  return raw.map((value) => value / total);
}

/** Focus lines are derived from the day's questions - no model involved. */
function focusFor(
  questionIds: string[],
  questions: Question[],
  requirements: Requirement[],
  review: boolean,
): string {
  const chosen = questions.filter((question) => questionIds.includes(question.id));
  if (chosen.length === 0) return review ? 'Review' : 'Preparation';

  const counts = new Map<string, number>();
  for (const question of chosen) {
    counts.set(question.category, (counts.get(question.category) ?? 0) + 1);
  }
  const dominant = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
  const label =
    dominant === 'technical'
      ? 'Technical depth'
      : dominant === 'system-design'
        ? 'System design'
        : dominant === 'behavioural'
          ? 'Behavioural stories'
          : 'Company fit';

  // Keywords come from the requirements the day covers, not from the question
  // wording, so a focus line reads "React, TypeScript" rather than "walk me".
  const covered = new Set(chosen.flatMap((question) => question.requirement_ids));
  const requirementText = requirements
    .filter((requirement) => covered.has(requirement.id))
    .map((requirement) => requirement.text)
    .join(' ');
  const keywords = topKeywords(requirementText || chosen.map((question) => question.prompt).join(' '), 3);
  const suffix = keywords.length > 0 ? `: ${keywords.join(', ')}` : '';
  return `${review ? 'Review - ' : ''}${label}${suffix}`;
}

const FOCUS_STOPWORDS = new Set([
  'you', 'your', 'walk', 'tell', 'about', 'time', 'would', 'through', 'what', 'when', 'where',
  'how', 'why', 'the', 'and', 'for', 'with', 'that', 'this', 'take', 'give', 'most', 'more',
  'posting', 'requirement', 'requires', 'role', 'asks', 'company', 'question', 'talk', 'design',
  'describe', 'specific', 'example', 'experience', 'have', 'has', 'did', 'does', 'done', 'work',
]);

function topKeywords(text: string, limit: number): string[] {
  const counts = new Map<string, number>();
  for (const token of tokenise(text)) {
    if (token.length < 3 || FOCUS_STOPWORDS.has(token)) continue;
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([token]) => token);
}

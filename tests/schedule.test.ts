import { describe, expect, it } from 'vitest';
import { buildSchedule, clampDays, orderQuestions } from '../src/schedule/allocator';
import type { Question, Requirement } from '../src/domain/types';

const requirements: Requirement[] = [
  { id: 'r1', text: 'Distributed systems at scale', kind: 'technical', priority: 'must' },
  { id: 'r2', text: 'Mentoring', kind: 'behavioural', priority: 'must' },
  { id: 'r3', text: 'Open source contributions', kind: 'technical', priority: 'nice' },
];

function makeQuestions(count: number): Question[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `q${index + 1}`,
    requirement_ids: [requirements[index % requirements.length]!.id],
    category: index % 4 === 1 ? 'system-design' : index % 3 === 0 ? 'technical' : 'behavioural',
    prompt: `Question ${index + 1} about ${requirements[index % requirements.length]!.text}`,
    answer_outline: 'outline',
    difficulty: ((index % 3) + 1) as 1 | 2 | 3,
  }));
}

describe('schedule allocation', () => {
  it('always produces exactly the number of days requested', () => {
    for (const days of [1, 2, 3, 5, 7, 14, 30, 60]) {
      const schedule = buildSchedule({ daysAvailable: days, questions: makeQuestions(12), requirements });
      expect(schedule.days_available).toBe(days);
      expect(schedule.days).toHaveLength(days);
      expect(schedule.days.map((day) => day.day)).toEqual(
        Array.from({ length: days }, (_, index) => index + 1),
      );
    }
  });

  it('allocates every question somewhere', () => {
    const questions = makeQuestions(17);
    const schedule = buildSchedule({ daysAvailable: 5, questions, requirements });
    const scheduled = new Set(schedule.days.flatMap((day) => day.question_ids));
    expect(scheduled.size).toBe(questions.length);
  });

  it('puts every must-have requirement in the schedule', () => {
    const questions = makeQuestions(9);
    const schedule = buildSchedule({ daysAvailable: 4, questions, requirements });
    const scheduledIds = new Set(schedule.days.flatMap((day) => day.question_ids));
    for (const requirement of requirements.filter((item) => item.priority === 'must')) {
      const covering = questions.filter((question) => question.requirement_ids.includes(requirement.id));
      expect(covering.some((question) => scheduledIds.has(question.id))).toBe(true);
    }
  });

  it('uses integer minutes on every day', () => {
    const schedule = buildSchedule({ daysAvailable: 6, questions: makeQuestions(13), requirements });
    for (const day of schedule.days) {
      expect(Number.isInteger(day.minutes)).toBe(true);
      expect(day.minutes).toBeGreaterThan(0);
    }
  });

  it('lays the days out in priority order, so must-haves come before nice-to-haves', () => {
    const questions = makeQuestions(12);
    const schedule = buildSchedule({ daysAvailable: 4, questions, requirements });
    const flattened = schedule.days.flatMap((day) => day.question_ids);

    // Days are filled from the ordered list, so the schedule reads in exactly
    // the order the allocator ranked the questions in.
    expect(flattened).toEqual(orderQuestions(questions, requirements).map((question) => question.id));

    const byId = new Map(questions.map((question) => [question.id, question]));
    const coversMust = (id: string) =>
      byId.get(id)!.requirement_ids.some((requirementId) =>
        requirements.some((requirement) => requirement.id === requirementId && requirement.priority === 'must'),
      );
    expect(schedule.days[0]!.question_ids.every(coversMust)).toBe(true);
    expect(schedule.days.at(-1)!.question_ids.some(coversMust)).toBe(false);
  });

  it('handles a one-day schedule by putting everything on day one', () => {
    const questions = makeQuestions(8);
    const schedule = buildSchedule({ daysAvailable: 1, questions, requirements });
    expect(schedule.days).toHaveLength(1);
    expect(schedule.days[0]!.question_ids).toHaveLength(8);
  });

  it('fills a long schedule with spaced review rather than empty days', () => {
    const questions = makeQuestions(6);
    const schedule = buildSchedule({ daysAvailable: 60, questions, requirements });
    expect(schedule.days).toHaveLength(60);
    expect(schedule.days.every((day) => day.question_ids.length > 0)).toBe(true);
    expect(schedule.days.slice(-1)[0]!.focus.toLowerCase()).toContain('review');
  });

  it('still produces days when there is nothing to schedule', () => {
    const schedule = buildSchedule({ daysAvailable: 3, questions: [], requirements: [] });
    expect(schedule.days).toHaveLength(3);
    expect(schedule.days.every((day) => day.question_ids.length === 0)).toBe(true);
    expect(schedule.days.every((day) => Number.isInteger(day.minutes))).toBe(true);
  });

  it('clamps nonsense day counts instead of producing an invalid schedule', () => {
    expect(clampDays(0)).toBe(1);
    expect(clampDays(-4)).toBe(1);
    expect(clampDays(Number.NaN)).toBe(1);
    expect(clampDays(5.4)).toBe(5);
    expect(clampDays(10_000)).toBe(365);
  });

  it('orders must-have questions first, hardest of those at the front', () => {
    const questions = makeQuestions(9);
    const ordered = orderQuestions(questions, requirements);
    const first = ordered[0]!;
    expect(first.requirement_ids.some((id) => ['r1', 'r2'].includes(id))).toBe(true);

    const mustDifficulties = ordered
      .filter((question) => question.requirement_ids.some((id) => ['r1', 'r2'].includes(id)))
      .map((question) => question.difficulty);
    expect(first.difficulty).toBe(Math.max(...mustDifficulties));
    // Every must-covering question precedes every nice-only one.
    const lastMustIndex = ordered.findLastIndex((question) =>
      question.requirement_ids.some((id) => ['r1', 'r2'].includes(id)),
    );
    const firstNiceIndex = ordered.findIndex((question) => question.requirement_ids.includes('r3'));
    expect(lastMustIndex).toBeLessThan(firstNiceIndex);
  });
});

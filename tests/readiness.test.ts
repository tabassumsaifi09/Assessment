import { describe, expect, it } from 'vitest';
import { buildReadinessReport, replanSchedule } from '../src/practice/readiness';
import type { KitDocument } from '../src/domain/types';

function document(practice: Array<{ card_id: string; confidence: number }>): KitDocument {
  return {
    id: 'kit-1',
    user_id: 'user-1',
    status: 'ready',
    fingerprint: 'f',
    days_requested: 3,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    error: null,
    progress: [],
    item_state: {},
    practice: practice.map((entry) => ({
      card_id: entry.card_id,
      confidence: entry.confidence,
      reviewed_at: new Date().toISOString(),
      due_at: new Date().toISOString(),
      reps: 1,
    })),
    kit: {
      source: {
        company: 'Testco',
        company_url: 'https://testco.example',
        role: 'Engineer',
        location: '',
        jd_chars: 100,
        researched_at: new Date().toISOString(),
        pages_used: [],
      },
      company_brief: { summary: '', what_they_do: '', sources: [] },
      role: {
        title: 'Engineer',
        seniority: '',
        responsibilities: [],
        requirements: [
          { id: 'r1', text: 'Go', kind: 'technical', priority: 'must' },
          { id: 'r2', text: 'Mentoring', kind: 'behavioural', priority: 'must' },
          { id: 'r3', text: 'Kubernetes', kind: 'technical', priority: 'nice' },
        ],
      },
      questions: [
        { id: 'q1', requirement_ids: ['r1'], category: 'technical', prompt: 'Go?', answer_outline: '', difficulty: 3 },
        { id: 'q2', requirement_ids: ['r2'], category: 'behavioural', prompt: 'Mentoring?', answer_outline: '', difficulty: 3 },
        { id: 'q3', requirement_ids: ['r3'], category: 'technical', prompt: 'K8s?', answer_outline: '', difficulty: 1 },
      ],
      flashcards: [
        { id: 'f1', front: 'Go', back: '...', requirement_ids: ['r1'] },
        { id: 'f2', front: 'Mentoring', back: '...', requirement_ids: ['r2'] },
        { id: 'f3', front: 'K8s', back: '...', requirement_ids: ['r3'] },
      ],
      schedule: {
        days_available: 3,
        days: [
          { day: 1, focus: 'a', question_ids: ['q1'], minutes: 30 },
          { day: 2, focus: 'b', question_ids: ['q2'], minutes: 30 },
          { day: 3, focus: 'c', question_ids: ['q3'], minutes: 30 },
        ],
      },
      coverage: { uncovered_requirement_ids: [], passes: 2 },
    },
  };
}

describe('readiness report', () => {
  it('scores an unpractised requirement as untouched rather than skipping it', () => {
    const report = buildReadinessReport(document([]));
    expect(report.requirements).toHaveLength(3);
    expect(report.requirements.every((entry) => entry.status === 'untouched')).toBe(true);
    expect(report.must_ready).toBe(0);
    expect(report.must_total).toBe(2);
  });

  it('reflects practice confidence per requirement', () => {
    const report = buildReadinessReport(
      document([
        { card_id: 'f1', confidence: 4 },
        { card_id: 'f2', confidence: 1 },
      ]),
    );
    const byId = new Map(report.requirements.map((entry) => [entry.requirement_id, entry]));
    expect(byId.get('r1')!.status).toBe('solid');
    expect(byId.get('r2')!.status).toBe('shaky');
    expect(report.must_ready).toBe(1);
    expect(report.weakest[0]!.requirement_id).toBe('r2');
  });

  it('uses only the most recent review of a card', () => {
    const report = buildReadinessReport(
      document([
        { card_id: 'f1', confidence: 1 },
        { card_id: 'f1', confidence: 4 },
      ]),
    );
    const r1 = report.requirements.find((entry) => entry.requirement_id === 'r1')!;
    expect(r1.readiness).toBe(1);
  });
});

describe('re-planning around weak spots', () => {
  it('moves the weakest must-have material to the front while keeping every guarantee', () => {
    const doc = document([
      { card_id: 'f1', confidence: 4 },
      { card_id: 'f2', confidence: 1 },
    ]);
    const schedule = replanSchedule(doc, 3);
    expect(schedule.days).toHaveLength(3);
    expect(schedule.days[0]!.question_ids).toContain('q2');
    const scheduled = new Set(schedule.days.flatMap((day) => day.question_ids));
    expect(scheduled.size).toBe(3);
    expect(schedule.days.every((day) => Number.isInteger(day.minutes))).toBe(true);
  });

  it('can re-plan into fewer days than the original schedule', () => {
    const schedule = replanSchedule(document([]), 1);
    expect(schedule.days).toHaveLength(1);
    expect(schedule.days[0]!.question_ids).toHaveLength(3);
  });
});

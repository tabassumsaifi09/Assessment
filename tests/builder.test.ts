import { describe, expect, it } from 'vitest';
import { regenerateSection } from '../src/pipeline/regenerate';
import { createLlmClient } from '../src/llm';
import { OfflineModelProvider } from '../src/llm/providers/offline';
import { PageFetcher } from '../src/retrieval/fetcher';
import { NullSearchProvider } from '../src/research/searchProvider';
import { validateKit } from '../src/validation/kitValidator';
import type { ItemState, Kit, KitDocument } from '../src/domain/types';

const deps = () => ({
  llm: createLlmClient(new OfflineModelProvider()),
  fetcher: new PageFetcher({
    timeoutMs: 2000,
    maxBytes: 100_000,
    crawlDelayMs: 0,
    allowPrivateNetwork: false,
  }),
  search: new NullSearchProvider(),
});

const options = { maxPages: 4, maxDepth: 1, maxCoveragePasses: 3 };

function kit(): Kit {
  return {
    source: {
      company: 'Testco',
      company_url: 'https://testco.example',
      role: 'Backend Engineer',
      location: '',
      jd_chars: 400,
      researched_at: new Date().toISOString(),
      pages_used: [],
    },
    company_brief: { summary: 'Testco builds things.', what_they_do: 'Software.', sources: [] },
    role: {
      title: 'Backend Engineer',
      seniority: 'senior',
      responsibilities: [],
      requirements: [
        { id: 'r1', text: '5+ years with Go', kind: 'technical', priority: 'must' },
        { id: 'r2', text: 'Mentoring engineers', kind: 'behavioural', priority: 'must' },
      ],
    },
    questions: [
      {
        id: 'q1',
        requirement_ids: ['r1'],
        category: 'technical',
        prompt: 'My own carefully worded Go question',
        answer_outline: 'edited outline',
        difficulty: 3,
      },
      {
        id: 'q2',
        requirement_ids: ['r1'],
        category: 'technical',
        prompt: 'A generated Go question',
        answer_outline: 'generated outline',
        difficulty: 2,
      },
      {
        id: 'q3',
        requirement_ids: ['r2'],
        category: 'behavioural',
        prompt: 'A generated mentoring question',
        answer_outline: 'generated outline',
        difficulty: 2,
      },
    ],
    flashcards: [{ id: 'f1', front: 'Go', back: 'Goroutines', requirement_ids: ['r1'] }],
    schedule: {
      days_available: 2,
      days: [
        { day: 1, focus: 'Technical depth', question_ids: ['q1', 'q2'], minutes: 60 },
        { day: 2, focus: 'Behavioural stories', question_ids: ['q3'], minutes: 40 },
      ],
    },
    coverage: { uncovered_requirement_ids: [], passes: 2 },
  };
}

function document(itemState: Record<string, ItemState>): KitDocument {
  return {
    id: 'kit-1',
    user_id: 'user-1',
    status: 'ready',
    fingerprint: 'abc',
    days_requested: 2,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    kit: kit(),
    error: null,
    progress: [],
    item_state: itemState,
    practice: [],
  };
}

describe('regenerating one section', () => {
  it('keeps edited and manual questions, replaces generated ones', async () => {
    const doc = document({
      q1: { origin: 'edited', pinned: false, edited_at: new Date().toISOString() },
      q2: { origin: 'generated', pinned: false },
      q3: { origin: 'generated', pinned: false },
    });

    const result = await regenerateSection(doc, { section: 'questions', category: 'technical' }, deps(), options);
    const prompts = result.kit.questions.map((question) => question.prompt);

    expect(prompts).toContain('My own carefully worded Go question');
    expect(prompts).not.toContain('A generated Go question');
    expect(result.preserved).toContain('q1');
  });

  it('leaves other categories completely untouched', async () => {
    const doc = document({
      q1: { origin: 'edited', pinned: false },
      q2: { origin: 'generated', pinned: false },
      q3: { origin: 'generated', pinned: false },
    });
    const result = await regenerateSection(doc, { section: 'questions', category: 'technical' }, deps(), options);
    const behavioural = result.kit.questions.filter((question) => question.category === 'behavioural');
    expect(behavioural.map((question) => question.prompt)).toContain('A generated mentoring question');
  });

  it('keeps a pinned but unedited question', async () => {
    const doc = document({
      q1: { origin: 'generated', pinned: false },
      q2: { origin: 'generated', pinned: true },
      q3: { origin: 'generated', pinned: false },
    });
    const result = await regenerateSection(doc, { section: 'questions', category: 'technical' }, deps(), options);
    expect(result.kit.questions.map((question) => question.prompt)).toContain('A generated Go question');
  });

  it('produces a kit that still validates, with the schedule reallocated', async () => {
    const doc = document({ q1: { origin: 'edited', pinned: false } });
    const result = await regenerateSection(doc, { section: 'questions', category: 'technical' }, deps(), options);
    expect(validateKit(result.kit).errors).toEqual([]);
    const scheduled = new Set(result.kit.schedule.days.flatMap((day) => day.question_ids));
    expect(scheduled.size).toBe(result.kit.questions.length);
  });

  it('does not touch a brief the user has edited', async () => {
    const doc = document({ company_brief: { origin: 'edited', pinned: false } });
    const result = await regenerateSection(doc, { section: 'company_brief' }, deps(), options);
    expect(result.kit.company_brief.summary).toBe('Testco builds things.');
    expect(result.notes.join(' ')).toMatch(/left untouched/);
  });

  it('reallocates the schedule on request without changing the questions', async () => {
    const doc = document({});
    const result = await regenerateSection(doc, { section: 'schedule' }, deps(), options);
    expect(result.kit.questions).toHaveLength(3);
    expect(result.kit.schedule.days).toHaveLength(2);
    expect(validateKit(result.kit).errors).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { checkCoverage } from '../src/coverage/checker';
import { closeCoverageGaps } from '../src/coverage/gapFiller';
import { createLlmClient } from '../src/llm';
import { OfflineModelProvider } from '../src/llm/providers/offline';
import type { LlmProvider, LlmRequest } from '../src/llm/types';
import type { GenerationContext } from '../src/generation/context';
import type { Question, Requirement } from '../src/domain/types';
import { NO_HIRING_PROCESS } from '../src/research/companyResearch';

const requirements: Requirement[] = [
  { id: 'r1', text: '5+ years with React', kind: 'technical', priority: 'must' },
  { id: 'r2', text: 'Mentoring junior engineers', kind: 'behavioural', priority: 'must' },
  { id: 'r3', text: 'Familiarity with GDPR in a healthcare setting', kind: 'domain', priority: 'nice' },
];

const context: GenerationContext = {
  company: 'Testco',
  companyUrl: 'https://testco.example',
  seniority: 'senior',
  facts: [],
  process: NO_HIRING_PROCESS,
  thin: false,
};

const question = (id: string, requirementIds: string[]): Question => ({
  id,
  requirement_ids: requirementIds,
  category: 'technical',
  prompt: `question ${id}`,
  answer_outline: 'outline',
  difficulty: 2,
});

describe('coverage checking', () => {
  it('reports requirements with no question against them', () => {
    const report = checkCoverage(requirements, [question('q1', ['r1'])]);
    expect(report.uncovered.map((requirement) => requirement.id)).toEqual(['r2', 'r3']);
    expect(report.uncoveredMust.map((requirement) => requirement.id)).toEqual(['r2']);
    expect(report.coveredCount).toBe(1);
  });

  it('ignores references to requirements that do not exist', () => {
    const report = checkCoverage(requirements, [question('q1', ['r9'])]);
    expect(report.danglingQuestionIds).toEqual(['q1']);
    expect(report.coveredCount).toBe(0);
  });

  it('treats a question covering several requirements as covering all of them', () => {
    const report = checkCoverage(requirements, [question('q1', ['r1', 'r2'])]);
    expect(report.uncovered.map((requirement) => requirement.id)).toEqual(['r3']);
  });
});

describe('the second pass', () => {
  it('generates questions for the gaps and re-checks', async () => {
    const llm = createLlmClient(new OfflineModelProvider());
    const result = await closeCoverageGaps(llm, requirements, [question('q1', ['r1'])], context, {
      maxPasses: 3,
    });

    expect(result.passes).toBeGreaterThanOrEqual(2);
    expect(result.report.uncovered).toHaveLength(0);
    expect(result.questions.length).toBeGreaterThan(1);
    // The question that was already there is untouched by the gap pass.
    expect(result.questions[0]!.id).toBe('q1');
  });

  it('does not loop when the model keeps returning nothing, and still closes the gap in code', async () => {
    let calls = 0;
    const silent: LlmProvider = {
      name: 'silent',
      async complete(request: LlmRequest) {
        if (request.task === 'generate_questions') {
          calls += 1;
          return JSON.stringify({ questions: [] });
        }
        return JSON.stringify({});
      },
    };

    const result = await closeCoverageGaps(createLlmClient(silent), requirements, [], context, {
      maxPasses: 3,
    });

    expect(calls).toBeGreaterThan(0);
    expect(result.report.uncovered).toHaveLength(0);
    expect(result.questions).toHaveLength(requirements.length);
    expect(result.notes.join(' ')).toMatch(/derived directly from the requirement text/);
  });

  it('stops at the configured pass limit', async () => {
    const stubborn: LlmProvider = {
      name: 'stubborn',
      async complete(request: LlmRequest) {
        if (request.task === 'generate_questions') {
          // Answers, but always about the wrong requirement.
          return JSON.stringify({
            questions: [
              { requirement_ids: ['r-does-not-exist'], category: 'technical', prompt: 'noise', answer_outline: '', difficulty: 2 },
            ],
          });
        }
        return JSON.stringify({});
      },
    };
    const result = await closeCoverageGaps(createLlmClient(stubborn), requirements, [], context, {
      maxPasses: 2,
    });
    expect(result.passes).toBeLessThanOrEqual(2);
    expect(result.report.uncoveredMust).toHaveLength(0);
  });
});

import { describe, expect, it } from 'vitest';
import { extractRole } from '../src/extraction/jdExtractor';
import { extractByRules } from '../src/extraction/ruleExtractor';
import { createLlmClient } from '../src/llm';
import { OfflineModelProvider } from '../src/llm/providers/offline';
import type { LlmProvider, LlmRequest } from '../src/llm/types';

const client = () => createLlmClient(new OfflineModelProvider());

const FULL_POSTING = `Senior Backend Engineer

About the role
You will own our payments service end to end.

Responsibilities
- Build and operate services that move money
- Work with compliance on audit requirements

Requirements
- 5+ years of backend experience with Go or Java
- Strong experience with PostgreSQL and schema design
- Experience mentoring engineers
- Familiarity with PCI compliance in a payments environment

Nice to have
- Kubernetes experience
- Bonus points for open source contributions

Benefits
- Private healthcare, 25 days holiday and a learning budget
- We are an equal opportunity employer`;

describe('requirement extraction', () => {
  it('separates must-haves from nice-to-haves using the posting wording', async () => {
    const role = await extractRole(client(), FULL_POSTING);
    const musts = role.requirements.filter((requirement) => requirement.priority === 'must');
    const nices = role.requirements.filter((requirement) => requirement.priority === 'nice');

    expect(musts.map((requirement) => requirement.text).join(' ')).toMatch(/5\+ years/);
    expect(musts.length).toBeGreaterThanOrEqual(4);
    expect(nices.map((requirement) => requirement.text).join(' ')).toMatch(/Kubernetes/i);
    expect(nices.map((requirement) => requirement.text).join(' ')).toMatch(/open source/i);
    expect(nices.every((requirement) => !/5\+ years/.test(requirement.text))).toBe(true);
  });

  it('never turns benefits or responsibilities into requirements', async () => {
    const role = await extractRole(client(), FULL_POSTING);
    const text = role.requirements.map((requirement) => requirement.text).join(' | ').toLowerCase();
    expect(text).not.toContain('holiday');
    expect(text).not.toContain('healthcare');
    expect(text).not.toContain('equal opportunity');
    expect(text).not.toContain('build and operate services');
    expect(role.responsibilities.join(' ')).toMatch(/Build and operate services/);
  });

  it('assigns stable ids in posting order across runs', async () => {
    const first = await extractRole(client(), FULL_POSTING);
    const second = await extractRole(client(), FULL_POSTING);
    expect(first.requirements.map((requirement) => requirement.id)).toEqual(
      second.requirements.map((requirement) => requirement.id),
    );
    expect(first.requirements.map((requirement) => requirement.text)).toEqual(
      second.requirements.map((requirement) => requirement.text),
    );
    expect(first.requirements[0]!.id).toBe('r1');
  });

  it('classifies requirement kinds', async () => {
    const role = await extractRole(client(), FULL_POSTING);
    const byText = (needle: string) =>
      role.requirements.find((requirement) => requirement.text.toLowerCase().includes(needle));
    expect(byText('postgresql')?.kind).toBe('technical');
    expect(byText('mentoring')?.kind).toBe('behavioural');
    expect(byText('pci')?.kind).toBe('domain');
  });

  it('produces a thin, honest reading of a two-line posting', async () => {
    const role = await extractRole(
      client(),
      'Software Engineer\nWe need someone who knows Python and can work independently.',
    );
    expect(role.thin).toBe(true);
    expect(role.requirements.length).toBeGreaterThan(0);
    expect(role.requirements.length).toBeLessThanOrEqual(3);
    expect(role.requirements.map((requirement) => requirement.text).join(' ')).toMatch(/Python/i);
    expect(role.notes.join(' ')).toMatch(/short/i);
  });

  it('drops requirements the model invents that the posting does not support', async () => {
    // A provider that hallucinates a requirement nobody asked for.
    const liar: LlmProvider = {
      name: 'liar',
      async complete(request: LlmRequest) {
        if (request.task !== 'extract_jd') return new OfflineModelProvider().complete(request, new AbortController().signal);
        return JSON.stringify({
          title: 'Software Engineer',
          seniority: '',
          location: '',
          responsibilities: [],
          requirements: [
            { text: 'Knows Python', kind: 'technical', priority: 'must' },
            { text: 'Ten years of Kubernetes and a PhD in distributed systems', kind: 'technical', priority: 'must' },
          ],
          notes: [],
        });
      },
    };
    const role = await extractRole(createLlmClient(liar), 'Software Engineer\nWe need someone who knows Python.');
    const texts = role.requirements.map((requirement) => requirement.text.toLowerCase());
    expect(texts.some((text) => text.includes('python'))).toBe(true);
    expect(texts.some((text) => text.includes('phd'))).toBe(false);
    expect(role.rejected.join(' ')).toMatch(/PhD/);
  });

  it('recovers requirements the model omits, using the rule reading of the posting', async () => {
    const lazy: LlmProvider = {
      name: 'lazy',
      async complete(request: LlmRequest) {
        if (request.task !== 'extract_jd') return new OfflineModelProvider().complete(request, new AbortController().signal);
        return JSON.stringify({
          title: 'Senior Backend Engineer',
          seniority: 'senior',
          location: '',
          responsibilities: [],
          requirements: [{ text: '5+ years of backend experience with Go or Java', kind: 'technical', priority: 'must' }],
          notes: [],
        });
      },
    };
    const role = await extractRole(createLlmClient(lazy), FULL_POSTING);
    expect(role.requirements.length).toBeGreaterThan(3);
    expect(role.requirements.map((requirement) => requirement.text).join(' ')).toMatch(/PostgreSQL/);
  });
});

describe('rule reading of a posting', () => {
  it('keeps section context so a nice-to-have heading demotes its bullets', () => {
    const rules = extractByRules(FULL_POSTING);
    const kubernetes = rules.requirements.find((requirement) => /kubernetes/i.test(requirement.text));
    expect(kubernetes?.priority).toBe('nice');
  });

  it('does not treat an unstructured duty bullet as a requirement', () => {
    const rules = extractByRules('Engineer\n\n- Build features with React\n- Ship to production daily');
    expect(rules.requirements).toHaveLength(0);
    expect(rules.responsibilities.length).toBe(2);
  });
});

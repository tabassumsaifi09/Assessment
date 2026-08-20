import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureServer } from '../scripts/serve-fixture-site';
import { parseCases, runBatch, type BatchCase } from '../src/evaluation/batchRunner';
import { parseArgs } from '../src/evaluation/cli';
import { validateKit } from '../src/validation/kitValidator';

let server: { url: string; close: () => Promise<void> };

beforeAll(async () => {
  process.env.SEARCH_PROVIDER = 'none';
  server = await startFixtureServer(0);
});

afterAll(async () => {
  await server.close();
});

function cases(): BatchCase[] {
  return [
    {
      id: 'case-01',
      jd: [
        'Senior Full-Stack Engineer',
        '',
        'Requirements',
        '- 5+ years of professional experience with React and TypeScript',
        '- Experience designing REST APIs in Node.js',
        '- Experience mentoring junior engineers',
        '',
        'Nice to have',
        '- Kubernetes',
      ].join('\n'),
      company_url: `${server.url}/acme/`,
      days: 5,
    },
    {
      id: 'case-02',
      jd: 'Software Engineer\nWe need someone who knows Python and can work independently.',
      company_url: `${server.url}/quietco/`,
      days: 3,
    },
    {
      id: 'case-03',
      jd: [
        'Staff Backend Engineer',
        '',
        'What we are looking for',
        '- Proven experience designing distributed systems at scale',
        '- Deep knowledge of Go in production',
        '- Track record of mentoring engineers',
      ].join('\n'),
      company_url: `${server.url}/deeporg/`,
      days: 60,
    },
    {
      id: 'case-04',
      jd: 'Frontend Engineer\n\nRequirements\n- 3+ years with Vue\n- Accessibility (WCAG 2.1)',
      company_url: 'http://127.0.0.1:9/not-here/',
      days: 1,
    },
    {
      id: 'case-05',
      jd: '',
      company_url: `${server.url}/acme/`,
      days: 5,
    },
  ];
}

describe('the batch entry point', () => {
  it('parses the documented CLI arguments', () => {
    const args = parseArgs(['--input', 'cases.json', '--output', 'kits.json']);
    expect(args.input).toBe('cases.json');
    expect(args.output).toBe('kits.json');
    expect(args.allowPrivateNetwork).toBe(true);
    expect(() => parseArgs(['--input', 'only.json'])).toThrow(/usage/);
  });

  it('reads cases and defaults a missing day count', () => {
    const parsed = parseCases([{ id: 'a', jd: 'x', company_url: 'https://x.test' }]);
    expect(parsed[0]!.days).toBe(5);
  });

  it('runs five cases, keeps going after a failure, and writes Appendix B', async () => {
    const output = await runBatch(cases(), { concurrency: 2, perCaseTimeoutMs: 60_000 });

    expect(output.version).toBe('1.0');
    expect(Number.isNaN(Date.parse(output.generated_at))).toBe(false);
    expect(output.kits).toHaveLength(5);
    expect(output.kits.map((entry) => entry.id).sort()).toEqual([
      'case-01',
      'case-02',
      'case-03',
      'case-04',
      'case-05',
    ]);

    for (const entry of output.kits) {
      if (entry.status === 'ok') {
        expect(entry.error).toBeNull();
        expect(entry.kit).not.toBeNull();
        const result = validateKit(entry.kit);
        expect(result.errors).toEqual([]);
      } else {
        expect(entry.kit).toBeNull();
        expect(entry.error?.code).toBeTruthy();
      }
    }
  });

  it('treats an unreachable company site as a partial result, not a failure', async () => {
    const output = await runBatch([cases()[3]!], { concurrency: 1 });
    const entry = output.kits[0]!;
    expect(entry.status).toBe('ok');
    expect(entry.kit?.research?.hiring_page_found).toBe(false);
    expect(entry.kit?.source.pages_used).toHaveLength(0);
    expect(entry.kit?.company_brief.summary).toMatch(/no pages could be retrieved/i);
    expect(entry.kit?.role.requirements.length).toBeGreaterThan(0);
  });

  it('records a case it cannot produce any kit for as failed', async () => {
    const output = await runBatch([cases()[4]!], { concurrency: 1 });
    expect(output.kits[0]!.status).toBe('failed');
    expect(output.kits[0]!.kit).toBeNull();
    expect(output.kits[0]!.error?.code).toBe('JD_EMPTY');
  });

  it('uses the days value given for each case', async () => {
    const output = await runBatch([cases()[2]!], { concurrency: 1 });
    expect(output.kits[0]!.kit?.schedule.days_available).toBe(60);
    expect(output.kits[0]!.kit?.schedule.days).toHaveLength(60);
  });

  it('computes a repeated posting once and returns the same kit for both cases', async () => {
    const duplicate: BatchCase[] = [
      { ...cases()[1]!, id: 'first' },
      { ...cases()[1]!, id: 'second' },
    ];
    const output = await runBatch(duplicate, { concurrency: 1 });
    expect(output.kits).toHaveLength(2);
    const [first, second] = output.kits;
    expect(first!.status).toBe('ok');
    expect(second!.status).toBe('ok');
    expect(JSON.stringify(second!.kit?.questions)).toBe(JSON.stringify(first!.kit?.questions));
  });
});

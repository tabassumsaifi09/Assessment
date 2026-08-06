import type { LlmProvider, LlmRequest } from '../types';
import { RateLimitError, TransientLlmError } from '../errors';
import { extractByRules } from '../../extraction/ruleExtractor';
import {
  BEHAVIOURAL_MARKERS,
  EXPERIENCE_PATTERN,
  SYSTEM_DESIGN_MARKERS,
  TECH_TOKENS,
} from '../../domain/lexicon';
import { dedupe, normaliseWhitespace, sentenceSplit, titleCase, truncate } from '../../util/text';
import { createRandom, seedFrom } from '../../util/hash';

/**
 * Deterministic offline model.
 *
 * The brief requires a provider with a genuine free tier; it also requires the
 * batch entry point to run from a clean clone with no key. Those two pull in
 * opposite directions, so the LlmClient sits behind an interface and this
 * rule-based provider is the default when LLM_API_KEY is empty. It answers the
 * same task contract as the hosted provider, returns JSON as text (sometimes
 * fenced, as hosted models do), and is seeded so two runs of the same input
 * produce the same kit.
 *
 * It knows nothing about any particular posting or company: every rule below
 * is generic English-language heuristics over whatever text it is handed.
 */
export class OfflineModelProvider implements LlmProvider {
  readonly name = 'offline-deterministic';

  private readonly callCounts = new Map<string, number>();

  async complete(request: LlmRequest, signal: AbortSignal): Promise<string> {
    if (signal.aborted) throw new TransientLlmError('aborted before dispatch');
    const count = (this.callCounts.get(request.task) ?? 0) + 1;
    this.callCounts.set(request.task, count);
    const fault = this.maybeInjectFault(request.task, count);
    if (fault !== null) return fault;

    switch (request.task) {
      case 'extract_jd':
        return json(extractJd(request.payload));
      case 'company_brief':
        return fenced(companyBrief(request.payload));
      case 'summarise_hiring_process':
        return json(hiringProcess(request.payload));
      case 'generate_questions':
        return fenced(generateQuestions(request.payload));
      case 'generate_flashcards':
        return json(generateFlashcards(request.payload));
      default:
        return json({});
    }
  }

  /**
   * Opt-in fault injection (MOCK_FAILURE_MODE) so the retry, backoff and
   * malformed-JSON paths can be exercised by the test suite rather than by
   * waiting for a real provider to misbehave.
   */
  private maybeInjectFault(task: string, count: number): string | null {
    const mode = process.env.MOCK_FAILURE_MODE ?? '';
    if (!mode) return null;
    if (mode === 'rate_limit_once' && count === 1) {
      throw new RateLimitError(`simulated 429 for ${task}`, 50);
    }
    if (mode === 'transient_once' && count === 1) {
      throw new TransientLlmError(`simulated upstream 503 for ${task}`);
    }
    if (mode === 'malformed_once' && count === 1) return MALFORMED_OUTPUT;
    if (mode === 'always_malformed') return MALFORMED_OUTPUT;
    return null;
  }
}

/** What a truncated or chatty model response looks like to the parser. */
const MALFORMED_OUTPUT = [
  'Sure! Here is the kit:',
  '{ "questions": [ { "prompt": "unterminated',
].join('\n');

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function fenced(value: unknown): string {
  return ['Here is the JSON you asked for:', '```json', JSON.stringify(value, null, 2), '```'].join(
    '\n',
  );
}

// ---------------------------------------------------------------------------
// extract_jd
// ---------------------------------------------------------------------------

function extractJd(payload: Record<string, unknown>): unknown {
  const extraction = extractByRules(String(payload.jd ?? ''));
  return {
    title: extraction.title,
    seniority: extraction.seniority,
    location: extraction.location,
    responsibilities: extraction.responsibilities,
    requirements: extraction.requirements.map((requirement) => ({
      text: requirement.text,
      kind: requirement.kind,
      priority: requirement.priority,
      evidence: truncate(requirement.text, 160),
    })),
    thin: extraction.thin,
    notes: extraction.notes,
  };
}

// ---------------------------------------------------------------------------
// company_brief / hiring process
// ---------------------------------------------------------------------------

interface PageInput {
  url: string;
  title?: string;
  text?: string;
  kind?: string;
}

function companyBrief(payload: Record<string, unknown>): unknown {
  const company = String(payload.company ?? '').trim();
  const pages = (payload.pages as PageInput[] | undefined) ?? [];
  const discussion = (payload.discussion as PageInput[] | undefined) ?? [];

  if (pages.length === 0) {
    // Nothing was retrievable. Say so rather than describing a company we
    // have not read a word about.
    return {
      summary:
        `No pages could be retrieved from the company site, so this brief is deliberately empty. ` +
        `Everything below comes from the job description alone.`,
      what_they_do: company
        ? `Not established from public sources. The posting is attributed to ${company}.`
        : 'Not established from public sources.',
      confidence: 'none',
      facts: [],
    };
  }

  const sentences: string[] = [];
  for (const page of pages.slice(0, 6)) {
    // Work line by line: navigation and link lists arrive as their own short
    // lines and are dropped here rather than quoted back as company facts.
    for (const line of (page.text ?? '').split('\n')) {
      const trimmed = normaliseWhitespace(line);
      if (trimmed.length < 45) continue;
      // Prose ends in punctuation; a navigation bar flattened into one line
      // does not. That single test removes most menu text from a brief.
      if (!/[.!?]/.test(trimmed)) continue;
      if (!/[a-z]{3,}\s+[a-z]{3,}/i.test(trimmed)) continue;
      for (const sentence of sentenceSplit(trimmed)) {
        const clean = normaliseWhitespace(sentence);
        if (clean.length < 45 || clean.length > 320) continue;
        if (/cookie|privacy policy|all rights reserved|subscribe|newsletter/i.test(clean)) continue;
        sentences.push(clean);
      }
    }
  }

  const descriptive = sentences
    .filter((sentence) =>
      /\b(we|our|the company|platform|product|customers|users|builds?|helps?|provides?|offers?|mission)\b/i.test(
        sentence,
      ),
    )
    .slice(0, 6);

  const chosen = dedupe(descriptive.length > 0 ? descriptive : sentences).slice(0, 4);
  const whatTheyDo = chosen.slice(0, 2).join(' ');
  const summaryParts: string[] = [];
  summaryParts.push(
    `${company || 'The company'} was researched from ${pages.length} retrieved page${pages.length === 1 ? '' : 's'}.`,
  );
  if (chosen.length > 0) summaryParts.push(chosen.slice(0, 3).join(' '));
  if (discussion.length > 0) {
    summaryParts.push(
      `Candidate accounts of their process were also read (${discussion.length} source${discussion.length === 1 ? '' : 's'}).`,
    );
  }

  return {
    summary: truncate(summaryParts.join(' '), 900),
    what_they_do:
      whatTheyDo ||
      `Not clearly stated on the pages retrieved from ${pages[0]?.url ?? 'the company site'}.`,
    confidence: chosen.length >= 2 ? 'medium' : 'low',
    facts: chosen.slice(0, 4),
  };
}

const PROCESS_PATTERN =
  /\b(interview|hiring process|take[- ]home|screen(ing)?|pair(ing| programming)?|onsite|on-site|panel|system design|coding challenge|technical (test|assessment|exercise)|culture (fit|interview)|recruiter (call|screen)|final round|loop|offer stage|values interview|case study|live coding|whiteboard)\b/i;

function hiringProcess(payload: Record<string, unknown>): unknown {
  const pages = (payload.pages as PageInput[] | undefined) ?? [];
  const found: string[] = [];
  for (const page of pages) {
    for (const line of (page.text ?? '').split('\n')) {
      for (const sentence of sentenceSplit(normaliseWhitespace(line))) {
        const clean = normaliseWhitespace(sentence);
        if (clean.length < 30 || clean.length > 300) continue;
        if (PROCESS_PATTERN.test(clean)) found.push(clean);
      }
    }
  }
  const stages = dedupe(found).slice(0, 8);
  const joined = stages.join(' ').toLowerCase();
  return {
    stages,
    signals: {
      take_home: /take[- ]home|coding challenge|technical exercise|case study/.test(joined),
      system_design: /system design|architecture interview/.test(joined),
      pairing: /pair(ing| programming)|live coding/.test(joined),
      values: /values|culture/.test(joined),
      recruiter_screen: /recruiter|screening call|intro call/.test(joined),
    },
    summary:
      stages.length > 0
        ? truncate(stages.slice(0, 3).join(' '), 400)
        : 'No description of the interview process was found on the retrieved pages.',
  };
}

// ---------------------------------------------------------------------------
// generate_questions
// ---------------------------------------------------------------------------

interface RequirementInput {
  id: string;
  text: string;
  kind: string;
  priority: string;
}

const TECHNICAL_TEMPLATES = [
  (topic: string, requirement: string) =>
    `Walk me through the most demanding piece of work you have done with ${topic}. What did you own end to end, and what would you change if you started it again today?`,
  (topic: string, requirement: string) =>
    `The posting asks for "${requirement}". Take us through how you would approach that in production - design, trade-offs, and how you would know it works.`,
  (topic: string, requirement: string) =>
    `How would you debug a problem in ${topic} that only reproduces under load in production? Talk through the signals you would reach for first.`,
];

const SYSTEM_DESIGN_TEMPLATES = [
  (topic: string, requirement: string) =>
    `Design a system that satisfies "${requirement}". Start with the constraints you would want to pin down, then sketch the components and where they would break first.`,
  (topic: string, requirement: string) =>
    `We need to scale ${topic} by an order of magnitude. Where does your current design fail, and what would you change before it does?`,
];

const BEHAVIOURAL_TEMPLATES = [
  (topic: string, requirement: string) =>
    `Tell me about a time ${topic} mattered on a project. What was the situation, what did you actually do, and how did it land?`,
  (topic: string, requirement: string) =>
    `The role expects "${requirement}". Give me a concrete example, including something that did not go the way you wanted.`,
  (topic: string, requirement: string) =>
    `How do you handle disagreement with a colleague about ${topic}? Walk me through a specific case.`,
];

const COMPANY_FIT_TEMPLATES = [
  (topic: string, requirement: string, company: string) =>
    `What draws you to ${company} specifically, and how does "${requirement}" connect to what we are building?`,
  (topic: string, requirement: string, company: string) =>
    `Given what you know about how ${company} works, where do you think your experience with ${topic} would have the most impact in the first ninety days?`,
];

function generateQuestions(payload: Record<string, unknown>): unknown {
  const category = String(payload.category ?? 'technical');
  const requirements = (payload.requirements as RequirementInput[] | undefined) ?? [];
  const company = String(payload.company ?? 'the company') || 'the company';
  const processSignals = (payload.process_signals as Record<string, boolean> | undefined) ?? {};
  const perRequirement = Math.max(1, Math.min(3, Number(payload.per_requirement ?? 1)));
  const random = createRandom(seedFrom(`${category}:${requirements.map((r) => r.id).join(',')}`));

  const questions: Array<Record<string, unknown>> = [];

  for (const requirement of requirements) {
    const topic = keyTopic(requirement.text);
    const wanted = requirement.priority === 'must' ? perRequirement : 1;
    // One offset per requirement, so a requirement that earns two questions
    // gets two different ones rather than the same template twice.
    const offset = Math.floor(random() * 3);
    for (let index = 0; index < wanted; index += 1) {
      const prompt = renderPrompt(category, topic, requirement.text, company, index + offset);
      questions.push({
        requirement_ids: [requirement.id],
        category,
        prompt,
        answer_outline: renderOutline(category, topic, requirement, processSignals),
        difficulty: difficultyFor(requirement, category, index),
      });
    }
  }

  // A published take-home or system-design round changes what is worth
  // rehearsing, so the process signals earn extra questions of their own.
  if (category === 'system-design' && processSignals.system_design && requirements[0]) {
    questions.push({
      requirement_ids: [requirements[0].id],
      category,
      prompt: `${company} runs a system design round. Take "${truncate(requirements[0].text, 90)}" and design for it out loud, stating your assumptions before you draw anything.`,
      answer_outline:
        'Clarify scope and scale first. Sketch the data model, then the request path, then the failure modes. Say which trade-off you are making and why. Finish with what you would measure.',
      difficulty: 3,
    });
  }
  if (category === 'company-fit' && processSignals.take_home && requirements[0]) {
    questions.push({
      requirement_ids: [requirements[0].id],
      category,
      prompt: `${company} uses a take-home exercise. How do you decide what to cut when a take-home is time-boxed, and how would you document those decisions?`,
      answer_outline:
        'Name the time box. Prioritise correctness and a readable seam over breadth. Write down what you deliberately left out and why. Mention how you would test the part you kept.',
      difficulty: 2,
    });
  }

  return { questions };
}

function renderPrompt(
  category: string,
  topic: string,
  requirement: string,
  company: string,
  index: number,
): string {
  const shortened = truncate(requirement, 120);
  switch (category) {
    case 'system-design': {
      const template = SYSTEM_DESIGN_TEMPLATES[index % SYSTEM_DESIGN_TEMPLATES.length]!;
      return template(topic, shortened);
    }
    case 'behavioural': {
      const template = BEHAVIOURAL_TEMPLATES[index % BEHAVIOURAL_TEMPLATES.length]!;
      return template(topic, shortened);
    }
    case 'company-fit': {
      const template = COMPANY_FIT_TEMPLATES[index % COMPANY_FIT_TEMPLATES.length]!;
      return template(topic, shortened, company);
    }
    default: {
      const template = TECHNICAL_TEMPLATES[index % TECHNICAL_TEMPLATES.length]!;
      return template(topic, shortened);
    }
  }
}

function renderOutline(
  category: string,
  topic: string,
  requirement: RequirementInput,
  signals: Record<string, boolean>,
): string {
  const base: string[] = [];
  switch (category) {
    case 'behavioural':
      base.push(
        'Use situation, task, action, result and keep the action section the longest.',
        `Anchor it in one real project where ${topic} was genuinely at stake.`,
        'Say what you would do differently; interviewers score reflection, not perfection.',
      );
      break;
    case 'system-design':
      base.push(
        'Restate the requirement as constraints (traffic, data size, consistency, latency).',
        `Sketch components, then show where ${topic} becomes the bottleneck.`,
        'Offer one trade-off explicitly and name the failure mode you accept.',
      );
      break;
    case 'company-fit':
      base.push(
        'Tie your answer to something specific you read about the company, not a generic pitch.',
        `Connect it back to "${truncate(requirement.text, 80)}".`,
        'End with a question of your own that shows you read the role.',
      );
      break;
    default:
      base.push(
        `Name the concrete system where you used ${topic} and your role in it.`,
        'Cover the mechanism, not just the tool: what the code did and why.',
        'Close with measurable impact and the limitation you hit.',
      );
  }
  if (signals.pairing) base.push('Expect to talk while you type: this company pairs during interviews.');
  return base.join(' ');
}

function difficultyFor(requirement: RequirementInput, category: string, index: number): number {
  let score = requirement.priority === 'must' ? 2 : 1;
  if (EXPERIENCE_PATTERN.test(requirement.text)) score += 1;
  if (category === 'system-design') score = Math.max(score, 3);
  if (SYSTEM_DESIGN_MARKERS.test(requirement.text)) score += 1;
  if (index > 0) score += 1;
  return Math.max(1, Math.min(3, score));
}

/** Best short label for a requirement: a named technology, else its head noun phrase. */
function keyTopic(text: string): string {
  const lower = ` ${text.toLowerCase()} `;
  const named = TECH_TOKENS.filter(
    (token) => lower.includes(` ${token} `) || lower.includes(`${token},`) || lower.includes(`${token}.`),
  );
  if (named.length > 0) {
    return named
      .slice(0, 2)
      .map((token) => (token.length <= 3 ? token.toUpperCase() : titleCase(token)))
      .join(' and ');
  }
  if (BEHAVIOURAL_MARKERS.test(text)) {
    const match = text.match(BEHAVIOURAL_MARKERS);
    if (match?.[0]) return match[0].toLowerCase();
  }
  // No named technology: strip the framing ("5+ years of experience with ...")
  // and keep the noun phrase that is left.
  const stripped = text
    .replace(/^\s*(strong|solid|proven|demonstrated|excellent|deep|hands[- ]on)\s+/i, '')
    .replace(/^\s*\d+\s*\+?\s*(?:-|to)?\s*\d*\s*years?\s*(of|with|in)?\s*/i, '')
    .replace(/^(professional|commercial|industry)\s+/i, '')
    .replace(
      /^(experience|familiarity|knowledge|proficiency|understanding|ability|expertise|background|track record)\s+(with|in|of|to|designing|building|operating)\s+/i,
      '',
    )
    .replace(/\s+(experience|skills)\b/i, '');
  const words = stripped.split(/\s+/).slice(0, 4).join(' ');
  return truncate(words.replace(/[.,;:]$/, ''), 60) || 'this requirement';
}

// ---------------------------------------------------------------------------
// generate_flashcards
// ---------------------------------------------------------------------------

function generateFlashcards(payload: Record<string, unknown>): unknown {
  const requirements = (payload.requirements as RequirementInput[] | undefined) ?? [];
  const facts = (payload.company_facts as string[] | undefined) ?? [];
  const company = String(payload.company ?? 'the company');

  const cards = requirements.map((requirement) => {
    const topic = keyTopic(requirement.text);
    return {
      requirement_ids: [requirement.id],
      front:
        requirement.kind === 'behavioural'
          ? `Story to have ready: ${topic}`
          : `What must you be able to show on ${topic}?`,
      back:
        requirement.kind === 'behavioural'
          ? `One concrete example where ${topic} decided the outcome, told as situation, action, result. Requirement: "${truncate(requirement.text, 110)}".`
          : `Depth on ${topic}: how it works, one production story, one trade-off you made. Requirement: "${truncate(requirement.text, 110)}".`,
    };
  });

  for (const fact of facts.slice(0, 3)) {
    cards.push({
      requirement_ids: [],
      front: `What do you know about ${company}?`,
      back: truncate(fact, 240),
    });
  }

  return { flashcards: cards };
}

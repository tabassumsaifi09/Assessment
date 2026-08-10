import type { LlmClient } from '../llm/client';
import type { Requirement, RequirementKind, RequirementPriority } from '../domain/types';
import { REQUIREMENT_KINDS, REQUIREMENT_PRIORITIES } from '../domain/types';
import { extractByRules, derivePriority, type RuleExtraction } from './ruleExtractor';
import type { OutlineLine } from './jdOutline';
import { classifyKind } from '../domain/lexicon';
import { contentTokens, dedupe, normaliseWhitespace, overlapRatio, truncate } from '../util/text';
import { UNTRUSTED_SYSTEM_RULE, wrapUntrusted } from '../security/untrusted';
import { logger } from '../util/logger';

export interface ExtractedRole {
  title: string;
  seniority: string;
  location: string;
  responsibilities: string[];
  requirements: Requirement[];
  /** True when the posting is too thin to carry a full kit. */
  thin: boolean;
  notes: string[];
  /** Model output we refused because the posting does not support it. */
  rejected: string[];
}

interface ModelRequirement {
  text: string;
  kind?: string;
  priority?: string;
}

interface ModelExtraction {
  title: string;
  seniority: string;
  location: string;
  responsibilities: string[];
  requirements: ModelRequirement[];
  notes: string[];
}

/**
 * Stage 1: read the posting.
 *
 * The model proposes; the code disposes. Three things are decided here rather
 * than by the model, because they are what the kit is graded on:
 *
 *  - grounding: a requirement whose wording is not supported by the posting is
 *    dropped. Reporting three requirements honestly beats inventing eight.
 *  - priority: must vs nice is re-derived from how the posting words the line
 *    and which section it sits in.
 *  - recall: any requirement line the rules found and the model missed is
 *    added back, so a lazy or truncated model cannot silently lose a must.
 *
 * Ids are assigned last, in posting order, so they are stable for a given
 * posting and every question can reference them.
 */
export async function extractRole(llm: LlmClient, jd: string): Promise<ExtractedRole> {
  const rules = extractByRules(jd);
  const fallback = toModelShape(rules);

  const { value: model, degraded } = await llm.jsonOrFallback<ModelExtraction>(
    {
      task: 'extract_jd',
      system:
        'You extract structured facts from a job posting. Use only what the posting states; never add a requirement it does not contain. ' +
        UNTRUSTED_SYSTEM_RULE +
        ' Reply as JSON: {"title": string, "seniority": string, "location": string, "responsibilities": string[], "requirements": [{"text": string, "kind": "technical"|"behavioural"|"domain", "priority": "must"|"nice"}], "notes": string[]}.',
      user: wrapUntrusted('job-description', jd, 14_000),
      payload: { jd },
      label: 'extract-jd',
    },
    validateExtraction,
    fallback,
  );

  if (degraded) {
    logger.info('extraction fell back to rule-based reading of the posting');
  }

  const jdTokens = contentTokens(jd);
  const rejected: string[] = [];
  const accepted: Array<{ text: string; kind: RequirementKind; priority: RequirementPriority; order: number }> = [];

  for (const candidate of model.requirements) {
    const text = normaliseWhitespace(candidate.text ?? '');
    if (text.length < 6) continue;

    // Grounding check: the wording has to come from the posting.
    if (overlapRatio(text, jdTokens) < 0.6) {
      rejected.push(text);
      continue;
    }

    const line = bestLineMatch(text, rules.outline.lines);
    const priority = normalisePriority(candidate.priority, line, text);
    const kind = normaliseKind(candidate.kind, text);
    accepted.push({
      text,
      kind,
      priority,
      order: line ? line.index : Number.MAX_SAFE_INTEGER,
    });
  }

  // Recall guard: rule-derived requirements the model did not return.
  for (const ruleRequirement of rules.requirements) {
    const alreadyCovered = accepted.some(
      (item) => overlapRatio(ruleRequirement.text, contentTokens(item.text)) > 0.7,
    );
    if (alreadyCovered) continue;
    accepted.push({
      text: ruleRequirement.text,
      kind: ruleRequirement.kind,
      priority: ruleRequirement.priority,
      order: ruleRequirement.sourceIndex,
    });
  }

  const ordered = dedupeByText(accepted).sort((a, b) => a.order - b.order);
  const requirements: Requirement[] = ordered.map((item, index) => ({
    id: `r${index + 1}`,
    text: truncate(item.text, 400),
    kind: item.kind,
    priority: item.priority,
  }));

  const notes = dedupe([
    ...(Array.isArray(model.notes) ? model.notes : []),
    ...rules.notes,
    ...(rejected.length > 0
      ? [`${rejected.length} proposed requirement(s) were dropped as unsupported by the posting.`]
      : []),
    ...(degraded ? ['The model was unavailable; the posting was read with rule-based extraction only.'] : []),
  ]);

  return {
    title: model.title || rules.title,
    seniority: model.seniority || rules.seniority,
    location: model.location || rules.location,
    responsibilities: dedupe([...(model.responsibilities ?? []), ...rules.responsibilities]).slice(0, 14),
    requirements,
    thin: rules.thin || requirements.length <= 2,
    notes,
    rejected,
  };
}

function toModelShape(rules: RuleExtraction): ModelExtraction {
  return {
    title: rules.title,
    seniority: rules.seniority,
    location: rules.location,
    responsibilities: rules.responsibilities,
    requirements: rules.requirements.map((requirement) => ({
      text: requirement.text,
      kind: requirement.kind,
      priority: requirement.priority,
    })),
    notes: rules.notes,
  };
}

function validateExtraction(value: unknown): ModelExtraction {
  if (typeof value !== 'object' || value === null) throw new Error('expected an object');
  const record = value as Record<string, unknown>;
  const requirements = Array.isArray(record.requirements) ? record.requirements : [];
  return {
    title: typeof record.title === 'string' ? record.title : '',
    seniority: typeof record.seniority === 'string' ? record.seniority : '',
    location: typeof record.location === 'string' ? record.location : '',
    responsibilities: asStringArray(record.responsibilities),
    requirements: requirements
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      .map((item) => ({
        text: typeof item.text === 'string' ? item.text : '',
        kind: typeof item.kind === 'string' ? item.kind : undefined,
        priority: typeof item.priority === 'string' ? item.priority : undefined,
      }))
      .filter((item) => item.text.trim().length > 0),
    notes: asStringArray(record.notes),
  };
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** Finds the posting line a requirement came from, for section context. */
function bestLineMatch(text: string, lines: OutlineLine[]): OutlineLine | null {
  let best: OutlineLine | null = null;
  let bestScore = 0;
  for (const line of lines) {
    const score = overlapRatio(text, contentTokens(line.text));
    if (score > bestScore) {
      bestScore = score;
      best = line;
    }
  }
  return bestScore >= 0.5 ? best : null;
}

function normalisePriority(
  proposed: string | undefined,
  line: OutlineLine | null,
  text: string,
): RequirementPriority {
  // The posting's own wording wins. The model's opinion is only used when the
  // line cannot be located, and even then it is validated against the enum.
  const derived = derivePriority(line?.text ?? text, line?.section ?? 'unknown');
  if (line) return derived;
  const candidate = (proposed ?? '').toLowerCase();
  return REQUIREMENT_PRIORITIES.includes(candidate as RequirementPriority)
    ? (candidate as RequirementPriority)
    : derived;
}

function normaliseKind(proposed: string | undefined, text: string): RequirementKind {
  const candidate = (proposed ?? '').toLowerCase();
  if (REQUIREMENT_KINDS.includes(candidate as RequirementKind)) return candidate as RequirementKind;
  return classifyKind(text);
}

function dedupeByText<T extends { text: string; priority: RequirementPriority }>(items: T[]): T[] {
  const out: T[] = [];
  for (const item of items) {
    const duplicate = out.find(
      (existing) => overlapRatio(item.text, contentTokens(existing.text)) > 0.85,
    );
    if (duplicate) {
      // Keep the stricter reading if the same requirement appears twice.
      if (duplicate.priority === 'nice' && item.priority === 'must') duplicate.priority = 'must';
      continue;
    }
    out.push(item);
  }
  return out;
}

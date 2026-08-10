import { buildOutline, candidateRequirementLines, type JdOutline } from './jdOutline';
import {
  EXPERIENCE_PATTERN,
  MUST_MARKERS,
  NICE_MARKERS,
  classifyKind,
  isNoise,
  looksTechnical,
  type SectionType,
} from '../domain/lexicon';
import { dedupe, normaliseWhitespace, truncate } from '../util/text';

export interface RuleRequirement {
  text: string;
  kind: 'technical' | 'behavioural' | 'domain';
  priority: 'must' | 'nice';
  /** Where in the posting the line came from - used to prove it is grounded. */
  sourceIndex: number;
  section: SectionType;
}

export interface RuleExtraction {
  title: string;
  seniority: string;
  location: string;
  responsibilities: string[];
  requirements: RuleRequirement[];
  thin: boolean;
  notes: string[];
  outline: JdOutline;
}

const SENIORITY_RULES: Array<[RegExp, string]> = [
  [/\bprincipal\b/i, 'principal'],
  [/\bstaff\b/i, 'staff'],
  [/\b(head of|director|vp)\b/i, 'leadership'],
  [/\b(senior|sr\.?)\b/i, 'senior'],
  [/\b(lead|tech lead)\b/i, 'lead'],
  [/\b(mid[- ]level|intermediate)\b/i, 'mid'],
  [/\b(junior|jr\.?|entry[- ]level|graduate|intern)\b/i, 'junior'],
];

/**
 * A bullet that opens with a bare verb is a duty ("Build and ship features"),
 * not a requirement. Reading those as requirements is the main way a kit ends
 * up asserting things the posting never asked for.
 */
const RESPONSIBILITY_VERBS =
  /^(build|design|ship|own|lead|work|collaborate|develop|maintain|drive|partner|contribute|deliver|improve|support|create|define|implement|write|help|participate|review|scale|operate|monitor|manage|coordinate|run|grow|mentor|champion|advocate)\b/i;

const REQUIREMENT_OPENERS =
  /^(experience|familiarity|knowledge|proficien|understanding|ability|strong|solid|comfortable|fluent|expertise|background|excellent|demonstrated|proven|track record|degree|bsc|msc|you have|you should|we expect|hands[- ]on|deep|passion|willingness|fluency)\b/i;

/**
 * Short postings rarely use a Requirements heading; they say "we need someone
 * who knows Python". Those sentences are requirements too, and missing them is
 * how a two-line posting produces an empty kit.
 */
const NEEDS_PHRASES =
  /\b(we (need|want|require|are looking for|are seeking)|looking for (someone|a|an)|you (will need|should know|must know|need to)|candidates? (should|must|will)|the ideal candidate|ideally you)\b/i;

/** Strips the framing from a needs-phrase so the requirement reads cleanly. */
const NEEDS_PREFIX =
  /^(we (need|want|require|are looking for|are seeking)\s*(someone|a|an)?\s*(who|that|to)?\s*|looking for (someone|a|an)\s*(who|that)?\s*|the ideal candidate (will|should|must)\s*(have|be)?\s*|you (will need to|should|must|need to)\s*(have|be)?\s*|candidates? (should|must|will)\s*(have|be)?\s*)/i;

/**
 * Rule-based reading of a posting.
 *
 * Two callers use this: the offline model, as its "understanding" of the text,
 * and the extraction verifier, which re-derives priority and grounding from
 * the posting rather than trusting whatever the model returned. Keeping it in
 * one place means the two never drift apart.
 */
export function extractByRules(jd: string): RuleExtraction {
  const outline = buildOutline(jd);
  const headline = outline.headline;

  const title = normaliseWhitespace(
    headline
      .split(/\s+[-|]\s+| at | @ /i)[0]
      ?.replace(/^(job (title|description)|role|position)\s*[:-]\s*/i, '') ?? '',
  );

  let seniority = '';
  for (const [pattern, label] of SENIORITY_RULES) {
    if (pattern.test(headline) || pattern.test(jd.slice(0, 400))) {
      seniority = label;
      break;
    }
  }

  const responsibilities: string[] = [];
  const requirements: RuleRequirement[] = [];

  for (const line of candidateRequirementLines(outline)) {
    if (line.index === 0) continue; // the headline is the title, not a requirement
    if (isNoise(line.text)) continue;
    const text = line.text.replace(/[.;]+$/, '');
    const words = text.split(/\s+/).length;
    // "Kubernetes experience" is two words and a real requirement; a single
    // stray word is not, unless it names a technology.
    if (words < 2 && !looksTechnical(text)) continue;

    if (line.section === 'responsibilities') {
      responsibilities.push(text);
      continue;
    }

    const explicitRequirementSection = line.section === 'requirements' || line.section === 'nice';
    const needsPhrase = NEEDS_PHRASES.test(text);
    const looksLikeRequirement =
      explicitRequirementSection ||
      needsPhrase ||
      MUST_MARKERS.test(text) ||
      NICE_MARKERS.test(text) ||
      EXPERIENCE_PATTERN.test(text) ||
      REQUIREMENT_OPENERS.test(text);
    const looksLikeDuty =
      !explicitRequirementSection && !needsPhrase && RESPONSIBILITY_VERBS.test(text);

    if (looksLikeRequirement && !looksLikeDuty) {
      for (const clause of splitRequirementClauses(cleanRequirementText(text))) {
        requirements.push({
          text: clause,
          kind: classifyKind(clause),
          priority: derivePriority(text, line.section),
          sourceIndex: line.index,
          section: line.section,
        });
      }
    } else if (looksLikeDuty) {
      responsibilities.push(text);
    }
  }

  const notes: string[] = [];
  if (outline.thin) {
    notes.push('The posting is very short, so only what it literally states has been extracted.');
  }
  if (requirements.length === 0) {
    notes.push('No explicit requirements were stated in the posting.');
  }

  return {
    title: title || 'Unspecified role',
    seniority,
    location: findLocation(outline.lines.map((line) => line.text)),
    responsibilities: dedupe(responsibilities).slice(0, 12),
    requirements: dedupeRequirements(requirements).slice(0, 24),
    thin: outline.thin,
    notes,
    outline,
  };
}

/** Removes the framing of a needs-phrase so the requirement reads on its own. */
export function cleanRequirementText(text: string): string {
  const stripped = normaliseWhitespace(text.replace(NEEDS_PREFIX, '')).replace(/[.;]+$/, '');
  if (!stripped) return text;
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

/**
 * A terse posting packs two requirements into one sentence: "knows Python and
 * can work independently". We split only when the second half opens with its
 * own verb, so "React and TypeScript" stays a single requirement.
 */
const CLAUSE_VERB =
  /^(can|could|is able to|are able to|has|have|knows|understands|is comfortable|are comfortable|enjoys|thrives|works|communicates|writes|owns|takes ownership)\b/i;

export function splitRequirementClauses(text: string): string[] {
  if (text.length > 160) return [text];
  const parts = text.split(/\s+(?:and|&)\s+/i);
  if (parts.length !== 2) return [text];
  const [left, right] = parts as [string, string];
  if (left.split(/\s+/).length < 2 || right.split(/\s+/).length < 2) return [text];
  if (!CLAUSE_VERB.test(right.trim())) return [text];
  return [left.trim(), capitalise(right.trim())];
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * Priority comes from how the posting words the line, never from the model.
 * "Bonus points for Kubernetes" and "Must have Kubernetes" are different
 * claims and the kit has to keep them apart.
 */
export function derivePriority(text: string, section: SectionType): 'must' | 'nice' {
  if (NICE_MARKERS.test(text)) return 'nice';
  if (section === 'nice') return 'nice';
  return 'must';
}

export function dedupeRequirements(requirements: RuleRequirement[]): RuleRequirement[] {
  const seen = new Set<string>();
  const out: RuleRequirement[] = [];
  for (const requirement of requirements) {
    const key = requirement.text
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(requirement);
  }
  return out;
}

export function findLocation(lines: string[]): string {
  for (const line of lines) {
    const labelled = line.match(/^location\s*[:-]\s*(.+)$/i);
    if (labelled?.[1]) return truncate(normaliseWhitespace(labelled[1]), 80);
  }
  for (const line of lines) {
    const inline = line.match(
      /\b(fully remote|remote[- ]first|remote \(([^)]+)\)|remote|hybrid(?: in [A-Z][a-zA-Z ]+)?|on-?site in [A-Z][a-zA-Z ]+|based in [A-Z][a-zA-Z ]+)\b/,
    );
    if (inline?.[0]) return truncate(normaliseWhitespace(inline[0]), 80);
  }
  return '';
}

import { detectSectionType, type SectionType } from '../domain/lexicon';
import { stripBulletMarker, toLines, normaliseWhitespace, sentenceSplit } from '../util/text';

export interface OutlineLine {
  /** Cleaned text of the line. */
  text: string;
  /** Section the line sits under, or 'unknown' for an unstructured posting. */
  section: SectionType;
  /** Was the line written as a bullet? */
  bullet: boolean;
  /** Position in the posting, used for stable ordering. */
  index: number;
}

export interface JdOutline {
  /** First non-empty line - almost always the role title. */
  headline: string;
  lines: OutlineLine[];
  /** Total characters of the original posting. */
  chars: number;
  /** True when the posting is too short to carry a real requirement list. */
  thin: boolean;
}

const BULLET_PREFIX = /^\s*([-*•·–—▪‣>]|\(?\d{1,2}[.)]|[a-z][.)])\s+/i;

/**
 * Turns a pasted posting into an ordered list of lines tagged with the section
 * they belong to. This is plain parsing - no model involved - and everything
 * downstream (the offline model, the priority rules, the grounding check)
 * reads the same outline.
 */
export function buildOutline(jd: string): JdOutline {
  const rawLines = toLines(jd);
  const lines: OutlineLine[] = [];
  let section: SectionType = 'unknown';
  let index = 0;

  for (const rawLine of rawLines) {
    const headingType = detectSectionType(rawLine);
    const bullet = BULLET_PREFIX.test(rawLine);
    if (headingType !== 'unknown' && !bullet) {
      section = headingType;
      continue;
    }

    const cleaned = normaliseWhitespace(stripBulletMarker(rawLine));
    if (!cleaned) continue;

    // A paragraph can hold several requirements in one breath. Split it so a
    // "we need X and you should also have Y" line is not collapsed into one.
    const parts = cleaned.length > 220 ? sentenceSplit(cleaned) : [cleaned];
    for (const part of parts) {
      if (!part) continue;
      lines.push({ text: part, section, bullet, index: index++ });
    }
  }

  const headline = lines[0]?.text ?? '';
  const chars = jd.length;
  return {
    headline,
    lines,
    chars,
    thin: chars < 320 || lines.length <= 3,
  };
}

/** Lines that could plausibly be requirements, in posting order. */
export function candidateRequirementLines(outline: JdOutline): OutlineLine[] {
  return outline.lines.filter((line) => line.section !== 'benefits' && line.text.length >= 8);
}

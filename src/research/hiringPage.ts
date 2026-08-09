import type { CrawledPage } from './crawler';

export type PageKind = 'hiring' | 'about' | 'other';

export interface ClassifiedPage {
  url: string;
  title: string;
  kind: PageKind;
  confidence: number;
  text: string;
  signals: string[];
}

/**
 * Page classification runs on what a page actually says, not on where it
 * lives. The link ranker decides what to fetch; this decides what we found.
 * A /handbook/people/hiring page that walks through four interview stages
 * scores as hiring, and a /careers page that is only a job board scores as
 * hiring but with lower confidence.
 */
const HIRING_CONTENT: Array<[RegExp, number, string]> = [
  [/\b(interview process|hiring process|how we hire|our process|what to expect)\b/gi, 6, 'documents its process'],
  [/\b(take[- ]home|coding challenge|technical (interview|assessment|exercise)|system design (interview|round)|pair(ing)? (interview|session)|live coding)\b/gi, 4, 'names interview stages'],
  [/\b(recruiter (screen|call)|first (call|stage)|final (round|stage)|panel|onsite|offer stage|values interview)\b/gi, 3, 'names interview stages'],
  [/\b(open (roles|positions)|apply now|view (job|role)|job description|we are hiring|join our team|current openings?)\b/gi, 2, 'lists open roles'],
];

const ABOUT_CONTENT: Array<[RegExp, number, string]> = [
  [/\b(our mission|we (build|make|help|provide|offer|are)|our (product|platform|story|team|company)|the platform|founded in|founded by|headquartered|what we do)\b/gi, 4, 'describes the company'],
  [/\b(customers|clients|users|teams use|trusted by|our values|about us|the company|builds?|provides?|helps? (teams|companies|businesses))\b/gi, 2, 'describes the company'],
];

function countMatches(text: string, pattern: RegExp): number {
  const matches = text.match(pattern);
  return matches ? matches.length : 0;
}

export function classifyPage(page: CrawledPage): ClassifiedPage {
  const text = page.parsed.text;
  const haystack = `${page.parsed.title} ${page.parsed.description} ${text}`.slice(0, 20_000);

  let hiringScore = 0;
  let aboutScore = 0;
  const signals: string[] = [];

  for (const [pattern, weight, reason] of HIRING_CONTENT) {
    const hits = countMatches(haystack, pattern);
    if (hits > 0) {
      hiringScore += weight * Math.min(3, hits);
      signals.push(reason);
    }
  }
  for (const [pattern, weight, reason] of ABOUT_CONTENT) {
    const hits = countMatches(haystack, pattern);
    if (hits > 0) {
      aboutScore += weight * Math.min(3, hits);
      signals.push(reason);
    }
  }

  // The URL is a weak tiebreaker only - it never decides on its own.
  const path = safePath(page.url);
  if (/(career|job|hiring|join|work-with-us|handbook)/i.test(path)) hiringScore += 3;
  if (/(about|company|mission|story|what-we-do)/i.test(path)) aboutScore += 3;
  if (page.depth === 0) aboutScore += 2; // a homepage is the fallback "about"

  const kind: PageKind =
    hiringScore >= 8 && hiringScore >= aboutScore
      ? 'hiring'
      : aboutScore >= 5
        ? 'about'
        : 'other';

  return {
    url: page.url,
    title: page.parsed.title,
    kind,
    confidence: Math.min(1, Math.max(hiringScore, aboutScore) / 20),
    text,
    signals: [...new Set(signals)].slice(0, 5),
  };
}

export function classifyPages(pages: CrawledPage[]): ClassifiedPage[] {
  return pages.map(classifyPage);
}

function safePath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

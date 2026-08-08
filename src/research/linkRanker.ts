import type { ExtractedLink } from '../retrieval/html';

export type LinkIntent = 'hiring' | 'about';

export interface RankedLink {
  url: string;
  text: string;
  score: number;
  intents: LinkIntent[];
  depth: number;
  reasons: string[];
}

/**
 * Link ranking.
 *
 * There is no fixed list of paths here on purpose. Companies put their hiring
 * material at /careers, /jobs, /handbook/hiring, /blog/how-we-interview, or on
 * a third-party applicant tracker, and guessing paths is exactly the approach
 * the brief calls insufficient. Instead every link is scored on the words in
 * its anchor text and its URL, penalised for depth and for the parts of a site
 * that never carry company information, and the crawler fetches the best ones.
 */
const HIRING_TERMS: Array<[RegExp, number, string]> = [
  [/\b(how we hire|hiring process|interview process|our process|recruiting process)\b/, 10, 'explicit hiring-process wording'],
  [/\b(careers?|jobs?|vacanc|open roles|open positions|opportunities|join us|work with us|work here|we.?re hiring|hiring)\b/, 7, 'careers wording'],
  [/\b(interview|interviewing|recruit(ing|ment)?|talent|apply|application)\b/, 5, 'recruiting wording'],
  [/\b(handbook|playbook|people|working at|life at)\b/, 4, 'handbook wording'],
  [/\b(culture|team|values|engineering blog)\b/, 3, 'culture wording'],
];

const ABOUT_TERMS: Array<[RegExp, number, string]> = [
  [/\b(about( us)?|who we are|our (story|mission|company)|company)\b/, 7, 'about wording'],
  [/\b(what we do|product|platform|solutions?|services?|technology)\b/, 5, 'product wording'],
  [/\b(mission|values|customers?|case stud|blog|news|press|docs|engineering)\b/, 2, 'supporting wording'],
];

const PENALTIES: Array<[RegExp, number, string]> = [
  [/\b(login|log-in|sign-?in|sign-?up|account|dashboard|checkout|cart|basket)\b/, -12, 'authenticated area'],
  [/\b(privacy|terms|cookie|legal|gdpr|dpa|imprint|security-policy)\b/, -10, 'legal boilerplate'],
  [/\b(status|support|help|faq|contact|pricing|download|webinar|event|newsletter)\b/, -3, 'peripheral page'],
  [/\.(pdf|zip|png|jpe?g|gif|svg|mp4|mp3|css|js|ico|webp|woff2?)($|\?)/, -20, 'not a document we can read'],
  [/\b(tag|category|archive|page\/\d+|\d{4}\/\d{2})\b/, -4, 'index or archive page'],
];

/** Applicant tracking systems: an off-site careers page is still the careers page. */
const ATS_HOSTS =
  /(greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|smartrecruiters\.com|bamboohr\.com|teamtailor\.com|recruitee\.com|personio\.|jobvite\.com|breezy\.hr|workday(jobs)?\.com)/i;

export function scoreLink(link: ExtractedLink, depth: number, baseHost: string): RankedLink {
  const anchor = link.text.toLowerCase();
  let path = '';
  let host = '';
  try {
    const parsed = new URL(link.url);
    path = decodeURIComponent(`${parsed.pathname}${parsed.search}`).toLowerCase().replace(/[-_/]+/g, ' ');
    host = parsed.host.toLowerCase();
  } catch {
    path = link.url.toLowerCase();
  }
  const haystack = `${anchor} ${path}`;

  let score = 0;
  const intents = new Set<LinkIntent>();
  const reasons: string[] = [];

  for (const [pattern, weight, reason] of HIRING_TERMS) {
    if (pattern.test(haystack)) {
      score += weight;
      intents.add('hiring');
      reasons.push(reason);
    }
  }
  for (const [pattern, weight, reason] of ABOUT_TERMS) {
    if (pattern.test(haystack)) {
      score += weight;
      intents.add('about');
      reasons.push(reason);
    }
  }
  for (const [pattern, weight, reason] of PENALTIES) {
    if (pattern.test(haystack)) {
      score += weight;
      reasons.push(reason);
    }
  }

  if (!link.internal) {
    if (ATS_HOSTS.test(host)) {
      score += 6;
      intents.add('hiring');
      reasons.push('applicant tracking system');
    } else {
      score -= 15;
      reasons.push('off-site link');
    }
  }

  // Shallow pages are more likely to be the canonical about/careers page, but
  // the penalty stays mild: a hiring process three levels into a handbook is
  // exactly the case a fixed path list misses.
  score -= depth * 1.5;
  const segments = path.split(' ').filter(Boolean).length;
  if (segments > 4) score -= 2;
  if (segments === 0) score -= 1; // the homepage itself

  return {
    url: link.url,
    text: link.text,
    score,
    intents: [...intents],
    depth,
    reasons: reasons.slice(0, 4),
  };
}

export function rankLinks(
  links: ExtractedLink[],
  depth: number,
  baseHost: string,
): RankedLink[] {
  return links
    .map((link) => scoreLink(link, depth, baseHost))
    .sort((a, b) => b.score - a.score);
}

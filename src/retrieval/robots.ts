/**
 * robots.txt handling.
 *
 * We honour Disallow rules for our own user-agent and for `*`, and we honour
 * Crawl-delay when a site publishes one. A site with no robots.txt, or one we
 * cannot read, is treated as "allowed" - which is the conventional reading,
 * not an excuse to ignore an explicit rule.
 */
export interface RobotsRules {
  disallow: string[];
  allow: string[];
  crawlDelayMs: number | null;
  sitemaps: string[];
}

export const EMPTY_ROBOTS: RobotsRules = {
  disallow: [],
  allow: [],
  crawlDelayMs: null,
  sitemaps: [],
};

export function parseRobots(body: string, userAgent = 'interview-prep-kit'): RobotsRules {
  const rules: RobotsRules = { disallow: [], allow: [], crawlDelayMs: null, sitemaps: [] };
  let applies = false;
  let sawSpecificGroup = false;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.split('#')[0]!.trim();
    if (!line) continue;
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === 'sitemap') {
      rules.sitemaps.push(value);
      continue;
    }
    if (field === 'user-agent') {
      const agent = value.toLowerCase();
      const specific = agent === userAgent.toLowerCase();
      if (specific) sawSpecificGroup = true;
      applies = specific || (agent === '*' && !sawSpecificGroup);
      continue;
    }
    if (!applies) continue;
    if (field === 'disallow' && value) rules.disallow.push(value);
    if (field === 'allow' && value) rules.allow.push(value);
    if (field === 'crawl-delay') {
      const seconds = Number(value);
      if (Number.isFinite(seconds)) rules.crawlDelayMs = Math.min(10_000, seconds * 1000);
    }
  }
  return rules;
}

function matches(pattern: string, path: string): boolean {
  // robots.txt wildcards: * for any run, $ for end-of-path anchoring.
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\\\$$/, '$');
  try {
    return new RegExp(`^${escaped}`).test(path);
  } catch {
    return path.startsWith(pattern);
  }
}

export function isAllowed(rules: RobotsRules, url: string): boolean {
  let path: string;
  try {
    const parsed = new URL(url);
    path = `${parsed.pathname}${parsed.search}`;
  } catch {
    return false;
  }
  const longestMatch = (patterns: string[]) =>
    patterns.filter((pattern) => matches(pattern, path)).sort((a, b) => b.length - a.length)[0];

  const allow = longestMatch(rules.allow);
  const disallow = longestMatch(rules.disallow);
  if (!disallow) return true;
  if (allow && allow.length >= disallow.length) return true;
  return false;
}

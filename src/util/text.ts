/** Small text helpers shared by extraction, ranking and generation. */

export function normaliseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function stripBulletMarker(line: string): string {
  return line
    .replace(/^\s*[-*•·–—▪‣>]+\s*/, '')
    .replace(/^\s*\(?\d{1,2}[.)]\s+/, '')
    .replace(/^\s*[a-z][.)]\s+/i, '')
    .trim();
}

export function toLines(value: string): string[] {
  return value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'or', 'the', 'to', 'of', 'in', 'on', 'for', 'with', 'you',
  'your', 'we', 'our', 'is', 'are', 'be', 'as', 'at', 'by', 'from', 'that',
  'this', 'it', 'will', 'have', 'has', 'able', 'across', 'their', 'them',
]);

export function tokenise(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9+#./ -]/g, ' ')
    .split(/[\s/]+/)
    .map((token) => token.replace(/^[-.]+|[-.]+$/g, ''))
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

export function contentTokens(value: string): Set<string> {
  return new Set(tokenise(value));
}

/** Share of `candidate` tokens that also occur in `reference`. */
export function overlapRatio(candidate: string, reference: Set<string>): number {
  const tokens = tokenise(candidate);
  if (tokens.length === 0) return 0;
  let hits = 0;
  for (const token of tokens) {
    if (reference.has(token)) hits += 1;
  }
  return hits / tokens.length;
}

export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

export function titleCase(value: string): string {
  return value
    .split(/\s+/)
    .map((word) => (word.length > 2 ? word[0]!.toUpperCase() + word.slice(1) : word))
    .join(' ');
}

/** Deduplicate strings case-insensitively, preserving first-seen order. */
export function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(value.trim());
  }
  return out;
}

export function sentenceSplit(value: string): string[] {
  return value
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?;])\s+(?=[A-Z0-9])/)
    .map((part) => part.trim())
    .filter(Boolean);
}

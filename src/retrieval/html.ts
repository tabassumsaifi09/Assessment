import { normaliseWhitespace } from '../util/text';

export interface ExtractedLink {
  url: string;
  /** Anchor text, which is usually a better ranking signal than the path. */
  text: string;
  /** True when the link points at the same registrable host. */
  internal: boolean;
}

export interface ParsedPage {
  title: string;
  description: string;
  text: string;
  links: ExtractedLink[];
}

const BLOCK_ELEMENTS =
  /<\/?(p|div|section|article|header|footer|main|nav|ul|ol|li|h1|h2|h3|h4|h5|h6|br|tr|td|th|table|blockquote|figcaption)[^>]*>/gi;

/**
 * Deliberately dependency-free HTML handling. We need three things from a
 * page - its title, its readable text and its links resolved against the base
 * URL - and a parser for that is smaller than the argument for adding one.
 */
export function parseHtml(html: string, baseUrl: string): ParsedPage {
  const title = decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').trim();
  const description = decode(
    html.match(
      /<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i,
    )?.[1] ??
      html.match(
        /<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']*)["']/i,
      )?.[1] ??
      '',
  ).trim();

  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    // Source newlines inside a paragraph are not sentence boundaries; only the
    // block elements below are, so flatten the raw whitespace first.
    .replace(/\s+/g, ' ');

  // Block boundaries become newlines and survive: a nav bar collapsed into the
  // first paragraph is how a company brief ends up quoting "Home Pricing About".
  const text = decode(body.replace(BLOCK_ELEMENTS, '\n').replace(/<[^>]+>/g, ' '))
    .split('\n')
    .map((line) => normaliseWhitespace(line))
    .filter((line) => line.length > 0)
    .join('\n');

  return { title, description, text, links: extractLinks(html, baseUrl) };
}

export function extractLinks(html: string, baseUrl: string): ExtractedLink[] {
  const links: ExtractedLink[] = [];
  const seen = new Set<string>();
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return links;
  }

  const anchorPattern = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = anchorPattern.exec(html)) !== null) {
    const href = match[1]!.trim();
    if (!href || href.startsWith('#')) continue;
    if (/^(mailto:|tel:|javascript:|data:)/i.test(href)) continue;

    let resolved: URL;
    try {
      // Relative links resolve against the page they were found on, which is
      // what makes a locally served fixture site crawlable.
      resolved = new URL(href, base);
    } catch {
      continue;
    }
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') continue;
    resolved.hash = '';

    const key = resolved.toString();
    if (seen.has(key)) continue;
    seen.add(key);

    links.push({
      url: key,
      text: normaliseWhitespace(decode(match[2]!.replace(/<[^>]+>/g, ' '))).slice(0, 160),
      internal: sameSite(resolved, base),
    });
  }
  return links;
}

function sameSite(candidate: URL, base: URL): boolean {
  if (candidate.host === base.host) return true;
  const strip = (host: string) => host.replace(/^www\./, '');
  return strip(candidate.host) === strip(base.host);
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '-',
  ndash: '-',
  hellip: '...',
  rsquo: "'",
  lsquo: "'",
  ldquo: '"',
  rdquo: '"',
};

export function decode(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (whole, name: string) => ENTITIES[name.toLowerCase()] ?? whole);
}

/** Very small sitemap reader - only the <loc> entries are of interest. */
export function extractSitemapUrls(xml: string): string[] {
  const urls: string[] = [];
  const pattern = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null) urls.push(match[1]!);
  return urls;
}

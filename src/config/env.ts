import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Configuration.
 *
 * A tiny .env reader instead of `dotenv`: the file format we need is three
 * lines of parsing and one less dependency to install from a clean clone.
 * Values already present in the real environment always win, so deployment
 * platforms that inject variables behave as expected.
 */
function loadDotEnv(file = '.env'): void {
  const path = resolve(process.cwd(), file);
  if (!existsSync(path)) return;
  const contents = readFileSync(path, 'utf8');
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function str(name: string, fallback = ''): string {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === '' ? fallback : raw.trim();
}

function bool(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

export interface AppConfig {
  llm: {
    provider: string;
    baseUrl: string;
    apiKey: string;
    model: string;
    maxConcurrency: number;
    requestsPerMinute: number;
    tokensPerMinute: number;
    maxAttempts: number;
    timeoutMs: number;
  };
  retrieval: {
    timeoutMs: number;
    maxBytes: number;
    crawlDelayMs: number;
    maxPages: number;
    maxDepth: number;
    allowPrivateNetwork: boolean;
  };
  search: {
    provider: string;
    braveApiKey: string;
  };
  persistence: {
    mongoUri: string;
    storeDir: string;
  };
  api: {
    port: number;
    sessionSecret: string;
    sessionTtlHours: number;
  };
  pipeline: {
    maxCoveragePasses: number;
  };
}

export function loadConfig(): AppConfig {
  const hasKey = str('LLM_API_KEY') !== '';
  return {
    llm: {
      // Without a key there is nothing to talk to, so fall back to the
      // deterministic offline model rather than failing at request time.
      provider: str('LLM_PROVIDER', hasKey ? 'openai-compatible' : 'mock'),
      baseUrl: str('LLM_BASE_URL', 'https://api.groq.com/openai/v1'),
      apiKey: str('LLM_API_KEY'),
      model: str('LLM_MODEL', 'llama-3.1-8b-instant'),
      maxConcurrency: num('LLM_MAX_CONCURRENCY', 2),
      requestsPerMinute: num('LLM_REQUESTS_PER_MINUTE', 25),
      tokensPerMinute: num('LLM_TOKENS_PER_MINUTE', 12000),
      maxAttempts: num('LLM_MAX_ATTEMPTS', 4),
      timeoutMs: num('LLM_TIMEOUT_MS', 45000),
    },
    retrieval: {
      timeoutMs: num('FETCH_TIMEOUT_MS', 10000),
      maxBytes: num('FETCH_MAX_BYTES', 2_000_000),
      crawlDelayMs: num('CRAWL_DELAY_MS', 400),
      maxPages: num('CRAWL_MAX_PAGES', 14),
      maxDepth: num('CRAWL_MAX_DEPTH', 3),
      allowPrivateNetwork: bool('ALLOW_PRIVATE_NETWORK', false),
    },
    search: {
      provider: str('SEARCH_PROVIDER', 'duckduckgo'),
      braveApiKey: str('BRAVE_API_KEY'),
    },
    persistence: {
      mongoUri: str('MONGODB_URI'),
      storeDir: str('KIT_STORE_DIR', '.data'),
    },
    api: {
      port: num('PORT', 4000),
      sessionSecret: str('SESSION_SECRET', 'dev-only-secret'),
      sessionTtlHours: num('SESSION_TTL_HOURS', 12),
    },
    pipeline: {
      maxCoveragePasses: Math.max(2, num('MAX_COVERAGE_PASSES', 3)),
    },
  };
}

export const config = loadConfig();

import { sleep } from '../util/async';
import { LlmError } from './errors';
import { logger } from '../util/logger';

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  label: string;
}

function delayFor(attempt: number, options: RetryOptions, error: unknown): number {
  const base = options.baseDelayMs ?? 600;
  const max = options.maxDelayMs ?? 20_000;
  if (error instanceof LlmError && error.retryAfterMs !== undefined) {
    // The provider told us how long to wait. Believe it, within reason.
    return Math.min(max, error.retryAfterMs + 100);
  }
  const exponential = Math.min(max, base * 2 ** (attempt - 1));
  const jitter = Math.random() * exponential * 0.3;
  return Math.round(exponential + jitter);
}

function isRetryable(error: unknown): boolean {
  if (error instanceof LlmError) return error.retryable;
  const name = (error as { name?: string })?.name ?? '';
  return name === 'TimeoutError' || name === 'AbortError' || name === 'FetchError';
}

/**
 * Exponential backoff with jitter, honouring Retry-After when the provider
 * sends one. `onRetry` lets the caller stiffen the prompt between attempts,
 * which is how we recover from malformed JSON.
 */
export async function withRetry<T>(
  options: RetryOptions,
  work: (attempt: number, previousError?: unknown) => Promise<T>,
  onRetry?: (error: unknown, attempt: number) => void,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    try {
      return await work(attempt, lastError);
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === options.maxAttempts) throw error;
      const wait = delayFor(attempt, options, error);
      logger.debug(
        `${options.label}: attempt ${attempt} failed (${(error as Error).message}); retrying in ${wait}ms`,
      );
      onRetry?.(error, attempt);
      await sleep(wait);
    }
  }
  throw lastError;
}

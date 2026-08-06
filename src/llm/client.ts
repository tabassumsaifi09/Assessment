import type { LlmProvider, LlmRequest, LlmCallStats } from './types';
import { InvalidModelOutputError } from './errors';
import { parseJsonLoose } from './json';
import { withRetry } from './retry';
import { SlidingWindowLimiter, estimateTokens } from './rateLimiter';
import { createLimiter, withTimeout } from '../util/async';
import { logger } from '../util/logger';

export interface LlmClientOptions {
  maxConcurrency: number;
  requestsPerMinute: number;
  tokensPerMinute: number;
  maxAttempts: number;
  timeoutMs: number;
}

/**
 * Everything that makes a free-tier LLM survivable lives here, once:
 * self-throttling, backoff that honours Retry-After, per-call timeouts,
 * tolerant JSON parsing and a caller-supplied validator. Pipeline stages call
 * `json()` and get a typed value or an error - they never see HTTP.
 */
export class LlmClient {
  private readonly limiter: SlidingWindowLimiter;
  private readonly gate: <T>(task: () => Promise<T>) => Promise<T>;
  readonly stats: LlmCallStats[] = [];

  constructor(
    private readonly provider: LlmProvider,
    private readonly options: LlmClientOptions,
  ) {
    this.limiter = new SlidingWindowLimiter(options.requestsPerMinute, options.tokensPerMinute);
    this.gate = createLimiter(options.maxConcurrency);
  }

  get providerName(): string {
    return this.provider.name;
  }

  /**
   * Calls the model and returns validated JSON.
   *
   * `validate` is the caller's structural check. A validator that throws is
   * treated exactly like malformed JSON: retryable, with a stricter reminder
   * appended to the prompt on the next attempt.
   */
  async json<T>(request: LlmRequest, validate: (value: unknown) => T): Promise<T> {
    const started = Date.now();
    let attempts = 0;
    try {
      const result = await this.gate(() =>
        withRetry(
          { maxAttempts: this.options.maxAttempts, label: `llm:${request.task}` },
          async (attempt, previousError) => {
            attempts = attempt;
            const effective = this.stiffen(request, previousError);
            await this.limiter.acquire(estimateTokens(effective.system + effective.user));
            const raw = await withTimeout(
              (signal) => this.provider.complete(effective, signal),
              this.options.timeoutMs,
              `llm:${request.task}`,
            );
            const parsed = parseJsonLoose<unknown>(raw);
            try {
              return validate(parsed);
            } catch (error) {
              throw new InvalidModelOutputError(
                `output failed validation: ${(error as Error).message}`,
                raw.slice(0, 400),
              );
            }
          },
        ),
      );
      this.stats.push({ task: request.task, attempts, ms: Date.now() - started, ok: true });
      return result;
    } catch (error) {
      this.stats.push({ task: request.task, attempts, ms: Date.now() - started, ok: false });
      logger.debug(`llm:${request.task} gave up after ${attempts} attempts`, {
        message: (error as Error).message,
      });
      throw error;
    }
  }

  /**
   * Same as `json`, but a total failure returns `fallback` instead of
   * throwing. Used where a missing section should degrade the kit rather than
   * lose it - an honest empty brief beats no kit at all.
   */
  async jsonOrFallback<T>(
    request: LlmRequest,
    validate: (value: unknown) => T,
    fallback: T,
  ): Promise<{ value: T; degraded: boolean }> {
    try {
      return { value: await this.json(request, validate), degraded: false };
    } catch (error) {
      logger.info(`llm:${request.task} degraded to fallback`, {
        message: (error as Error).message,
      });
      return { value: fallback, degraded: true };
    }
  }

  private stiffen(request: LlmRequest, previousError: unknown): LlmRequest {
    if (!(previousError instanceof InvalidModelOutputError)) return request;
    return {
      ...request,
      user: `${request.user}\n\nYour previous reply could not be parsed. Reply with a single JSON object and nothing else: no prose, no markdown fences, no trailing commas.`,
      temperature: 0,
    };
  }
}

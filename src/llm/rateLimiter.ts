import { sleep } from '../util/async';

/**
 * Free tiers cap requests per minute *and* tokens per minute. Two sliding
 * windows, checked before every call, so we throttle ourselves before the
 * provider has to. Backoff on a 429 still exists (see retry.ts) - this just
 * makes hitting one rare.
 */
export class SlidingWindowLimiter {
  private readonly requests: Array<{ at: number; tokens: number }> = [];

  constructor(
    private readonly requestsPerMinute: number,
    private readonly tokensPerMinute: number,
  ) {}

  private prune(now: number): void {
    while (this.requests.length > 0 && now - this.requests[0]!.at > 60_000) {
      this.requests.shift();
    }
  }

  private usage(now: number): { count: number; tokens: number } {
    this.prune(now);
    let tokens = 0;
    for (const entry of this.requests) tokens += entry.tokens;
    return { count: this.requests.length, tokens };
  }

  /** Waits until the call fits inside both windows, then records it. */
  async acquire(estimatedTokens: number): Promise<void> {
    // Bounded loop: each iteration either returns or sleeps until the oldest
    // entry leaves the window.
    for (;;) {
      const now = Date.now();
      const { count, tokens } = this.usage(now);
      const requestRoom = count < this.requestsPerMinute;
      const tokenRoom = tokens + estimatedTokens <= this.tokensPerMinute || count === 0;
      if (requestRoom && tokenRoom) {
        this.requests.push({ at: now, tokens: estimatedTokens });
        return;
      }
      const oldest = this.requests[0]?.at ?? now;
      await sleep(Math.max(50, 60_000 - (now - oldest) + 25));
    }
  }
}

/** Rough token estimate; four characters per token is close enough to throttle on. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4) + 64;
}

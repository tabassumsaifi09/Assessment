export class LlmError extends Error {
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(message: string, options: { retryable?: boolean; retryAfterMs?: number } = {}) {
    super(message);
    this.name = 'LlmError';
    this.retryable = options.retryable ?? false;
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
  }
}

/** 429 / quota. Carries the provider's Retry-After when it sends one. */
export class RateLimitError extends LlmError {
  constructor(message: string, retryAfterMs?: number) {
    super(message, { retryable: true, retryAfterMs });
    this.name = 'RateLimitError';
  }
}

/** 5xx, socket resets, timeouts - worth another attempt. */
export class TransientLlmError extends LlmError {
  constructor(message: string) {
    super(message, { retryable: true });
    this.name = 'TransientLlmError';
  }
}

/** The model answered, but not with the JSON we asked for. */
export class InvalidModelOutputError extends LlmError {
  readonly raw: string;

  constructor(message: string, raw: string) {
    super(message, { retryable: true });
    this.name = 'InvalidModelOutputError';
    this.raw = raw;
  }
}

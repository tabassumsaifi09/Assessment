import { config } from '../config/env';
import { LlmClient } from './client';
import { OfflineModelProvider } from './providers/offline';
import { OpenAiCompatibleProvider } from './providers/openaiCompatible';
import type { LlmProvider } from './types';
import { logger } from '../util/logger';

export { LlmClient } from './client';
export * from './types';
export * from './errors';

export function createProvider(): LlmProvider {
  const { provider, apiKey, baseUrl, model } = config.llm;
  if (provider === 'openai-compatible' && apiKey) {
    return new OpenAiCompatibleProvider({ baseUrl, apiKey, model });
  }
  if (provider === 'openai-compatible' && !apiKey) {
    logger.info('LLM_API_KEY is empty; falling back to the deterministic offline model');
  }
  return new OfflineModelProvider();
}

export function createLlmClient(provider: LlmProvider = createProvider()): LlmClient {
  return new LlmClient(provider, {
    maxConcurrency: config.llm.maxConcurrency,
    requestsPerMinute: config.llm.requestsPerMinute,
    tokensPerMinute: config.llm.tokensPerMinute,
    maxAttempts: config.llm.maxAttempts,
    timeoutMs: config.llm.timeoutMs,
  });
}

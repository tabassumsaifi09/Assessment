import { config } from '../config/env';
import { createLlmClient } from '../llm';
import { PageFetcher } from '../retrieval/fetcher';
import { createSearchProvider } from '../research/searchProvider';
import type { BuildKitDeps, BuildKitOptions } from './buildKit';

export interface PipelineOverrides {
  /** The batch runner sets this: evaluation sites may be served locally. */
  allowPrivateNetwork?: boolean;
  maxPages?: number;
  maxDepth?: number;
}

/**
 * One construction point for the pipeline, used by the HTTP API and by the
 * batch entry point alike, so the two cannot drift into different behaviour.
 * A fresh PageFetcher per run keeps the robots cache and politeness timers
 * scoped to that run.
 */
export function createPipeline(overrides: PipelineOverrides = {}): {
  deps: BuildKitDeps;
  options: BuildKitOptions;
} {
  const fetcher = new PageFetcher({
    timeoutMs: config.retrieval.timeoutMs,
    maxBytes: config.retrieval.maxBytes,
    crawlDelayMs: config.retrieval.crawlDelayMs,
    allowPrivateNetwork: overrides.allowPrivateNetwork ?? config.retrieval.allowPrivateNetwork,
  });

  return {
    deps: {
      llm: createLlmClient(),
      fetcher,
      search: createSearchProvider(config.search.provider, config.search.braveApiKey),
    },
    options: {
      maxPages: overrides.maxPages ?? config.retrieval.maxPages,
      maxDepth: overrides.maxDepth ?? config.retrieval.maxDepth,
      maxCoveragePasses: config.pipeline.maxCoveragePasses,
      researchBudgetMs: 90_000,
    },
  };
}

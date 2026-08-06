/**
 * Provider-agnostic LLM contract.
 *
 * Every call carries both a rendered prompt (what a hosted model reads) and a
 * structured payload (what the deterministic offline model reads). The rest of
 * the codebase only ever sees `LlmClient`, so swapping Groq for anything else
 * is a one-file change.
 */

export type LlmTask =
  | 'extract_jd'
  | 'company_brief'
  | 'summarise_hiring_process'
  | 'generate_questions'
  | 'generate_flashcards';

export interface LlmRequest {
  task: LlmTask;
  system: string;
  user: string;
  /** Structured view of the same input, for the offline model. */
  payload: Record<string, unknown>;
  temperature?: number;
  maxTokens?: number;
  /** Free-form label used in logs and metrics. */
  label?: string;
}

export interface LlmProvider {
  readonly name: string;
  complete(request: LlmRequest, signal: AbortSignal): Promise<string>;
}

export interface LlmCallStats {
  task: LlmTask;
  attempts: number;
  ms: number;
  ok: boolean;
}

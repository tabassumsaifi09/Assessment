import type { LlmProvider, LlmRequest } from '../types';
import { LlmError, RateLimitError, TransientLlmError } from '../errors';

export interface HostedProviderOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/**
 * Any /v1/chat/completions endpoint: Groq's free tier by default, but
 * OpenRouter, Together, Ollama or OpenAI itself work unchanged. HTTP status
 * codes are translated into the error types the retry policy understands, so
 * a 429 backs off and a 400 does not.
 */
export class OpenAiCompatibleProvider implements LlmProvider {
  readonly name: string;

  constructor(private readonly options: HostedProviderOptions) {
    this.name = `openai-compatible:${options.model}`;
  }

  async complete(request: LlmRequest, signal: AbortSignal): Promise<string> {
    const response = await fetch(`${this.options.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.options.apiKey}`,
      },
      body: JSON.stringify({
        model: this.options.model,
        temperature: request.temperature ?? 0.2,
        max_tokens: request.maxTokens ?? 1600,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content: request.user },
        ],
      }),
    });

    if (response.status === 429) {
      throw new RateLimitError(
        `provider rate limited task ${request.task}`,
        retryAfterMs(response.headers.get('retry-after')),
      );
    }
    if (response.status >= 500) {
      throw new TransientLlmError(`provider returned ${response.status} for ${request.task}`);
    }
    if (!response.ok) {
      const body = await safeText(response);
      throw new LlmError(`provider rejected ${request.task}: ${response.status} ${body}`, {
        retryable: false,
      });
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new TransientLlmError(`provider returned no content for ${request.task}`);
    return content;
  }
}

function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 200);
  } catch {
    return '<unreadable body>';
  }
}

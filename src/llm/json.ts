import { InvalidModelOutputError } from './errors';

/**
 * Models wrap JSON in prose, in ``` fences, or emit a trailing comma. We do a
 * bounded amount of repair here and then hand the result to a caller-supplied
 * validator; anything still broken is raised as a retryable error so the
 * client can ask again with a stricter instruction.
 */
export function extractJsonText(raw: string): string {
  let text = raw.trim();

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) text = fenced[1].trim();

  const start = firstStructuralIndex(text);
  if (start === -1) return text;

  const opening = text[start]!;
  const closing = opening === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === opening) depth += 1;
    else if (char === closing) {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }

  // Unterminated: give the parser the best-effort remainder.
  return text.slice(start);
}

function firstStructuralIndex(text: string): number {
  const brace = text.indexOf('{');
  const bracket = text.indexOf('[');
  if (brace === -1) return bracket;
  if (bracket === -1) return brace;
  return Math.min(brace, bracket);
}

function repair(text: string): string {
  return text
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'");
}

export function parseJsonLoose<T>(raw: string): T {
  const candidate = extractJsonText(raw);
  try {
    return JSON.parse(candidate) as T;
  } catch {
    try {
      return JSON.parse(repair(candidate)) as T;
    } catch (error) {
      throw new InvalidModelOutputError(
        `model did not return parsable JSON: ${(error as Error).message}`,
        raw.slice(0, 400),
      );
    }
  }
}

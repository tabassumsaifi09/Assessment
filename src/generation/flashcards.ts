import type { LlmClient } from '../llm/client';
import type { Flashcard, Requirement } from '../domain/types';
import type { GenerationContext } from './context';
import { UNTRUSTED_SYSTEM_RULE } from '../security/untrusted';
import { truncate } from '../util/text';

interface ModelCard {
  front: string;
  back: string;
  requirement_ids: string[];
}

/**
 * Flashcards are one per requirement plus a few company facts. They carry
 * requirement ids so practice progress can be reported against the same
 * requirements the questions cover.
 */
export async function generateFlashcards(
  llm: LlmClient,
  requirements: Requirement[],
  context: GenerationContext,
): Promise<Flashcard[]> {
  if (requirements.length === 0 && context.facts.length === 0) return [];
  const validIds = new Set(requirements.map((requirement) => requirement.id));

  const fallback: ModelCard[] = requirements.map((requirement) => ({
    front: `What do you need to be able to show on: ${truncate(requirement.text, 90)}?`,
    back: `Prepare one concrete example and one trade-off. Requirement: "${truncate(requirement.text, 160)}".`,
    requirement_ids: [requirement.id],
  }));

  const { value } = await llm.jsonOrFallback<ModelCard[]>(
    {
      task: 'generate_flashcards',
      system:
        'You write two-sided revision cards for an interview candidate. Fronts are short prompts, backs are what a good answer must contain. ' +
        UNTRUSTED_SYSTEM_RULE +
        ' Reply as JSON: {"flashcards": [{"front": string, "back": string, "requirement_ids": string[]}]}.',
      user: [
        `Company: ${context.company || 'unknown'}`,
        'Requirements:',
        requirements.map((requirement) => `- ${requirement.id} ${requirement.text}`).join('\n'),
        context.facts.length > 0 ? `Company facts:\n${context.facts.join('\n')}` : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
      payload: {
        requirements,
        company: context.company,
        company_facts: context.facts,
      },
      label: 'flashcards',
    },
    validateCards,
    fallback,
  );

  return value
    .map((card, index) => ({
      id: `f${index + 1}`,
      front: truncate(card.front.trim(), 300),
      back: truncate(card.back.trim(), 900),
      requirement_ids: card.requirement_ids.filter((id) => validIds.has(id)),
    }))
    .filter((card) => card.front.length > 0 && card.back.length > 0);
}

function validateCards(raw: unknown): ModelCard[] {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as Record<string, unknown> | null)?.flashcards)
      ? ((raw as Record<string, unknown>).flashcards as unknown[])
      : null;
  if (!list) throw new Error('expected {"flashcards": [...]}');
  const cards = list
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map((item) => ({
      front: typeof item.front === 'string' ? item.front : '',
      back: typeof item.back === 'string' ? item.back : '',
      requirement_ids: Array.isArray(item.requirement_ids)
        ? item.requirement_ids.filter((id): id is string => typeof id === 'string')
        : [],
    }))
    .filter((card) => card.front.trim() && card.back.trim());
  if (cards.length === 0) throw new Error('no usable flashcards in reply');
  return cards;
}

import { randomUUID } from 'node:crypto';
import type {
  Flashcard,
  ItemState,
  KitDocument,
  PracticeRecord,
  Question,
  QuestionCategory,
  StageProgress,
} from '../domain/types';
import { buildKit, KitBuildError } from '../pipeline/buildKit';
import { createPipeline } from '../pipeline/factory';
import { regenerateSection, type RegenerateTarget } from '../pipeline/regenerate';
import { getKitStore } from '../persistence/kitStore';
import { nextQuestionId } from '../coverage/gapFiller';
import { buildSchedule, clampDays } from '../schedule/allocator';
import { fingerprint } from '../util/hash';
import { logger } from '../util/logger';

export interface CreateKitInput {
  jd: string;
  company_url: string;
  days: number;
}

/**
 * Application service between the HTTP layer and the pipeline.
 *
 * Generation is slow (tens of seconds), so a create returns immediately with a
 * `queued` document and the work continues in the background, writing stage
 * progress into the document as it goes. The interface polls that document,
 * which is also what makes a refresh mid-generation harmless.
 *
 * Submitting the same posting twice does not start a second run: the
 * fingerprint of (jd, company_url, days) is unique per user, and a repeat
 * returns the existing kit.
 */
export async function createKit(userId: string, input: CreateKitInput): Promise<KitDocument> {
  const store = getKitStore();
  const days = clampDays(input.days);
  const key = fingerprint([input.jd, input.company_url, days]);

  const existing = await store.findByFingerprint(userId, key);
  if (existing && existing.status !== 'failed') {
    logger.info(`kit ${existing.id} already exists for this posting; returning it`);
    return existing;
  }

  const document: KitDocument = {
    id: randomUUID(),
    user_id: userId,
    status: 'queued',
    fingerprint: key,
    days_requested: days,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    kit: null,
    error: null,
    progress: [],
    item_state: {},
    practice: [],
  };
  await store.saveKit(document);
  void runGeneration(document, input);
  return document;
}

async function runGeneration(document: KitDocument, input: CreateKitInput): Promise<void> {
  const store = getKitStore();
  const { deps, options } = createPipeline();
  const progress: StageProgress[] = [];
  let current: KitDocument = { ...document, status: 'running' };
  await store.saveKit(current);

  const flush = async () => {
    current = { ...current, progress: [...progress] };
    await store.saveKit(current);
  };

  try {
    const result = await buildKit(
      { jd: input.jd, company_url: input.company_url, days: document.days_requested },
      deps,
      {
        ...options,
        onProgress: (event) => {
          const existing = progress.find((entry) => entry.stage === event.stage);
          const record: StageProgress = {
            stage: event.stage,
            status: event.status === 'running' ? 'running' : event.status,
            detail: event.detail,
            started_at: existing?.started_at ?? new Date().toISOString(),
            finished_at: event.status === 'running' ? undefined : new Date().toISOString(),
          };
          if (existing) Object.assign(existing, record);
          else progress.push(record);
          void flush();
        },
      },
    );

    const itemState: Record<string, ItemState> = { company_brief: { origin: 'generated', pinned: false } };
    for (const question of result.kit.questions) {
      itemState[question.id] = { origin: 'generated', pinned: false, pass: 1 };
    }
    for (const card of result.kit.flashcards) {
      itemState[card.id] = { origin: 'generated', pinned: false, pass: 1 };
    }

    current = {
      ...current,
      status: 'ready',
      kit: result.kit,
      error: null,
      item_state: itemState,
      progress: [...progress],
    };
    await store.saveKit(current);
  } catch (error) {
    const code = error instanceof KitBuildError ? error.code : 'GENERATION_FAILED';
    logger.error(`kit ${document.id} failed: ${(error as Error).message}`);
    current = {
      ...current,
      status: 'failed',
      error: { code, message: (error as Error).message },
      progress: [...progress],
    };
    await store.saveKit(current);
  }
}

export async function regenerate(
  userId: string,
  kitId: string,
  target: RegenerateTarget,
): Promise<KitDocument> {
  const store = getKitStore();
  const document = await mustGet(userId, kitId);
  const { deps, options } = createPipeline();
  const result = await regenerateSection(document, target, deps, options);
  return store.saveKit({
    ...document,
    kit: result.kit,
    item_state: result.itemState,
    updated_at: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Builder operations
// ---------------------------------------------------------------------------

export async function editQuestion(
  userId: string,
  kitId: string,
  questionId: string,
  patch: Partial<Pick<Question, 'prompt' | 'answer_outline' | 'difficulty' | 'category'>>,
): Promise<KitDocument> {
  const document = await mustGet(userId, kitId);
  const kit = requireKit(document);
  const question = kit.questions.find((item) => item.id === questionId);
  if (!question) throw new NotFoundError(`question ${questionId}`);

  Object.assign(question, {
    ...patch,
    difficulty: patch.difficulty ? Math.min(3, Math.max(1, Math.round(patch.difficulty))) : question.difficulty,
  });

  // Editing is what promotes an item out of "generated": from here on a
  // regeneration of this category leaves it alone.
  const state = document.item_state[questionId] ?? { origin: 'generated', pinned: false };
  document.item_state[questionId] = {
    ...state,
    origin: state.origin === 'manual' ? 'manual' : 'edited',
    edited_at: new Date().toISOString(),
  };
  return getKitStore().saveKit(document);
}

export async function addQuestion(
  userId: string,
  kitId: string,
  input: Omit<Question, 'id'>,
): Promise<KitDocument> {
  const document = await mustGet(userId, kitId);
  const kit = requireKit(document);
  const id = nextQuestionId(kit.questions);
  kit.questions.push({ ...input, id });
  document.item_state[id] = { origin: 'manual', pinned: true, edited_at: new Date().toISOString() };
  kit.schedule = buildSchedule({
    daysAvailable: kit.schedule.days_available,
    questions: kit.questions,
    requirements: kit.role.requirements,
  });
  return getKitStore().saveKit(document);
}

export async function deleteQuestion(
  userId: string,
  kitId: string,
  questionId: string,
): Promise<KitDocument> {
  const document = await mustGet(userId, kitId);
  const kit = requireKit(document);
  kit.questions = kit.questions.filter((question) => question.id !== questionId);
  delete document.item_state[questionId];
  kit.schedule = {
    ...kit.schedule,
    days: kit.schedule.days.map((day) => ({
      ...day,
      question_ids: day.question_ids.filter((id) => id !== questionId),
    })),
  };
  return getKitStore().saveKit(document);
}

/** Reordering is presentation state, so it only rewrites the question order. */
export async function reorderQuestions(
  userId: string,
  kitId: string,
  orderedIds: string[],
): Promise<KitDocument> {
  const document = await mustGet(userId, kitId);
  const kit = requireKit(document);
  const byId = new Map(kit.questions.map((question) => [question.id, question]));
  const reordered: Question[] = [];
  for (const id of orderedIds) {
    const question = byId.get(id);
    if (question) {
      reordered.push(question);
      byId.delete(id);
    }
  }
  kit.questions = [...reordered, ...byId.values()];
  return getKitStore().saveKit(document);
}

export async function moveQuestionCategory(
  userId: string,
  kitId: string,
  questionId: string,
  category: QuestionCategory,
): Promise<KitDocument> {
  return editQuestion(userId, kitId, questionId, { category });
}

export async function setPinned(
  userId: string,
  kitId: string,
  itemId: string,
  pinned: boolean,
): Promise<KitDocument> {
  const document = await mustGet(userId, kitId);
  const state = document.item_state[itemId] ?? { origin: 'generated', pinned: false };
  document.item_state[itemId] = { ...state, pinned };
  return getKitStore().saveKit(document);
}

export async function editFlashcard(
  userId: string,
  kitId: string,
  cardId: string,
  patch: Partial<Pick<Flashcard, 'front' | 'back'>>,
): Promise<KitDocument> {
  const document = await mustGet(userId, kitId);
  const kit = requireKit(document);
  const card = kit.flashcards.find((item) => item.id === cardId);
  if (!card) throw new NotFoundError(`flashcard ${cardId}`);
  Object.assign(card, patch);
  const state = document.item_state[cardId] ?? { origin: 'generated', pinned: false };
  document.item_state[cardId] = {
    ...state,
    origin: state.origin === 'manual' ? 'manual' : 'edited',
    edited_at: new Date().toISOString(),
  };
  return getKitStore().saveKit(document);
}

export async function addFlashcard(
  userId: string,
  kitId: string,
  input: Omit<Flashcard, 'id'>,
): Promise<KitDocument> {
  const document = await mustGet(userId, kitId);
  const kit = requireKit(document);
  const highest = kit.flashcards.reduce((max, card) => {
    const match = /^f(\d+)$/.exec(card.id);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  const id = `f${highest + 1}`;
  kit.flashcards.push({ ...input, id });
  document.item_state[id] = { origin: 'manual', pinned: true, edited_at: new Date().toISOString() };
  return getKitStore().saveKit(document);
}

export async function deleteFlashcard(
  userId: string,
  kitId: string,
  cardId: string,
): Promise<KitDocument> {
  const document = await mustGet(userId, kitId);
  const kit = requireKit(document);
  kit.flashcards = kit.flashcards.filter((card) => card.id !== cardId);
  delete document.item_state[cardId];
  return getKitStore().saveKit(document);
}

export async function editBrief(
  userId: string,
  kitId: string,
  patch: { summary?: string; what_they_do?: string },
): Promise<KitDocument> {
  const document = await mustGet(userId, kitId);
  const kit = requireKit(document);
  kit.company_brief = { ...kit.company_brief, ...patch };
  const state = document.item_state.company_brief ?? { origin: 'generated', pinned: false };
  document.item_state.company_brief = {
    ...state,
    origin: 'edited',
    edited_at: new Date().toISOString(),
  };
  return getKitStore().saveKit(document);
}

// ---------------------------------------------------------------------------
// Practice
// ---------------------------------------------------------------------------

/**
 * Practice scheduling uses a small spaced-repetition interval rather than a
 * plain sort: confidence 1 comes back in ten minutes, 4 in four days, and the
 * interval grows with each successful repetition. It is a simplified SM-2 -
 * enough to put the shaky cards first without pretending to be Anki.
 */
const BASE_INTERVAL_MINUTES: Record<number, number> = { 1: 10, 2: 60, 3: 24 * 60, 4: 4 * 24 * 60 };

export async function recordPractice(
  userId: string,
  kitId: string,
  cardId: string,
  confidence: number,
): Promise<KitDocument> {
  const document = await mustGet(userId, kitId);
  const kit = requireKit(document);
  if (!kit.flashcards.some((card) => card.id === cardId)) throw new NotFoundError(`flashcard ${cardId}`);

  const clamped = Math.min(4, Math.max(1, Math.round(confidence)));
  const previous = document.practice.filter((record) => record.card_id === cardId).at(-1);
  const reps = clamped >= 3 ? (previous?.reps ?? 0) + 1 : 0;
  const interval = (BASE_INTERVAL_MINUTES[clamped] ?? 60) * Math.max(1, reps === 0 ? 1 : reps * 1.8);

  const record: PracticeRecord = {
    card_id: cardId,
    confidence: clamped,
    reviewed_at: new Date().toISOString(),
    due_at: new Date(Date.now() + interval * 60_000).toISOString(),
    reps,
  };
  document.practice.push(record);
  return getKitStore().saveKit(document);
}

export interface PracticeSession {
  due: Flashcard[];
  unseen: Flashcard[];
  covered: number;
  total: number;
}

export function buildPracticeSession(document: KitDocument): PracticeSession {
  const kit = requireKit(document);
  const latest = new Map<string, PracticeRecord>();
  for (const record of document.practice) latest.set(record.card_id, record);

  const unseen = kit.flashcards.filter((card) => !latest.has(card.id));
  const due = kit.flashcards
    .filter((card) => latest.has(card.id))
    .filter((card) => Date.parse(latest.get(card.id)!.due_at) <= Date.now())
    .sort((a, b) => {
      const left = latest.get(a.id)!;
      const right = latest.get(b.id)!;
      // Least confident first, then whatever has been waiting longest.
      if (left.confidence !== right.confidence) return left.confidence - right.confidence;
      return Date.parse(left.due_at) - Date.parse(right.due_at);
    });

  return { due, unseen, covered: latest.size, total: kit.flashcards.length };
}

// ---------------------------------------------------------------------------

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what} not found`);
    this.name = 'NotFoundError';
  }
}

async function mustGet(userId: string, kitId: string): Promise<KitDocument> {
  const document = await getKitStore().getKit(userId, kitId);
  if (!document) throw new NotFoundError(`kit ${kitId}`);
  return document;
}

function requireKit(document: KitDocument) {
  if (!document.kit) throw new NotFoundError(`kit ${document.id} content`);
  return document.kit;
}

import { Router, type Response } from 'express';
import { QUESTION_CATEGORIES, type QuestionCategory } from '../domain/types';
import {
  addFlashcard,
  addQuestion,
  buildPracticeSession,
  createKit,
  deleteFlashcard,
  deleteQuestion,
  editBrief,
  editFlashcard,
  editQuestion,
  moveQuestionCategory,
  NotFoundError,
  recordPractice,
  regenerate,
  reorderQuestions,
  setPinned,
} from './kitService';
import {
  createSessionToken,
  hashPassword,
  requireAuth,
  SESSION_COOKIE,
  verifyPassword,
  type AuthenticatedRequest,
} from './auth';
import { getKitStore } from '../persistence/kitStore';
import { buildReadinessReport, replanSchedule } from '../practice/readiness';
import { clampDays } from '../schedule/allocator';
import { logger } from '../util/logger';

/** Every error the API returns has a code the interface can branch on. */
function fail(response: Response, status: number, code: string, message: string): void {
  response.status(status).json({ error: { code, message } });
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function createRouter(): Router {
  const router = Router();
  const store = getKitStore();

  // --- auth ---------------------------------------------------------------
  router.post('/auth/register', async (request, response) => {
    const email = asString(request.body?.email).toLowerCase();
    const password = asString(request.body?.password);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return fail(response, 400, 'INVALID_EMAIL', 'a valid email address is required');
    }
    if (password.length < 8) {
      return fail(response, 400, 'WEAK_PASSWORD', 'password must be at least 8 characters');
    }
    if (await store.findUserByEmail(email)) {
      return fail(response, 409, 'EMAIL_TAKEN', 'that email is already registered');
    }
    const user = await store.createUser(email, await hashPassword(password));
    setSession(response, user.id);
    response.status(201).json({ user: { id: user.id, email: user.email } });
  });

  router.post('/auth/login', async (request, response) => {
    const email = asString(request.body?.email).toLowerCase();
    const password = asString(request.body?.password);
    const user = await store.findUserByEmail(email);
    // Same response either way: no account enumeration.
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      return fail(response, 401, 'INVALID_CREDENTIALS', 'email or password is incorrect');
    }
    setSession(response, user.id);
    response.json({ user: { id: user.id, email: user.email } });
  });

  router.post('/auth/logout', (_request, response) => {
    response.setHeader('set-cookie', `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
    response.json({ ok: true });
  });

  router.get('/me', requireAuth, async (request: AuthenticatedRequest, response) => {
    const user = await store.findUserById(request.userId!);
    response.json({ user: user ? { id: user.id, email: user.email } : null });
  });

  // --- kits ---------------------------------------------------------------
  router.get('/kits', requireAuth, async (request: AuthenticatedRequest, response) => {
    const kits = await store.listKits(request.userId!);
    response.json({
      kits: kits.map((document) => ({
        id: document.id,
        status: document.status,
        created_at: document.created_at,
        updated_at: document.updated_at,
        role: document.kit?.source.role ?? null,
        company: document.kit?.source.company ?? null,
        days: document.days_requested,
        error: document.error,
      })),
    });
  });

  router.post('/kits', requireAuth, async (request: AuthenticatedRequest, response) => {
    const jd = asString(request.body?.jd);
    const companyUrl = asString(request.body?.company_url);
    const days = clampDays(Number(request.body?.days ?? 5));
    if (jd.length < 20) {
      return fail(response, 400, 'JD_TOO_SHORT', 'paste the job description (at least 20 characters)');
    }
    if (!/^https?:\/\/.+/i.test(companyUrl)) {
      return fail(response, 400, 'INVALID_COMPANY_URL', 'company_url must be an http(s) URL');
    }
    const document = await createKit(request.userId!, { jd, company_url: companyUrl, days });
    response.status(202).json({ kit: document });
  });

  /** Several postings at once: one document per pair, all queued immediately. */
  router.post('/kits/batch', requireAuth, async (request: AuthenticatedRequest, response) => {
    const items = Array.isArray(request.body?.items) ? request.body.items : [];
    if (items.length === 0) {
      return fail(response, 400, 'EMPTY_BATCH', 'items must be a non-empty array');
    }
    if (items.length > 20) {
      return fail(response, 400, 'BATCH_TOO_LARGE', 'at most 20 postings at a time');
    }
    const created = [];
    const rejected = [];
    for (const [index, item] of items.entries()) {
      const jd = asString(item?.jd);
      const companyUrl = asString(item?.company_url);
      if (jd.length < 20 || !/^https?:\/\/.+/i.test(companyUrl)) {
        rejected.push({ index, reason: 'jd or company_url missing or invalid' });
        continue;
      }
      created.push(
        await createKit(request.userId!, {
          jd,
          company_url: companyUrl,
          days: clampDays(Number(item?.days ?? 5)),
        }),
      );
    }
    response.status(202).json({ created: created.map((document) => document.id), rejected });
  });

  router.get('/kits/:id', requireAuth, async (request: AuthenticatedRequest, response) => {
    const document = await store.getKit(request.userId!, request.params.id!);
    if (!document) return fail(response, 404, 'KIT_NOT_FOUND', 'no such kit');
    response.json({ kit: document });
  });

  router.delete('/kits/:id', requireAuth, async (request: AuthenticatedRequest, response) => {
    const deleted = await store.deleteKit(request.userId!, request.params.id!);
    if (!deleted) return fail(response, 404, 'KIT_NOT_FOUND', 'no such kit');
    response.json({ ok: true });
  });

  // --- builder ------------------------------------------------------------
  router.patch('/kits/:id/brief', requireAuth, guarded(async (request, response) => {
    const document = await editBrief(request.userId!, request.params.id!, {
      summary: request.body?.summary,
      what_they_do: request.body?.what_they_do,
    });
    response.json({ kit: document });
  }));

  router.patch('/kits/:id/questions/:questionId', requireAuth, guarded(async (request, response) => {
    const document = await editQuestion(request.userId!, request.params.id!, request.params.questionId!, {
      prompt: request.body?.prompt,
      answer_outline: request.body?.answer_outline,
      difficulty: request.body?.difficulty,
      category: normaliseCategory(request.body?.category),
    });
    response.json({ kit: document });
  }));

  router.post('/kits/:id/questions', requireAuth, guarded(async (request, response) => {
    const category = normaliseCategory(request.body?.category) ?? 'technical';
    const document = await addQuestion(request.userId!, request.params.id!, {
      requirement_ids: Array.isArray(request.body?.requirement_ids) ? request.body.requirement_ids : [],
      category,
      prompt: asString(request.body?.prompt),
      answer_outline: asString(request.body?.answer_outline),
      difficulty: Number(request.body?.difficulty ?? 2),
    });
    response.status(201).json({ kit: document });
  }));

  router.delete('/kits/:id/questions/:questionId', requireAuth, guarded(async (request, response) => {
    const document = await deleteQuestion(request.userId!, request.params.id!, request.params.questionId!);
    response.json({ kit: document });
  }));

  router.post('/kits/:id/questions/reorder', requireAuth, guarded(async (request, response) => {
    const ids = Array.isArray(request.body?.question_ids) ? request.body.question_ids : [];
    const document = await reorderQuestions(request.userId!, request.params.id!, ids);
    response.json({ kit: document });
  }));

  router.post('/kits/:id/questions/:questionId/move', requireAuth, guarded(async (request, response) => {
    const category = normaliseCategory(request.body?.category);
    if (!category) return fail(response, 400, 'INVALID_CATEGORY', 'unknown question category');
    const document = await moveQuestionCategory(
      request.userId!,
      request.params.id!,
      request.params.questionId!,
      category,
    );
    response.json({ kit: document });
  }));

  router.post('/kits/:id/items/:itemId/pin', requireAuth, guarded(async (request, response) => {
    const document = await setPinned(
      request.userId!,
      request.params.id!,
      request.params.itemId!,
      Boolean(request.body?.pinned ?? true),
    );
    response.json({ kit: document });
  }));

  router.patch('/kits/:id/flashcards/:cardId', requireAuth, guarded(async (request, response) => {
    const document = await editFlashcard(request.userId!, request.params.id!, request.params.cardId!, {
      front: request.body?.front,
      back: request.body?.back,
    });
    response.json({ kit: document });
  }));

  router.post('/kits/:id/flashcards', requireAuth, guarded(async (request, response) => {
    const document = await addFlashcard(request.userId!, request.params.id!, {
      front: asString(request.body?.front),
      back: asString(request.body?.back),
      requirement_ids: Array.isArray(request.body?.requirement_ids) ? request.body.requirement_ids : [],
    });
    response.status(201).json({ kit: document });
  }));

  router.delete('/kits/:id/flashcards/:cardId', requireAuth, guarded(async (request, response) => {
    const document = await deleteFlashcard(request.userId!, request.params.id!, request.params.cardId!);
    response.json({ kit: document });
  }));

  router.post('/kits/:id/regenerate', requireAuth, guarded(async (request, response) => {
    const section = asString(request.body?.section);
    if (section === 'company_brief') {
      const document = await regenerate(request.userId!, request.params.id!, { section: 'company_brief' });
      return response.json({ kit: document });
    }
    if (section === 'schedule') {
      const document = await regenerate(request.userId!, request.params.id!, { section: 'schedule' });
      return response.json({ kit: document });
    }
    if (section === 'questions') {
      const category = normaliseCategory(request.body?.category);
      if (!category) return fail(response, 400, 'INVALID_CATEGORY', 'a question category is required');
      const document = await regenerate(request.userId!, request.params.id!, {
        section: 'questions',
        category,
      });
      return response.json({ kit: document });
    }
    return fail(response, 400, 'INVALID_SECTION', 'section must be company_brief, questions or schedule');
  }));

  // --- practice -----------------------------------------------------------
  router.get('/kits/:id/practice', requireAuth, guarded(async (request, response) => {
    const document = await store.getKit(request.userId!, request.params.id!);
    if (!document) return fail(response, 404, 'KIT_NOT_FOUND', 'no such kit');
    response.json({ session: buildPracticeSession(document), history: document.practice });
  }));

  router.post('/kits/:id/practice', requireAuth, guarded(async (request, response) => {
    const cardId = asString(request.body?.card_id);
    const confidence = Number(request.body?.confidence);
    if (!cardId || !Number.isFinite(confidence)) {
      return fail(response, 400, 'INVALID_PRACTICE', 'card_id and confidence (1-4) are required');
    }
    const document = await recordPractice(request.userId!, request.params.id!, cardId, confidence);
    response.json({ session: buildPracticeSession(document) });
  }));

  // --- readiness (custom feature) -----------------------------------------
  router.get('/kits/:id/readiness', requireAuth, guarded(async (request, response) => {
    const document = await store.getKit(request.userId!, request.params.id!);
    if (!document) return fail(response, 404, 'KIT_NOT_FOUND', 'no such kit');
    response.json({ readiness: buildReadinessReport(document) });
  }));

  /**
   * Re-plans the days that are left around what practice says is weakest.
   * The allocation stays deterministic; only the ordering weight changes.
   */
  router.post('/kits/:id/replan', requireAuth, guarded(async (request, response) => {
    const document = await store.getKit(request.userId!, request.params.id!);
    if (!document) return fail(response, 404, 'KIT_NOT_FOUND', 'no such kit');
    if (!document.kit) return fail(response, 409, 'KIT_NOT_READY', 'this kit has not been generated yet');
    const days = clampDays(Number(request.body?.days ?? document.kit.schedule.days_available));
    document.kit.schedule = replanSchedule(document, days);
    const saved = await store.saveKit(document);
    response.json({ kit: saved, readiness: buildReadinessReport(saved) });
  }));

  return router;
}

function setSession(response: Response, userId: string): void {
  const token = createSessionToken(userId);
  response.setHeader(
    'set-cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${12 * 3600}`,
  );
}

function normaliseCategory(value: unknown): QuestionCategory | undefined {
  return typeof value === 'string' && QUESTION_CATEGORIES.includes(value as QuestionCategory)
    ? (value as QuestionCategory)
    : undefined;
}

type Handler = (request: AuthenticatedRequest, response: Response) => Promise<unknown>;

/** Turns thrown service errors into structured API errors. */
function guarded(handler: Handler) {
  return async (request: AuthenticatedRequest, response: Response): Promise<void> => {
    try {
      await handler(request, response);
    } catch (error) {
      if (error instanceof NotFoundError) {
        fail(response, 404, 'NOT_FOUND', error.message);
        return;
      }
      logger.error(`request failed: ${(error as Error).message}`);
      fail(response, 500, 'INTERNAL_ERROR', (error as Error).message);
    }
  };
}

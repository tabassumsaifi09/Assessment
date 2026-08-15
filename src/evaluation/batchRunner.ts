import type { Kit } from '../domain/types';
import { buildKit, KitBuildError, type BuildKitDeps, type BuildKitOptions } from '../pipeline/buildKit';
import { createPipeline } from '../pipeline/factory';
import { fingerprint } from '../util/hash';
import { mapWithConcurrency } from '../util/async';
import { logger } from '../util/logger';

export interface BatchCase {
  id: string;
  jd: string;
  company_url: string;
  days: number;
}

export interface BatchEntry {
  id: string;
  status: 'ok' | 'failed';
  kit: Kit | null;
  error: { code: string; message: string } | null;
}

export interface BatchOutput {
  version: '1.0';
  generated_at: string;
  kits: BatchEntry[];
}

export interface BatchOptions {
  concurrency?: number;
  /** Hard ceiling per case, so one slow site cannot eat the whole run. */
  perCaseTimeoutMs?: number;
  allowPrivateNetwork?: boolean;
  onCaseDone?: (entry: BatchEntry, index: number, total: number) => void;
}

export function parseCases(raw: unknown): BatchCase[] {
  if (!Array.isArray(raw)) throw new Error('input file must contain a JSON array of cases');
  return raw.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`case ${index} is not an object`);
    }
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === 'string' && record.id ? record.id : `case-${index + 1}`;
    const jd = typeof record.jd === 'string' ? record.jd : '';
    const companyUrl = typeof record.company_url === 'string' ? record.company_url : '';
    const days = Number(record.days);
    return {
      id,
      jd,
      company_url: companyUrl,
      days: Number.isFinite(days) && days > 0 ? Math.round(days) : 5,
    };
  });
}

/**
 * Runs the real pipeline over a file of cases.
 *
 * Three properties matter here and are all deliberate:
 *  - one case failing never takes the run down; the failure is recorded and
 *    the next case starts;
 *  - "failed" means no kit could be produced at all. A company site that could
 *    not be reached still yields a kit built from the posting, recorded as ok
 *    with the gap written into the kit;
 *  - identical (jd, company_url, days) cases are computed once and reused,
 *    which is the same idempotency rule the API applies to a resubmission.
 */
export async function runBatch(cases: BatchCase[], options: BatchOptions = {}): Promise<BatchOutput> {
  const concurrency = options.concurrency ?? 2;
  const perCaseTimeoutMs = options.perCaseTimeoutMs ?? 150_000;
  const completedByFingerprint = new Map<string, Promise<Kit>>();

  const entries = await mapWithConcurrency(cases, concurrency, async (batchCase, index) => {
    const started = Date.now();
    const key = fingerprint([batchCase.jd, batchCase.company_url, batchCase.days]);
    try {
      if (!batchCase.jd.trim()) {
        throw new KitBuildError('JD_EMPTY', 'no job description was supplied for this case');
      }

      let pending = completedByFingerprint.get(key);
      if (!pending) {
        pending = runCase(batchCase, perCaseTimeoutMs, options.allowPrivateNetwork ?? true);
        completedByFingerprint.set(key, pending);
      } else {
        logger.info(`case ${batchCase.id} duplicates an earlier case; reusing its kit`);
      }

      const kit = await pending;
      const entry: BatchEntry = { id: batchCase.id, status: 'ok', kit, error: null };
      logger.info(`case ${batchCase.id} ok in ${Date.now() - started}ms`);
      options.onCaseDone?.(entry, index, cases.length);
      return entry;
    } catch (error) {
      const entry: BatchEntry = {
        id: batchCase.id,
        status: 'failed',
        kit: null,
        error: toBatchError(error),
      };
      logger.error(`case ${batchCase.id} failed: ${entry.error?.message ?? 'unknown'}`);
      options.onCaseDone?.(entry, index, cases.length);
      return entry;
    }
  });

  return {
    version: '1.0',
    generated_at: new Date().toISOString(),
    kits: entries,
  };
}

async function runCase(batchCase: BatchCase, timeoutMs: number, allowPrivateNetwork: boolean): Promise<Kit> {
  // A fresh pipeline per case: separate fetcher caches, separate politeness
  // timers, no state leaking between postings.
  const { deps, options } = createPipeline({ allowPrivateNetwork });
  return await withDeadline(
    buildKit(
      { jd: batchCase.jd, company_url: batchCase.company_url, days: batchCase.days, case_id: batchCase.id },
      deps as BuildKitDeps,
      options as BuildKitOptions,
    ).then((result) => result.kit),
    timeoutMs,
    batchCase.id,
  );
}

function withDeadline<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new KitBuildError('CASE_TIMEOUT', `case ${label} exceeded ${ms}ms`)),
      ms,
    );
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function toBatchError(error: unknown): { code: string; message: string } {
  if (error instanceof KitBuildError) {
    return { code: error.code, message: error.message };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/unreachable|ENOTFOUND|ECONNREFUSED|timed out/i.test(message)) {
    return { code: 'COMPANY_UNREACHABLE', message };
  }
  return { code: 'GENERATION_FAILED', message };
}

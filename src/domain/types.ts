/**
 * Domain types.
 *
 * `Kit` is the structure from Appendix A of the brief. Field names are exact
 * and must not drift: the batch entry point writes this shape verbatim.
 * Anything the application needs on top of it (edit state, generation
 * provenance, research diagnostics) lives outside the canonical kit in
 * `KitDocument`, so the kit we emit stays comparable between submissions.
 */

export type RequirementKind = 'technical' | 'behavioural' | 'domain';
export type RequirementPriority = 'must' | 'nice';
export type QuestionCategory =
  | 'technical'
  | 'behavioural'
  | 'system-design'
  | 'company-fit';

export const REQUIREMENT_KINDS: RequirementKind[] = ['technical', 'behavioural', 'domain'];
export const REQUIREMENT_PRIORITIES: RequirementPriority[] = ['must', 'nice'];
export const QUESTION_CATEGORIES: QuestionCategory[] = [
  'technical',
  'behavioural',
  'system-design',
  'company-fit',
];

export interface Requirement {
  id: string;
  text: string;
  kind: RequirementKind;
  priority: RequirementPriority;
}

export interface Question {
  id: string;
  requirement_ids: string[];
  category: QuestionCategory;
  prompt: string;
  answer_outline: string;
  /** 1..3 */
  difficulty: number;
}

export interface Flashcard {
  id: string;
  front: string;
  back: string;
  requirement_ids: string[];
}

export interface ScheduleDay {
  day: number;
  focus: string;
  question_ids: string[];
  /** integer minutes */
  minutes: number;
}

export interface Schedule {
  days_available: number;
  days: ScheduleDay[];
}

export interface Coverage {
  uncovered_requirement_ids: string[];
  passes: number;
}

export interface KitSource {
  company: string;
  company_url: string;
  role: string;
  location: string;
  jd_chars: number;
  researched_at: string;
  pages_used: string[];
}

export interface CompanyBrief {
  summary: string;
  what_they_do: string;
  sources: string[];
}

export interface RoleSection {
  title: string;
  seniority: string;
  responsibilities: string[];
  requirements: Requirement[];
}

/** Appendix A. `research` is a documented extension (see README). */
export interface Kit {
  source: KitSource;
  company_brief: CompanyBrief;
  role: RoleSection;
  questions: Question[];
  flashcards: Flashcard[];
  schedule: Schedule;
  coverage: Coverage;
  research?: ResearchReport;
}

/**
 * Honest reporting of what retrieval actually managed to do. The brief asks
 * for partial research to be recorded in the kit rather than hidden, so this
 * rides along as an extension field.
 */
export interface ResearchReport {
  hiring_page_found: boolean;
  hiring_pages: string[];
  about_pages: string[];
  discussion_sources: string[];
  discussion_searched: boolean;
  skipped_sources: SkippedSource[];
  notes: string[];
}

export interface SkippedSource {
  url: string;
  reason: string;
}

/** Provenance for a single generated item, used by the builder. */
export type ItemOrigin = 'generated' | 'edited' | 'manual';

export interface ItemState {
  origin: ItemOrigin;
  pinned: boolean;
  /** ISO timestamp of the last user edit, if any. */
  edited_at?: string;
  /** Which generation pass produced the item. */
  pass?: number;
}

export interface PracticeRecord {
  card_id: string;
  confidence: number; // 1 (again) .. 4 (easy)
  reviewed_at: string;
  /** Confidence-weighted due timestamp used to order the next session. */
  due_at: string;
  reps: number;
}

export type KitStatus = 'queued' | 'running' | 'ready' | 'failed';

/** What we persist. The canonical kit is one field of it. */
export interface KitDocument {
  id: string;
  user_id: string;
  status: KitStatus;
  /** hash(jd, company_url, days) - used to make generation idempotent. */
  fingerprint: string;
  days_requested: number;
  created_at: string;
  updated_at: string;
  kit: Kit | null;
  error: KitError | null;
  progress: StageProgress[];
  /** keyed by question / flashcard / brief id */
  item_state: Record<string, ItemState>;
  practice: PracticeRecord[];
}

export interface KitError {
  code: string;
  message: string;
}

export interface StageProgress {
  stage: string;
  status: 'pending' | 'running' | 'done' | 'skipped' | 'failed';
  detail?: string;
  started_at?: string;
  finished_at?: string;
}

export interface BuildKitInput {
  jd: string;
  company_url: string;
  days: number;
  /** Provided by the batch runner; the UI leaves it undefined. */
  case_id?: string;
}

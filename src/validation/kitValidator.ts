import type { Kit } from '../domain/types';
import { QUESTION_CATEGORIES, REQUIREMENT_KINDS, REQUIREMENT_PRIORITIES } from '../domain/types';

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

/**
 * Structural validation of Appendix A.
 *
 * Hand-written rather than a schema library, for two reasons: the shape is
 * fixed and small, and the interesting checks are relational - question ids
 * referenced by the schedule must exist, requirement ids referenced by
 * questions must exist, and every must-have must be both covered and
 * scheduled. A generic validator would catch the first half and miss the half
 * that matters.
 *
 * Errors block a kit from being saved or written to the batch output.
 * Warnings are recorded but do not.
 */
export function validateKit(kit: unknown): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const fail = (path: string, message: string) => errors.push({ path, message });
  const warn = (path: string, message: string) => warnings.push({ path, message });

  if (typeof kit !== 'object' || kit === null) {
    return { valid: false, errors: [{ path: '', message: 'kit is not an object' }], warnings };
  }
  const value = kit as Record<string, unknown>;

  for (const key of ['source', 'company_brief', 'role', 'questions', 'flashcards', 'schedule', 'coverage']) {
    if (!(key in value)) fail(key, 'required field is missing');
  }

  // --- source ---------------------------------------------------------------
  const source = asRecord(value.source);
  if (!source) fail('source', 'must be an object');
  else {
    for (const key of ['company', 'company_url', 'role', 'location', 'researched_at']) {
      if (typeof source[key] !== 'string') fail(`source.${key}`, 'must be a string');
    }
    if (!isInteger(source.jd_chars) || (source.jd_chars as number) < 0) {
      fail('source.jd_chars', 'must be a non-negative integer');
    }
    if (typeof source.researched_at === 'string' && Number.isNaN(Date.parse(source.researched_at))) {
      fail('source.researched_at', 'must be an ISO timestamp');
    }
    if (!isStringArray(source.pages_used)) fail('source.pages_used', 'must be an array of strings');
  }

  // --- company_brief --------------------------------------------------------
  const brief = asRecord(value.company_brief);
  if (!brief) fail('company_brief', 'must be an object');
  else {
    if (typeof brief.summary !== 'string') fail('company_brief.summary', 'must be a string');
    if (typeof brief.what_they_do !== 'string') fail('company_brief.what_they_do', 'must be a string');
    if (!isStringArray(brief.sources)) fail('company_brief.sources', 'must be an array of strings');
  }

  // --- role and requirements ------------------------------------------------
  const role = asRecord(value.role);
  const requirementIds = new Set<string>();
  const mustIds = new Set<string>();
  if (!role) fail('role', 'must be an object');
  else {
    if (typeof role.title !== 'string') fail('role.title', 'must be a string');
    if (typeof role.seniority !== 'string') fail('role.seniority', 'must be a string');
    if (!isStringArray(role.responsibilities)) {
      fail('role.responsibilities', 'must be an array of strings');
    }
    const requirements = Array.isArray(role.requirements) ? role.requirements : null;
    if (!requirements) fail('role.requirements', 'must be an array');
    else {
      requirements.forEach((entry, index) => {
        const path = `role.requirements[${index}]`;
        const requirement = asRecord(entry);
        if (!requirement) return fail(path, 'must be an object');
        if (typeof requirement.id !== 'string' || !requirement.id) {
          fail(`${path}.id`, 'must be a non-empty string');
        } else if (requirementIds.has(requirement.id)) {
          fail(`${path}.id`, `duplicate requirement id ${requirement.id}`);
        } else {
          requirementIds.add(requirement.id);
        }
        if (typeof requirement.text !== 'string' || requirement.text.trim().length === 0) {
          fail(`${path}.text`, 'must be a non-empty string');
        }
        if (!REQUIREMENT_KINDS.includes(requirement.kind as never)) {
          fail(`${path}.kind`, `must be one of ${REQUIREMENT_KINDS.join(' | ')}`);
        }
        if (!REQUIREMENT_PRIORITIES.includes(requirement.priority as never)) {
          fail(`${path}.priority`, `must be one of ${REQUIREMENT_PRIORITIES.join(' | ')}`);
        }
        if (requirement.priority === 'must' && typeof requirement.id === 'string') {
          mustIds.add(requirement.id);
        }
      });
    }
  }

  // --- questions ------------------------------------------------------------
  const questionIds = new Set<string>();
  const coveredRequirementIds = new Set<string>();
  const questions = Array.isArray(value.questions) ? value.questions : null;
  if (!questions) fail('questions', 'must be an array');
  else {
    questions.forEach((entry, index) => {
      const path = `questions[${index}]`;
      const question = asRecord(entry);
      if (!question) return fail(path, 'must be an object');
      if (typeof question.id !== 'string' || !question.id) fail(`${path}.id`, 'must be a non-empty string');
      else if (questionIds.has(question.id)) fail(`${path}.id`, `duplicate question id ${question.id}`);
      else questionIds.add(question.id);

      if (!QUESTION_CATEGORIES.includes(question.category as never)) {
        fail(`${path}.category`, `must be one of ${QUESTION_CATEGORIES.join(' | ')}`);
      }
      if (typeof question.prompt !== 'string' || question.prompt.trim().length === 0) {
        fail(`${path}.prompt`, 'must be a non-empty string');
      }
      if (typeof question.answer_outline !== 'string') {
        fail(`${path}.answer_outline`, 'must be a string');
      }
      if (!isInteger(question.difficulty) || (question.difficulty as number) < 1 || (question.difficulty as number) > 3) {
        fail(`${path}.difficulty`, 'must be an integer between 1 and 3');
      }
      if (!isStringArray(question.requirement_ids)) {
        fail(`${path}.requirement_ids`, 'must be an array of strings');
      } else {
        for (const id of question.requirement_ids as string[]) {
          if (!requirementIds.has(id)) {
            fail(`${path}.requirement_ids`, `references unknown requirement ${id}`);
          } else {
            coveredRequirementIds.add(id);
          }
        }
        if ((question.requirement_ids as string[]).length === 0) {
          warn(`${path}.requirement_ids`, 'question covers no requirement');
        }
      }
    });
  }

  // --- flashcards -----------------------------------------------------------
  const flashcardIds = new Set<string>();
  const flashcards = Array.isArray(value.flashcards) ? value.flashcards : null;
  if (!flashcards) fail('flashcards', 'must be an array');
  else {
    flashcards.forEach((entry, index) => {
      const path = `flashcards[${index}]`;
      const card = asRecord(entry);
      if (!card) return fail(path, 'must be an object');
      if (typeof card.id !== 'string' || !card.id) fail(`${path}.id`, 'must be a non-empty string');
      else if (flashcardIds.has(card.id)) fail(`${path}.id`, `duplicate flashcard id ${card.id}`);
      else flashcardIds.add(card.id);
      if (typeof card.front !== 'string' || card.front.trim().length === 0) {
        fail(`${path}.front`, 'must be a non-empty string');
      }
      if (typeof card.back !== 'string' || card.back.trim().length === 0) {
        fail(`${path}.back`, 'must be a non-empty string');
      }
      if (!isStringArray(card.requirement_ids)) {
        fail(`${path}.requirement_ids`, 'must be an array of strings');
      } else {
        for (const id of card.requirement_ids as string[]) {
          if (!requirementIds.has(id)) {
            fail(`${path}.requirement_ids`, `references unknown requirement ${id}`);
          }
        }
      }
    });
  }

  // --- schedule -------------------------------------------------------------
  const schedule = asRecord(value.schedule);
  const scheduledQuestionIds = new Set<string>();
  if (!schedule) fail('schedule', 'must be an object');
  else {
    const daysAvailable = schedule.days_available;
    if (!isInteger(daysAvailable) || (daysAvailable as number) < 1) {
      fail('schedule.days_available', 'must be a positive integer');
    }
    const days = Array.isArray(schedule.days) ? schedule.days : null;
    if (!days) fail('schedule.days', 'must be an array');
    else {
      if (isInteger(daysAvailable) && days.length !== daysAvailable) {
        fail(
          'schedule.days',
          `must contain exactly days_available entries (${days.length} != ${daysAvailable})`,
        );
      }
      days.forEach((entry, index) => {
        const path = `schedule.days[${index}]`;
        const day = asRecord(entry);
        if (!day) return fail(path, 'must be an object');
        if (day.day !== index + 1) fail(`${path}.day`, `must be ${index + 1}`);
        if (typeof day.focus !== 'string' || day.focus.trim().length === 0) {
          fail(`${path}.focus`, 'must be a non-empty string');
        }
        if (!isInteger(day.minutes) || (day.minutes as number) < 1) {
          fail(`${path}.minutes`, 'must be a positive integer');
        }
        if (!isStringArray(day.question_ids)) {
          fail(`${path}.question_ids`, 'must be an array of strings');
        } else {
          for (const id of day.question_ids as string[]) {
            if (!questionIds.has(id)) {
              fail(`${path}.question_ids`, `references unknown question ${id}`);
            } else {
              scheduledQuestionIds.add(id);
            }
          }
        }
      });
    }
  }

  // --- coverage -------------------------------------------------------------
  const coverage = asRecord(value.coverage);
  if (!coverage) fail('coverage', 'must be an object');
  else {
    if (!isStringArray(coverage.uncovered_requirement_ids)) {
      fail('coverage.uncovered_requirement_ids', 'must be an array of strings');
    } else {
      for (const id of coverage.uncovered_requirement_ids as string[]) {
        if (!requirementIds.has(id)) {
          fail('coverage.uncovered_requirement_ids', `references unknown requirement ${id}`);
        }
      }
    }
    if (!isInteger(coverage.passes) || (coverage.passes as number) < 1) {
      fail('coverage.passes', 'must be a positive integer');
    }
  }

  // --- relational guarantees ------------------------------------------------
  for (const id of mustIds) {
    if (!coveredRequirementIds.has(id)) {
      fail('coverage', `must-have requirement ${id} has no question against it`);
    }
  }
  const reported = new Set(
    isStringArray(coverage?.uncovered_requirement_ids)
      ? (coverage!.uncovered_requirement_ids as string[])
      : [],
  );
  for (const id of requirementIds) {
    const actuallyUncovered = !coveredRequirementIds.has(id);
    if (actuallyUncovered && !reported.has(id)) {
      fail('coverage.uncovered_requirement_ids', `requirement ${id} is uncovered but not reported`);
    }
    if (!actuallyUncovered && reported.has(id)) {
      fail('coverage.uncovered_requirement_ids', `requirement ${id} is reported uncovered but has questions`);
    }
  }
  for (const id of mustIds) {
    const questionsForRequirement = (questions ?? [])
      .map((entry) => asRecord(entry))
      .filter((question): question is Record<string, unknown> => Boolean(question))
      .filter((question) => (question.requirement_ids as string[] | undefined)?.includes(id))
      .map((question) => question.id as string);
    if (questionsForRequirement.length === 0) continue;
    const scheduled = questionsForRequirement.some((questionId) => scheduledQuestionIds.has(questionId));
    if (!scheduled) {
      fail('schedule', `no question covering must-have requirement ${id} appears in the schedule`);
    }
  }
  for (const id of questionIds) {
    if (!scheduledQuestionIds.has(id)) {
      warn('schedule', `question ${id} is not scheduled on any day`);
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

export function assertValidKit(kit: Kit): void {
  const result = validateKit(kit);
  if (!result.valid) {
    const detail = result.errors
      .slice(0, 5)
      .map((issue) => `${issue.path}: ${issue.message}`)
      .join('; ');
    throw new Error(`generated kit failed structural validation: ${detail}`);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value);
}

function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

import type { Question, Requirement } from '../domain/types';

export interface CoverageReport {
  /** requirement id -> ids of the questions that reference it */
  byRequirement: Record<string, string[]>;
  uncovered: Requirement[];
  uncoveredMust: Requirement[];
  uncoveredNice: Requirement[];
  /** Question ids that reference a requirement id that does not exist. */
  danglingQuestionIds: string[];
  coveredCount: number;
  totalCount: number;
}

/**
 * The coverage check is deterministic and lives in code, never in a prompt.
 *
 * It is a set operation: every requirement id, minus every requirement id
 * referenced by a question, is the gap. That is what makes coverage checkable
 * rather than a matter of the model's opinion, and it is why every requirement
 * carries a stable id in the first place.
 */
export function checkCoverage(requirements: Requirement[], questions: Question[]): CoverageReport {
  const byRequirement: Record<string, string[]> = {};
  for (const requirement of requirements) byRequirement[requirement.id] = [];

  const known = new Set(requirements.map((requirement) => requirement.id));
  const dangling: string[] = [];

  for (const question of questions) {
    let referencedSomething = false;
    for (const requirementId of question.requirement_ids) {
      if (!known.has(requirementId)) continue;
      byRequirement[requirementId]!.push(question.id);
      referencedSomething = true;
    }
    if (!referencedSomething && question.requirement_ids.length > 0) {
      dangling.push(question.id);
    }
  }

  const uncovered = requirements.filter(
    (requirement) => (byRequirement[requirement.id] ?? []).length === 0,
  );

  return {
    byRequirement,
    uncovered,
    uncoveredMust: uncovered.filter((requirement) => requirement.priority === 'must'),
    uncoveredNice: uncovered.filter((requirement) => requirement.priority === 'nice'),
    danglingQuestionIds: dangling,
    coveredCount: requirements.length - uncovered.length,
    totalCount: requirements.length,
  };
}

/** Convenience for logs and the UI. */
export function coverageRatio(report: CoverageReport): number {
  if (report.totalCount === 0) return 1;
  return report.coveredCount / report.totalCount;
}

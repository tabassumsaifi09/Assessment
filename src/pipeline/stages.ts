/** The pipeline in order. Progress events use these names verbatim. */
export const PIPELINE_STAGES = [
  'validate-input',
  'extract-requirements',
  'crawl-company',
  'classify-pages',
  'hiring-process',
  'public-discussion',
  'company-brief',
  'generate-questions',
  'coverage-check',
  'flashcards',
  'schedule',
  'validate-kit',
] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export interface ProgressEvent {
  stage: PipelineStage;
  status: 'running' | 'done' | 'skipped' | 'failed';
  detail?: string;
}

export type ProgressReporter = (event: ProgressEvent) => void;

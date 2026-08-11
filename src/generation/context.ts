import type { HiringProcess } from '../research/companyResearch';

/** Everything generation needs to know that is not a requirement. */
export interface GenerationContext {
  company: string;
  companyUrl: string;
  seniority: string;
  /** Facts pulled from the company site, already grounded in a fetched page. */
  facts: string[];
  process: HiringProcess;
  /** True when the posting was too thin to say much. */
  thin: boolean;
}

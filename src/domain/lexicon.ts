/**
 * Shared vocabulary for reading job descriptions.
 *
 * This is the only place where "what does a posting sound like" is encoded.
 * Both the deterministic offline model and the extraction verifier read from
 * it, so a change to how we recognise a "nice to have" happens once.
 */

export type SectionType =
  | 'responsibilities'
  | 'requirements'
  | 'nice'
  | 'benefits'
  | 'about'
  | 'unknown';

interface SectionRule {
  type: SectionType;
  pattern: RegExp;
}

/** Order matters: the first match wins, so narrower rules come first. */
const SECTION_RULES: SectionRule[] = [
  { type: 'nice', pattern: /\b(nice[- ]to[- ]have|bonus|bonus points|preferred qualifications|preferred skills|desirable|good to have|pluses|extra credit|it would be great)\b/i },
  { type: 'requirements', pattern: /\b(requirements?|qualifications?|must[- ]haves?|what you.?ll need|what we.?re looking for|who you are|skills? (and|&) experience|essential|you should have|minimum qualifications)\b/i },
  { type: 'responsibilities', pattern: /\b(responsibilit(y|ies)|what you.?ll do|the role|day[- ]to[- ]day|your impact|in this role|about the role|duties)\b/i },
  { type: 'benefits', pattern: /\b(benefits?|perks?|what we offer|compensation|salary|we provide|equal opportunit|how to apply|interview process|our values|why join|life at)\b/i },
  { type: 'about', pattern: /\b(about (us|the company|the team)|who we are|our (mission|story|company))\b/i },
];

export function detectSectionType(line: string): SectionType {
  const trimmed = line.trim();
  // Headers are short. A 200-character sentence containing the word
  // "requirements" is prose, not a heading.
  if (trimmed.length > 90) return 'unknown';
  const withoutPunctuation = trimmed.replace(/[:*#_-]+$/g, '').trim();
  const looksLikeHeading =
    /[:：]\s*$/.test(trimmed) ||
    /^#{1,4}\s/.test(trimmed) ||
    withoutPunctuation === withoutPunctuation.toUpperCase() ||
    withoutPunctuation.split(/\s+/).length <= 8;
  if (!looksLikeHeading) return 'unknown';
  for (const rule of SECTION_RULES) {
    if (rule.pattern.test(withoutPunctuation)) return rule.type;
  }
  return 'unknown';
}

/** Wording that downgrades a line to a "nice to have" regardless of section. */
export const NICE_MARKERS =
  /\b(nice to have|bonus|a plus|plus if|preferred|preferably|ideally|desirable|would be great|not required|optional|familiarity is a bonus|exposure to)\b/i;

/** Wording that marks a line as required regardless of section. */
export const MUST_MARKERS =
  /\b(must|required|require[sd]?|essential|minimum|at least|proven|demonstrated|strong (experience|background|knowledge)|solid (experience|understanding)|you have|deep (experience|knowledge)|expert)\b/i;

/** "5+ years", "3-5 years", "five years" all read as a hard requirement. */
export const EXPERIENCE_PATTERN = /\b(\d+\s*\+?\s*(?:-|to)?\s*\d*\s*years?|\b(?:two|three|four|five|six|seven|eight|ten)\s+years?)\b/i;

export const TECH_TOKENS = [
  'javascript', 'typescript', 'python', 'java', 'golang', 'go', 'rust', 'ruby', 'php', 'c#', 'c++',
  'scala', 'kotlin', 'swift', 'sql', 'nosql', 'graphql', 'rest', 'grpc', 'html', 'css', 'sass',
  'react', 'next.js', 'nextjs', 'vue', 'angular', 'svelte', 'node', 'node.js', 'nodejs', 'express',
  'nestjs', 'django', 'flask', 'rails', 'spring', 'laravel', '.net', 'dotnet',
  'postgres', 'postgresql', 'mysql', 'mongodb', 'redis', 'elasticsearch', 'dynamodb', 'kafka',
  'rabbitmq', 'snowflake', 'spark', 'airflow', 'dbt', 'hadoop',
  'aws', 'gcp', 'azure', 'docker', 'kubernetes', 'terraform', 'ansible', 'serverless', 'lambda',
  'ci/cd', 'cicd', 'jenkins', 'github actions', 'gitlab', 'observability', 'prometheus', 'grafana',
  'testing', 'unit tests', 'integration tests', 'tdd', 'jest', 'cypress', 'playwright', 'pytest',
  'microservices', 'api', 'apis', 'distributed', 'scalable', 'scalability', 'architecture',
  'performance', 'caching', 'queue', 'event-driven', 'websockets', 'oauth', 'authentication',
  'security', 'encryption', 'linux', 'git', 'algorithms', 'data structures', 'machine learning',
  'llm', 'ml', 'ai', 'etl', 'data pipeline', 'frontend', 'backend', 'full-stack', 'fullstack',
  'mobile', 'ios', 'android', 'react native', 'accessibility', 'wcag', 'tailwind', 'redux',
];

/**
 * Behavioural, domain and system-design markers are stem patterns: they anchor
 * at a word boundary but deliberately do not close one, so "communicat" catches
 * communication, communicating and communicator alike.
 */
export const BEHAVIOURAL_MARKERS =
  /\b(mentor|coach|communicat|collaborat|stakeholder|leadership|lead a team|lead the team|ownership|autonom|cross[- ]functional|presenting|presentation|empath|feedback|onboard|pairing|team player|interpersonal|written and verbal|self[- ]start|proactive|ambigu|fast[- ]paced|remote[- ]first|influenc|conflict|work(ing)? with (designers|product|pm|stakeholders)|work independently|independent|culture)/i;

export const DOMAIN_MARKERS =
  /\b(fintech|payment|banking|healthcare|health tech|hipaa|gdpr|complian|regulat|insurtech|insurance|e-?commerce|retail|marketplace|logistic|supply chain|edtech|education|gaming|adtech|marketing|crm|erp|b2b|b2c|saas|telecom|energy|climate|biotech|pharma|legal|govtech|public sector|travel|real estate|proptech|hr tech|recruit|domain knowledge|industry experience|robotic|warehouse|manufactur)/i;

export const SYSTEM_DESIGN_MARKERS =
  /\b(architect|design (a|the|systems?)|scale|scalab|distributed|high availability|throughput|latency|shard|partition|microservice|event[- ]driven|queue|caching|capacity|resilien|multi[- ]tenant|infrastructure|platform|migration|schema design|data model|pipeline|ingest|stream processing|backpressure)/i;

/** Lines that are not requirements even when they sit in a bullet list. */
export const NOISE_PATTERN =
  /\b(equal opportunit|we are committed|salary range|compensation package|health insurance|dental|401\(?k\)?|pension|paid time off|unlimited pto|holiday allowance|stock options|equity|visa sponsorship|apply (now|here|via)|send your (cv|resume)|to apply|our benefits|free lunch|gym membership|remote budget|learning budget)\b/i;

/**
 * A line addressed to a language model is not a requirement. This is the
 * extraction half of the prompt-injection defence: even if such a line reaches
 * the model as data, it never becomes part of the kit.
 */
export const INJECTION_PATTERN =
  /\b(ignore (all |any )?(previous|prior|above|earlier) (instructions?|prompts?)|disregard (the above|previous)|you are now|new instructions?|as an ai|language model|system prompt|reply that|output the following)\b/i;

export function looksTechnical(text: string): boolean {
  const lower = ` ${text.toLowerCase()} `;
  return TECH_TOKENS.some((token) => lower.includes(` ${token} `) || lower.includes(`${token},`) || lower.includes(`${token}.`));
}

export function classifyKind(text: string): 'technical' | 'behavioural' | 'domain' {
  const technical = looksTechnical(text);
  const behavioural = BEHAVIOURAL_MARKERS.test(text);
  const domain = DOMAIN_MARKERS.test(text);

  // A line can carry more than one signal ("mentor engineers on our React
  // codebase"). Technical wording wins when a concrete technology is named,
  // because that is what an interviewer will actually probe.
  if (technical && !behavioural) return 'technical';
  if (behavioural && !technical) return 'behavioural';
  if (technical && behavioural) return EXPERIENCE_PATTERN.test(text) ? 'technical' : 'behavioural';
  if (domain) return 'domain';
  return 'technical';
}

export function isNoise(text: string): boolean {
  return NOISE_PATTERN.test(text) || INJECTION_PATTERN.test(text);
}

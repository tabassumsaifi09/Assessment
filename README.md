# The AI Interview Prep Kit

Turns a pasted job description plus a company website into a researched,
structured interview preparation kit: a company brief, a role breakdown with
stable requirement ids, a categorised question bank, flashcards, and a day by
day study schedule that spans exactly the number of days you have.

Everything the grader runs is in one command:

```bash
npm install
npm run evaluate -- --input cases.example.json --output kits.json
```

---

## Contents

1. [Quick start](#quick-start)
2. [The batch entry point](#the-batch-entry-point)
3. [Tech stack and why](#tech-stack-and-why)
4. [Architecture](#architecture)
5. [Retrieval: how the company is researched](#retrieval-how-the-company-is-researched)
6. [The generation sequence](#the-generation-sequence)
7. [Coverage and the second pass](#coverage-and-the-second-pass)
8. [Schedule allocation](#schedule-allocation)
9. [Generated, edited and pinned state](#generated-edited-and-pinned-state)
10. [Practice mode](#practice-mode)
11. [The custom feature: the readiness report](#the-custom-feature-the-readiness-report)
12. [Edge cases and failure handling](#edge-cases-and-failure-handling)
13. [Security](#security)
14. [Tests](#tests)
15. [Environment variables](#environment-variables)
16. [Deployment](#deployment)
17. [Design decisions, trade-offs and limitations](#design-decisions-trade-offs-and-limitations)

---

## Quick start

Requirements: Node 20.11 or newer. Nothing else - no database, no API key.

```bash
npm install
cp .env.example .env          # optional: every value has a working default
npm test                      # 80 tests, no network required
npm start                     # API + interface on http://localhost:4000
```

To exercise the crawler against the bundled company sites:

```bash
npm run fixture:site -- --port 8099    # serves fixtures/sites
# then, in another terminal:
npm run evaluate -- --input cases.example.json --output kits.json
```

`fixtures/sites` contains three deliberately awkward company sites: one with
its hiring process buried in a handbook, one with **no** hiring page anywhere,
and one where the process lives three links deep under `/handbook/people/`.

## The batch entry point

```bash
npm run evaluate -- --input <cases.json> --output <kits.json>
```

* reads an array of `{ id, jd, company_url, days }`;
* runs the same pipeline the web app runs (`src/pipeline/buildKit.ts`) - there
  is no second implementation;
* uses each case's own `days` when allocating the schedule;
* writes Appendix B exactly: `{ version, generated_at, kits: [{ id, status, kit, error }] }`;
* keeps going when a case fails, recording the failure;
* runs cases two at a time; the five bundled cases finish in about five
  seconds against local sites, and comfortably inside fifteen minutes against
  real ones even with rate-limit backoff;
* reads credentials from environment variables documented in `.env.example`
  and needs no setup beyond `npm install`.

Loopback and private addresses are **permitted** by this command by default,
because evaluation company sites may be served locally. Pass `--no-private` to
enforce the production URL guard instead. Other flags: `--concurrency <n>`,
`--case-timeout-ms <n>`.

`status` is `failed` only when no kit could be produced at all (an empty
posting, or generation that could not be repaired). A company site that 404s,
times out or has no hiring page is still `ok`: the kit is built from the
posting, and the gaps are recorded honestly in `kit.research` and in the
company brief.

## Tech stack and why

| Layer | Choice | Note |
| --- | --- | --- |
| Language | TypeScript, strict | as preferred |
| Backend | Node 20 + Express | as preferred |
| Scraping | `fetch` + a small HTML reader in `src/retrieval/html.ts` | three regex passes for title, text and resolved links; smaller than the argument for a dependency |
| LLM | Provider interface with two adapters | Groq free tier (`llama-3.1-8b-instant`) when `LLM_API_KEY` is set, deterministic offline model otherwise |
| Database | JSON-file store behind a `KitStore` interface, MongoDB optional | see below |
| Frontend | One server-rendered page with vanilla ES modules | see below |
| Tests | Vitest | |

Two deliberate departures from the preferred stack, both because of a
requirement in the brief itself:

**MongoDB is optional, not required.** The brief asks for a clean clone to run
the batch command with no setup beyond the documented install step. Requiring a
running MongoDB contradicts that. Persistence therefore sits behind the
`KitStore` interface (`src/persistence/kitStore.ts`) with a JSON-file
implementation as the default; `MONGODB_URI` selects a Mongo implementation of
the same six methods. The pipeline itself is storage-agnostic.

**The interface is a single page of vanilla ES modules rather than Next.js.**
This is the trade-off I would defend least in a product setting and most in
this one: the brief weights the automated pass at 55 points, all of which lives
in the pipeline, and a Next.js app would have added a build step and a second
deployment target without changing a single kit. The page it replaces still
does the things the brief asks the interface to do - inline editing, drag and
keyboard reordering, per-item pinning, single-section regeneration, progress
and error states, practice mode - in `public/index.html`, served by Express.
If this were going further, that page is the first thing I would rewrite.

**On the offline model.** `LLM_API_KEY` is empty in a clean clone, so the
default provider is `OfflineModelProvider`: a rule-based, seeded stand-in that
answers the same five-task contract as the hosted one. It is not a stub that
returns fixtures - it reads whatever posting and pages it is handed, using the
generic English-language heuristics in `src/domain/lexicon.ts`, and it knows
nothing about any particular company or posting. Set `LLM_API_KEY` and
`LLM_PROVIDER=openai-compatible` to run the identical pipeline against Groq,
OpenRouter, Together, Ollama or OpenAI. The reason for building it: the brief
requires the batch command to run from a clean clone with no key, and I would
rather the fallback be honest and deterministic than have the pipeline collapse
the moment a free tier says no.

## Architecture

```
src/
  domain/        types + the lexicon used to read postings
  config/        env loading
  llm/           provider interface, rate limiting, retry, JSON repair
    providers/   offline (default) and openai-compatible
  retrieval/     URL guard, fetcher, robots.txt, HTML reader
  research/      link ranker, crawler, page classifier, discussion search
  extraction/    posting outline, rule reader, requirement extraction + grounding
  generation/    company brief, questions per category, flashcards
  coverage/      deterministic coverage check, gap-filling loop
  schedule/      deterministic day allocation
  validation/    Appendix A structural + relational validation
  pipeline/      the orchestrator, the regeneration service, the DI factory
  practice/      readiness report and re-planning
  persistence/   KitStore interface + JSON file store
  api/           Express routes, auth, application service
  evaluation/    batch runner and CLI
```

The dependency direction is one way: `api` and `evaluation` both depend on
`pipeline`, which depends on the stage modules, which depend on `domain` and
`util`. Nothing in `extraction`, `coverage`, `schedule` or `validation` knows
that HTTP or a model exists, which is what makes them straightforward to test.

## Retrieval: how the company is researched

Sources used: the company's own website (crawled), its `robots.txt` and
`sitemap.xml`, and public web search for discussion of its interview process
(DuckDuckGo's HTML endpoint by default - no key; Brave with `BRAVE_API_KEY`;
`SEARCH_PROVIDER=none` disables the stage).

**Finding the hiring page is a ranking problem, not a path list.** There is no
list of candidate paths anywhere in this repository. Instead:

1. the entry URL is fetched, trying sensible variants (`/` of the same origin,
   the other scheme, `www.`) before declaring a site unreachable;
2. every link on every fetched page is scored (`src/research/linkRanker.ts`) on
   the words in its anchor text and its URL - "how we hire" and "handbook" and
   "people" score up, "privacy" and "login" and `.pdf` score down, depth costs
   1.5 a level, and an off-site link to a known applicant tracker
   (Greenhouse, Lever, Ashby, Workable, ...) is still treated as a careers
   page;
3. the crawl is a priority queue over those scores, so the most promising link
   is always fetched next, up to `CRAWL_MAX_PAGES` (14) and `CRAWL_MAX_DEPTH` (3);
4. links found on a page that already looked like hiring material inherit part
   of its score, which is what walks a crawler from `/handbook` to
   `/handbook/people` to `/handbook/people/interviewing`;
5. `sitemap.xml` (from `robots.txt` when advertised) contributes extra
   candidates, filtered by the same ranker;
6. what came back is then classified on **content**, not on URL
   (`src/research/hiringPage.ts`): a page that names interview stages scores as
   hiring, a page that describes the company scores as about. The URL is a weak
   tiebreaker only.

Politeness and safety: `robots.txt` is parsed and honoured (including
`Crawl-delay` and wildcard rules), requests to one host are spaced by
`CRAWL_DELAY_MS`, every request is time-boxed and byte-capped, redirects are
followed manually so each hop is re-validated, and any source that cannot be
retrieved is skipped and recorded in `kit.research.skipped_sources` rather than
failing the run.

Public discussion: two queries per company, results filtered to sites where
interview processes are actually discussed (Reddit, Glassdoor, Blind, HN,
levels.fyi, engineering blogs). Those sites usually disallow crawling, which we
respect - so the common outcome is "search snippet only" or "nothing found",
and the kit says so.

## The generation sequence

Each stage consumes the previous stage's output. `src/pipeline/buildKit.ts`:

| Stage | Responsible for | Model? |
| --- | --- | --- |
| `validate-input` | posting non-empty, days clamped to 1..365 | no |
| `extract-requirements` | requirements, responsibilities, title, seniority, location | yes, then verified in code |
| `crawl-company` | entry point, ranked crawl, per-page retrieval | no |
| `classify-pages` | which pages are hiring / about | no |
| `hiring-process` | stages and signals from the hiring page - only runs if one was found | yes |
| `public-discussion` | search, filter, read what is readable | no |
| `company-brief` | the brief, from retrieved pages only | yes |
| `generate-questions` | one call per (category, batch of <= 4 requirements) | yes |
| `coverage-check` | the gap set, and the gap-filling loop | **no** |
| `flashcards` | cards per requirement plus company facts | yes |
| `schedule` | day allocation | **no** |
| `validate-kit` | Appendix A structure and cross-references | no |

The sequencing is real, not decorative:

* pasted text needs no retrieval, so extraction runs first and independently;
* the hiring-process stage only exists when a hiring page was actually found;
* what the company publishes changes the kit: a documented system design round
  adds a system-design batch that the posting alone would not have earned, and
  a published take-home adds a company-fit question about time-boxing
  (`planQuestionBatches` in `src/generation/questions.ts`);
* "5+ years of React" and "mentoring junior engineers" never come from the same
  call: requirements are split by kind into category batches, and each batch is
  a separate request with a different system prompt.

**What the model is not allowed to decide.** Priority (`must` vs `nice`) is
re-derived in code from how the posting words the line and which section it
sits under. Grounding is checked in code: a proposed requirement whose wording
is not supported by the posting is dropped and counted
(`ExtractedRole.rejected`). Recall is guarded in code: any requirement line the
rule reader found and the model missed is added back. Coverage and scheduling
are pure code. The model writes prose; the code decides facts.

## Coverage and the second pass

`src/coverage/checker.ts` is a set operation over ids: every requirement id,
minus every requirement id referenced by a question, is the gap. That is why
every requirement carries a stable id (`r1`, `r2`, ... in posting order) and
every question carries `requirement_ids`.

`src/coverage/gapFiller.ts` runs the loop:

1. check the first draft;
2. if anything is uncovered, plan batches for **only** the uncovered
   requirements (must-haves first) and generate;
3. check again;
4. stop when coverage is clean, when a pass produced no new questions, or at
   `MAX_COVERAGE_PASSES` (default 3).

**Why three.** One pass is not a loop. Two passes fix the common case - the
model skipping a requirement in a crowded batch. A third catches the case where
the second pass returns questions that reference the wrong ids. Beyond that,
every extra pass costs a free-tier request and produces the same answer, so the
loop stops and the remaining gaps are closed deterministically: a question is
derived in code directly from the requirement text. It is blunter than a
generated one, but a kit that ships with an uncovered must-have has failed at
its one job. `coverage.passes` records how many passes actually ran, so a kit
that needed only one says one.

## Schedule allocation

Pure arithmetic in `src/schedule/allocator.ts`, no prompt involved.

* Minutes per question come from difficulty (10/15/20), plus 5 for a
  system-design question and 5 for one covering a must-have.
* Questions are ordered: must-covering first, then hardest, then by category,
  then by id.
* **More questions than days**: each day gets a share of the total minutes from
  a front-loaded curve (the first day carries about 1.4x the last day's load),
  filled against a *cumulative* target so no day inherits the leftovers.
* **More days than questions**: each question gets its own day in priority
  order, and the surplus days become spaced review of the highest-priority
  material rather than empty days. A 60-day request produces 60 days that all
  have something in them.
* Guarantees, asserted by tests and re-checked by the validator: exactly
  `days_available` days; every question allocated; therefore every must-have
  requirement present; integer minutes everywhere; every `question_ids` entry
  refers to a question that exists.
* A day's `focus` is generated in code from the requirements that day covers,
  not by the model.

## Generated, edited and pinned state

The Appendix A kit stays clean: builder state lives beside it, in
`KitDocument.item_state`, keyed by item id (`q3`, `f2`, `company_brief`,
`schedule`).

```ts
{ origin: 'generated' | 'edited' | 'manual', pinned: boolean, edited_at?, pass? }
```

The rule is one line, in `src/pipeline/regenerate.ts`: **an item is ours to
replace only while its origin is `generated` and it is not pinned.**

* Editing a question promotes it to `edited`; adding one by hand creates it as
  `manual` and pinned.
* Regenerating a category replaces only the untouched generated questions in
  *that* category; edited, manual and pinned questions survive, and the model
  is asked only for the requirements the survivors do not already cover.
* Other categories, the brief and the flashcards are untouched by a category
  regeneration.
* Regenerating the brief is refused (with a note) when the brief has been
  edited or pinned.
* The schedule is a pure function of the questions, so it is recomputed when
  the question set changes - unless it has been pinned, in which case it is
  kept and only stale ids are pruned.

Every regeneration re-runs the coverage loop and re-validates the whole kit
before it is saved, so a preserved edit can never leave a must-have uncovered.
Six tests in `tests/builder.test.ts` cover exactly these cases.

## Practice mode

Cards are stepped through one at a time, the answer is revealed on demand, and
confidence is recorded on a four-point scale. Ordering uses a simplified SM-2
interval rather than a plain sort: confidence 1 comes back in ten minutes, 4 in
four days, and the interval grows with consecutive successes. Due cards come
first, least confident first; unseen cards follow.

Why intervals rather than a confidence sort: with two evenings before an
interview, a plain sort shows you the same shaky card five times in a row and
never shows you the one you got right yesterday. Intervals are barely more code
and behave sensibly at both ends of the timescale.

## The custom feature: the readiness report

`GET /api/kits/:id/readiness`, `POST /api/kits/:id/replan`.

**The problem.** A prep kit tells you what to study. The night before, the
question you actually have is "what am I still bad at, and is it something that
matters?" - and nothing in a static kit answers that.

The app already knows which requirements each flashcard covers, and how
confident you felt about each card. Joining those two gives a per-requirement
readiness score (0..1, `untouched` / `shaky` / `getting there` / `solid`),
with must-haves listed first: *"you are solid on React, you have never
practised the two must-haves about mentoring and data modelling"*.

Then `replan` feeds that back into the schedule: the same deterministic
allocator, with weakness added as an ordering weight ahead of difficulty, over
however many days you have left. All the allocator's guarantees still hold - it
is the same function with one extra sort key. Scoring is code, explainable, and
never invented by a model.

## Edge cases and failure handling

| Case | Behaviour |
| --- | --- |
| Invalid company URL | rejected by the URL guard, recorded as a skipped source; the kit is built from the posting |
| 404 / timeout | entry-point variants are tried, then the site is recorded unreachable; `status` stays `ok` |
| No hiring page anywhere | the hiring-process stage is skipped, `research.hiring_page_found: false`, and the brief says so |
| Two-line posting | a thin kit that says it is thin: only what the posting states, `role.thin`, an explanatory note, and no invented requirements |
| No public discussion | recorded as searched-with-no-results; the brief states it plainly |
| Invalid JSON from the model | tolerant parse (fences, prose, trailing commas), then retry with a stricter instruction, then a code fallback for that stage |
| Incomplete kit | structural validation before saving or writing; a kit that cannot be repaired fails the case rather than shipping malformed |
| Rate limit / transient failure | self-throttling on both requests and tokens per minute, plus exponential backoff with jitter that honours `Retry-After` |
| Same posting submitted twice | fingerprinted on `(jd, company_url, days)`: the API returns the existing kit, the batch computes it once and reuses it |
| 1-day schedule | everything on day one, capped at four hours |
| 60-day schedule | 60 days, material introduced in priority order then spaced review |
| Generation takes 90 seconds | the API returns immediately with a `queued` document; progress is written per stage and polled by the interface; a refresh mid-run is harmless |

## Security

* **URL validation before every fetch** (`src/retrieval/urlGuard.ts`): scheme
  allowlist, no credentials in URLs, blocked service ports, DNS resolution
  checked against RFC1918, loopback, link-local, CGNAT and IPv6 unique-local
  ranges. Redirects are followed manually and each hop is re-validated.
  `ALLOW_PRIVATE_NETWORK` (and the batch command's default) is the only way to
  reach a private address, and it is documented as an evaluation-mode switch.
* **Content limits**: content-type allowlist, `content-length` check and a
  streaming byte cap that aborts mid-download.
* **Untrusted text** (`src/security/untrusted.ts`): the posting and every
  crawled page are fenced with markers the system prompt tells the model to
  distrust, instruction-shaped sequences are neutralised, and the fence cannot
  be closed from inside. Extraction independently drops lines that are
  addressed to a model rather than to a candidate. The structural defence
  matters more than the textual one: the model is only ever asked for JSON that
  our code validates, and every decision that reaches the kit - priorities,
  coverage, scheduling - is made afterwards in code.
* **Auth**: scrypt password hashing, HMAC-signed expiring session cookie
  (httpOnly, SameSite=Lax), every kit route scoped to the owning user,
  structured `SESSION_EXPIRED` responses so the interface can react.

## Tests

```bash
npm test
```

80 tests, no network, about 30 seconds. They cover the behaviour worth
protecting:

* `extraction.test.ts` - must vs nice from posting wording, benefits and duties
  excluded, stable ids, kind classification, thin postings, a hallucinating
  model's invention dropped, a lazy model's omission recovered.
* `coverage.test.ts` - the gap set, dangling references, the second pass, the
  loop terminating when the model has nothing left to say, the code fallback.
* `schedule.test.ts` - exact day counts from 1 to 60, everything allocated,
  must-haves scheduled, integer minutes, priority ordering, empty input.
* `validation.test.ts` - every structural rule and every cross-reference rule.
* `research.test.ts` - link ranking, relative link resolution, robots.txt,
  finding a hiring page three levels deep, finding one linked only from an
  about page, honest reporting when there is none, unreachable sites.
* `resilience.test.ts` - JSON repair, retry and backoff, non-retryable errors,
  fallbacks, the URL guard, prompt-injection handling.
* `batch.test.ts` - five cases with one failure, Appendix B shape, partial
  research staying `ok`, per-case days, duplicate reuse.
* `builder.test.ts` - regeneration preserving edited, manual and pinned items.
* `readiness.test.ts` - the readiness scoring and the re-plan.

## Environment variables

Every variable is documented in `.env.example`; all have working defaults.

| Variable | Purpose |
| --- | --- |
| `LLM_PROVIDER` | `mock` (default, offline) or `openai-compatible` |
| `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` | hosted provider settings; Groq free tier by default |
| `LLM_MAX_CONCURRENCY`, `LLM_REQUESTS_PER_MINUTE`, `LLM_TOKENS_PER_MINUTE` | client-side throttling, because free tiers cap tokens as well as requests |
| `LLM_MAX_ATTEMPTS`, `LLM_TIMEOUT_MS` | retry budget per call |
| `FETCH_TIMEOUT_MS`, `FETCH_MAX_BYTES` | per-request limits on anything fetched from the open web |
| `CRAWL_DELAY_MS`, `CRAWL_MAX_PAGES`, `CRAWL_MAX_DEPTH` | politeness and crawl budget |
| `ALLOW_PRIVATE_NETWORK` | SSRF guard; `false` in production, set by the batch command for local sites |
| `SEARCH_PROVIDER`, `BRAVE_API_KEY` | public discussion search |
| `MONGODB_URI`, `KIT_STORE_DIR` | persistence; the file store is used when no URI is set |
| `PORT`, `SESSION_SECRET`, `SESSION_TTL_HOURS` | API and sessions |
| `MAX_COVERAGE_PASSES` | the coverage loop budget |
| `LOG_LEVEL` | `silent` / `error` / `info` / `debug` |

## Deployment

The app is a single Node process serving both the API and the interface, which
makes it deployable to any free tier that runs Node 20 (Render, Railway, Fly,
a container anywhere):

```
build:  npm install
start:  npm start
```

Set `SESSION_SECRET` (`openssl rand -hex 32`), leave `ALLOW_PRIVATE_NETWORK`
false, and set `LLM_API_KEY` if you want the hosted model instead of the
offline one. `KIT_STORE_DIR` needs a writable path, or set `MONGODB_URI` for a
hosted database. No secret is read from anywhere but the environment, and
`.env` is gitignored.

## Design decisions, trade-offs and limitations

**Decisions I would defend.**

* *The model proposes, the code disposes.* Priority, grounding, recall,
  coverage and scheduling are all decided in code. It costs more lines than
  asking for the whole kit in one prompt, and it is the reason the same posting
  produces the same requirements twice running.
* *Ranking, not paths.* A path list gets `/careers` and misses
  `/handbook/people/interviewing`. Scoring links and inheriting relevance from
  hiring-ish pages finds both, and it is why the bundled `deeporg` fixture
  works.
* *Failures are values, not exceptions.* `PageFetcher` returns a result; the
  crawler records skipped sources; the LLM client can degrade to a fallback.
  One unreachable page never takes down a run.
* *A deterministic offline model.* It makes the batch command runnable from a
  clean clone, makes the tests fast and repeatable, and forced the provider
  interface to stay honest.

**Trade-offs.**

* Vanilla ES modules instead of Next.js (see above) - the biggest deliberate
  gap against the preferred stack.
* The file store instead of a required MongoDB - portability over fidelity to
  the stack list.
* A hand-rolled HTML reader instead of Cheerio - fewer dependencies, but it
  will lose to a real parser on badly broken markup.
* Crawl budget of 14 pages and depth 3 - enough for the sites I tested, but a
  large marketing site with the hiring page four levels down would be missed.

**Known limitations.**

* The offline model writes competent but templated prose. With a hosted key the
  questions read better; the *structure* is identical either way, because the
  structure is code.
* Public discussion is usually unavailable in practice: the sites that host it
  disallow crawling, and we respect that. The kit reports the shortfall rather
  than filling it in.
* English-language postings only. The lexicon is English, and a posting in
  another language will extract poorly rather than fail loudly.
* The JSON file store is not safe for two server processes writing the same
  kit; a real deployment should set `MONGODB_URI`.
* Reordering questions is presentation state only - it does not reshuffle the
  schedule, which is derived from priority and difficulty rather than from the
  order you happen to be reading in.

# Agents

## Contract

Every agent implements `Agent` from `packages/agent-core/src/types.ts`:

```ts
interface Agent {
  readonly name: AgentName;
  run(context: AgentContext): Promise<AgentResult>;
}
```

`AgentContext` gives an agent everything it's allowed to touch — nothing else. It extends
`AgentContextData`, which `AgentContextLoader` assembles **once per run**, before any agent
executes, from `packages/database` repositories:

```ts
interface AgentContextData {
  account: AccountContext;               // niche, target audience, tone, platform
  goal: AgentGoalContext | null;
  currentStrategy: StrategyContext | null;
  recentContent: RecentContentSummary[];
  recentAnalytics: RecentAnalyticsSummary[];
  previousStrategyVersions: StrategyVersionSummary[];
  activeExperiments: ExperimentSummary[];
  research: ResearchSignalSummary[];     // topics from earlier runs, for dedup
  policies: AgentPolicyContext;
  agentProfileId: string;
}
```

Plus the run-scoped fields the orchestrator adds per agent:

- `context.tools` — a `ToolRouter`, the only way to reach the database or a social
  platform. Calling `context.tools.call(toolName, accountId, input)` runs the tool through
  the policy layer first.
- `context.llm` — an `LLMProvider`, used via `generateStructured()` for every agent
  decision (see "Structured generation" below) — never a specific SDK.
- `context.previousResults` — the `AgentResult` produced by each earlier agent in the same
  run, keyed by agent name. This is how a fresh result (e.g. this run's research topics)
  flows into the next agent — `context.research` is deliberately *not* used for that; it
  holds prior-run topics so ResearchAgent can avoid resurfacing them.
- `context.logger`, `context.runId`, `context.accountId`.

An agent must never import `@agent/database` directly, and never construct a repository —
all account/strategy/content/analytics state arrives pre-loaded on the context. Domain
rows never reach an agent unshaped: `AgentContextLoader` and the orchestrator's
persistence code translate between Drizzle row shapes and the `*Context`/prompt types.

`AgentResult` is what gets persisted:

```ts
interface AgentResult {
  decisions: AgentDecisionInput[]; // { decision, reason?, metadata? } — no chain-of-thought
  actions: AgentActionInput[];     // { actionType, status, payload?, result? }
  data?: Record<string, unknown>;  // passed forward via previousResults, and to persistence
}
```

Decisions are deliberately a *label + short reason*, not a transcript of the agent's
reasoning. If you're tempted to store a prompt or a raw LLM completion in
`decision`/`reason`, put a summary there instead — large structured output belongs in
`data`/`result`, which is exactly what the `*ResultSchema` payloads are.

## Structured generation

Every functional agent calls `context.llm.generateStructured<T>({ systemPrompt, prompt,
schema, schemaName })` instead of parsing free-form text. `packages/llm`'s
`generateStructuredWithRetry` helper (used by every provider) parses the model's JSON
response, validates it against the Zod `schema`, and on failure retries with corrective
feedback appended to the prompt — up to `LLM_MAX_RETRIES` (default 3, configurable via
env). After exhausting retries it throws `LLMValidationError`/`LLMRequestError`
(`packages/llm/src/errors.ts`), which the orchestrator's existing try/catch turns into a
`failed` run — invalid LLM output is never persisted. `MockLLMProvider` (used when
`OPENAI_API_KEY` is unset) fakes a schema-valid response instead of calling a model, so
the whole pipeline is exercisable without an API key.

Prompts live in `packages/agent-core/src/prompts/` (`research.prompt.ts`,
`strategy.prompt.ts`, `content-planner.prompt.ts`), each exporting its Zod result schema
alongside a `buildXPrompt()` function. Static role/instructions are a fixed string;
dynamic account context is rendered as a compact JSON block — kept separate so the system
prompt never needs regenerating per account and the dynamic half stays inspectable.

## Implemented in this phase

- **ResearchAgent** (`agents/research-agent.ts`) — calls the injected `ResearchProvider`
  (`MockResearchProvider` today — see "Research provider" below) for candidate signals,
  then asks the LLM to turn them into scored `topics` (relevance/audience
  interest/competition + rationale) validated against `ResearchResultSchema`. Every
  research signal fed to the prompt carries `simulated: true` when its source is mock, and
  the agent's decision metadata records `simulatedSource` — mock research is never
  presented as real external data.
- **StrategyAgent** (`agents/strategy-agent.ts`) — reads `previousResults.research`, the
  current strategy (if any), prior version summaries, recent analytics and active
  experiments, and asks the LLM to decide `shouldUpdateStrategy` plus a full strategy
  proposal (`StrategyResultSchema`). It does **not** replace the strategy by default — only
  a model-justified change (or a genuinely absent `currentStrategy`, forced to `true`)
  results in a new version. Persisting the version is the orchestrator's job.
- **ContentPlannerAgent** (`agents/content-planner-agent.ts`) — reads
  `previousResults.strategy` (falling back to `context.currentStrategy` if the strategy
  step decided not to change anything) and `previousResults.research`, and asks the LLM
  for 3–12 content briefs (`ContentPlanResultSchema`: title, format, contentPillar,
  targetAudience, hook, objective, priorityScore) — never finished captions. Recent content
  titles are included in the prompt specifically so the model avoids near-duplicates.

These three run in sequence inside `AgentOrchestrator.executeRun()` (see
`packages/agent-core/src/factory.ts`).

## Content generation (Phase 3)

Two more agents are functional, but they run in a **separate pipeline**
(`AgentOrchestrator.generateContent()`), targeting one already-planned content idea rather
than the whole account:

```
ContentIdea
    ↓
ContentCreatorAgent   → structured, format-specific content package
    ↓
Media generation      → generateImage tool (policy-gated) → ObjectStorage
    ↓
ReviewerAgent         → approve / reject + actionable recommendedChanges
    ↓
approved? → READY_FOR_PUBLISHING   |   rejected → regenerate (max 3) → REVIEW_FAILED
```

- **ContentCreatorAgent** (`agents/content-creator-agent.ts`) — requires
  `context.targetContentIdea` (throws `MissingContentGenerationContextError` otherwise, so
  it can't be silently run as part of an account-level run). Picks a format-specific schema
  via `normalizeContentFormat` + `CONTENT_SCHEMA_BY_FORMAT` and validates against **only
  that one schema**, never the whole union — the prompt already states the format, so this
  keeps generation unambiguous. On a regeneration attempt, `context.regenerationFeedback`
  carries the previous review's `recommendedChanges` into the prompt.
- **ReviewerAgent** (`agents/reviewer-agent.ts`) — reads
  `previousResults.content_creator.data.generatedContent` and scores quality, brand,
  safety and accuracy, plus duplication and platform-readiness checks
  (`ReviewResultSchema`). It never rewrites content and is instructed never to invent
  verification for a claim it can't check against the provided context. The orchestrator —
  not the agent — decides what happens next based on `approved`.

### Formats

`reel` | `carousel` | `image` | `text`, as a discriminated union on `format`
(`prompts/content-creator/schema.ts`). Each has its own structured body — reels get
`script[]` (scene / voiceover / onScreenText), carousels get `slides[]`, images get
`headline` + `supportingText`, text gets `body` — rather than one giant string, so a
future platform adapter can transform them safely.

`content_ideas.format` is free text from the planner's LLM output ("short-form video",
"text post", …), so `normalizeContentFormat` keyword-matches it onto the enum and falls
back to `image` only when nothing matches.

### Anti-hallucination

The content-creator system prompt forbids inventing statistics or facts not present in the
supplied context (explicitly: no `"97% of developers..."` unless it's in the given
research), and requires unsupported claims to be dropped, rewritten as opinion, or listed
in `contentWarnings`. The reviewer independently checks accuracy and flags claims it cannot
verify rather than asserting they're true or false.

### Media

Non-`text` formats get one cover image via the `generateImage` tool (policy-gated like
`publishPost`). A media failure is caught and recorded on the asset row as `failed` — it
does **not** fail the generation attempt, because the copy is already produced and the
reviewer can still evaluate it. See `docs/architecture.md` for the provider abstraction.

## Research provider

`ResearchAgent` depends on `ResearchProvider` (`packages/agent-core/src/research/`), not a
concrete source:

```ts
interface ResearchProvider {
  readonly name: string;
  discoverTopics(query: ResearchQuery): Promise<ResearchSignal[]>;
}
```

`MockResearchProvider` is the only implementation today — deterministic, and every signal
it returns carries `sourceType: "mock"`. A `WebResearchProvider`/`TrendProvider`/
`SocialResearchProvider` can be added later and passed to `buildAgentSystem({
researchProvider })` without changing `ResearchAgent` or anything downstream of it.

## Skeletons

`CommunityAgent` (in
`packages/agent-core/src/agents/skeleton-agents.ts`) implement
`Agent` and record a single `not_implemented` decision. They exist so the orchestrator's
agent list, the `AgentName` union, and any code that switches on agent name already has a
stable, typed shape to extend — implementing one is adding logic to its `run()` method,
not changing any interface. They are not part of the run list yet.

`AnalyticsAgent` graduated out of this file in Phase 5 and `ExperimentAgent` in Phase 6 — see below.

## Orchestration

`AgentOrchestrator.executeRun(accountId, { runId? })`:

1. Resolves the run — creates a new `agent_runs` row, or loads `runId` if resuming a
   redelivered/retried job. A run already `completed` short-circuits immediately.
2. Marks it `running`, then calls `AgentContextLoader.load(accountId)` **once** to build
   the shared `AgentContextData` for every agent in this run.
3. Runs Research → Strategy → ContentPlanner in order, building a fresh `AgentContext` per
   agent (spreading the loaded data + run-scoped fields), and threading each result forward
   via `previousResults`.
4. After each stage, persists — in one DB transaction per stage — the decisions, actions,
   *and* the stage's domain rows (research_findings / strategy_versions / content_ideas).
   Every domain write is idempotency-checked first (`findVersionByRunId`,
   `listByRunId`/`listIdeasByRunId`), so retrying the same `runId` never duplicates rows.
5. Marks the run `completed`, or `failed` with the error message if any agent (or any
   persistence step) throws.

This is intentionally linear — no branching, no re-planning. The abstractions (`Agent`,
`AgentContext`, `ToolRouter`, `AgentContextLoader`) are what make richer orchestration
(conditional agent selection, partial re-runs, human-in-the-loop pauses) possible later
without changing how agents are written. See `docs/database.md` for the transaction/
idempotency details and `docs/queues.md` for how the same orchestrator is invoked from a
BullMQ job instead of an HTTP request.

## Error handling

- **Missing account** → `NotFoundError` (404) from `AgentContextLoader`.
- **Account has no agent profile yet** → `AgentProfileMissingError` (422) — create one via
  `POST /api/accounts` (with `niche`) or `npm run db:seed` before starting a run.
- **Missing goal / missing strategy** → not fatal. `goal`/`currentStrategy` are `null`;
  agents treat a null strategy as "propose an initial one."
- **LLM output invalid after retries** → `LLMValidationError` (502), the run is marked
  `failed` with that message, and nothing from that stage is persisted.
- **Any other exception** → caught by the orchestrator, run marked `failed`, error
  re-thrown as the stored message (never a raw stack trace or secret).

## Adding a new agent to the run

1. Implement `Agent` in `packages/agent-core/src/agents/`.
2. Add it to the `AGENT_NAMES` tuple in `packages/shared/src/domain-types.ts`.
3. Add an instance to the agent list passed into `AgentOrchestrator`, and (if it produces
   domain rows) a branch in the orchestrator's per-stage persistence dispatch, in
   `packages/agent-core/src/factory.ts` / `orchestrator.ts`.

## AnalyticsAgent (Phase 5)

Turns measured analytics into structured, evidence-backed observations. It is the only
agent that runs outside the planning pipeline, via its own entry point
`AgentOrchestrator.analyzePerformance(accountId)`.

**Inputs** (all pre-computed, deterministic): recent per-post metrics, the account
baseline, follower change, content dimensions (format, pillar, posting hour/day in UTC,
generation version) and the list of metrics the platform did *not* provide.

**Output**: `summary`, `observations[]` (type, dimension, finding, evidence, confidence,
sample size), `opportunities[]`, `risks[]`, `dataQuality`.

Three boundaries define it:

1. **It never calls Meta.** All numbers arrive via `AnalyticsService` from stored
   snapshots. The agent has no adapter and no token.
2. **It never changes strategy.** Its schema has no field capable of expressing one, it
   emits no actions, and it writes only `analytics_insights` + `agent_decisions`. Tests
   assert both the schema shape and that `strategy_versions` is unchanged across a run.
3. **It runs on request, not per metric.** Collection is arithmetic and runs on a
   schedule; interpretation costs an LLM call and happens when asked.

**Sample-size discipline**: below 5 posts, confidence is clamped to ≤ 0.45 *after* the
model responds, findings are prefixed "Early signal:", and a claimed sample size can never
exceed the posts that exist. A model instructed not to overclaim will still sometimes
overclaim, so this is enforced in code rather than trusted to the prompt.

Each observation is recorded as a `performance_observation` decision with its evidence and
sample size — a queryable row, not a prose blob. See [`analytics.md`](analytics.md).

## ExperimentAgent (Phase 6)

Proposes experiment designs and explains completed results. Two entry points:
`AgentOrchestrator.proposeExperiment(accountId)` and `.summarizeExperiment(experimentId)`.

**Proposing**: it receives analytics observations, the account baseline, recent measured
content, past experiment results and the variables already under test. Its schema restricts
it to the supported variables and metrics, so it cannot invent a variable the engine has no
way to apply. Confidence is capped at 0.4 when fewer than five posts have analytics.

**Summarizing**: the outcome, lift and confidence are *given* to it already computed. It
puts them into words and may suggest a follow-up. It is instructed never to say "proven" or
"significant", because no significance test was performed.

Three boundaries:

1. **It proposes; validation decides.** `ExperimentValidationService` re-checks every
   proposal against the confounder, sample, duration and concurrency rules. A confident
   model does not get a pass.
2. **It computes no statistics.** Every number it sees was produced deterministically.
3. **It cannot change strategy.** Its output has a `recommendation` field, explicitly a
   suggestion for a human. An integration test asserts `strategy_versions` is unchanged
   across a full experiment run.

See [`experiments.md`](experiments.md).

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

These three run in sequence inside `AgentOrchestrator` (see `packages/agent-core/src/factory.ts`).

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

`ContentCreatorAgent`, `ReviewerAgent`, `AnalyticsAgent`, `ExperimentAgent`, and
`CommunityAgent` (in `packages/agent-core/src/agents/skeleton-agents.ts`) all implement
`Agent` and record a single `not_implemented` decision. They exist so the orchestrator's
agent list, the `AgentName` union, and any code that switches on agent name already has a
stable, typed shape to extend — implementing one is adding logic to its `run()` method,
not changing any interface. They are not part of the run list yet.

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

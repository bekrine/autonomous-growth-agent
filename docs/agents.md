# Agents

## Contract

Every agent implements `Agent` from `packages/agent-core/src/types.ts`:

```ts
interface Agent {
  readonly name: AgentName;
  run(context: AgentContext): Promise<AgentResult>;
}
```

`AgentContext` gives an agent everything it's allowed to touch:

- `context.tools` — a `ToolRouter`, the only way to reach the database or a social
  platform. Calling `context.tools.call(toolName, accountId, input)` runs the tool through
  the policy layer first.
- `context.llm` — an `LLMProvider`, for generating text without depending on a specific
  vendor SDK.
- `context.previousResults` — the `AgentResult` produced by each earlier agent in the same
  run, keyed by agent name, so e.g. `StrategyAgent` can read what `ResearchAgent` found.
- `context.logger`, `context.runId`, `context.accountId`.

An agent must never import `@agent/database` or `@agent/social-platforms` directly —
only through `context.tools`.

`AgentResult` is what gets persisted:

```ts
interface AgentResult {
  decisions: AgentDecisionInput[]; // { decision, reason?, metadata? } — no chain-of-thought
  actions: AgentActionInput[];     // { actionType, status, payload?, result? }
  data?: Record<string, unknown>;  // passed forward via previousResults
}
```

Decisions are deliberately a *label + short reason*, not a transcript of the agent's
reasoning — see the "Logging and observability" section of the root brief. If you're
tempted to store a prompt or a raw LLM completion in `decision`/`reason`, put a summary
there instead and keep any large artifact (e.g. a generated caption) in `data`/`result`.

## Implemented in this phase

- **ResearchAgent** — calls `getAccount` then `searchWeb`, records one decision.
- **StrategyAgent** — reads `previousResults.research`, asks `context.llm` for a one-line
  strategy focus, records one decision. Persisting a strategy version is left to the
  `updateStrategy` tool, gated by `HumanApprovalPolicy`.
- **ContentPlannerAgent** — reads `previousResults.strategy`, calls the `createContentBrief`
  tool, records one decision.

These three run in sequence inside `AgentOrchestrator` (see `packages/agent-core/src/factory.ts`).

## Skeletons

`ContentCreatorAgent`, `ReviewerAgent`, `AnalyticsAgent`, `ExperimentAgent`, and
`CommunityAgent` (in `packages/agent-core/src/agents/skeleton-agents.ts`) all implement
`Agent` and record a single `not_implemented` decision. They exist so the orchestrator's
agent list, the `AgentName` union, and any code that switches on agent name already has a
stable, typed shape to extend — implementing one is adding logic to its `run()` method,
not changing any interface.

## Orchestration

`AgentOrchestrator.executeRun(accountId)`:

1. Creates an `agent_runs` row (`pending`), then marks it `running`.
2. Runs each configured agent in order, building a fresh `AgentContext` per agent.
3. Persists every decision (`agent_decisions`) and action (`agent_actions`) the agent
   returned, linking actions to the last decision recorded for that agent.
4. Marks the run `completed`, or `failed` with the error message if any agent throws.

This is intentionally linear — no branching, no re-planning, no retries within a run. The
abstractions (`Agent`, `AgentContext`, `ToolRouter`) are what make richer orchestration
(conditional agent selection, partial re-runs, human-in-the-loop pauses) possible later
without changing how agents are written.

## Adding a new agent to the run

1. Implement `Agent` in `packages/agent-core/src/agents/`.
2. Add it to the `AGENT_NAMES` tuple in `packages/shared/src/domain-types.ts`.
3. Add an instance to the agent list passed into `AgentOrchestrator` in
   `packages/agent-core/src/factory.ts`.

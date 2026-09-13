# Experiments

Phase 6 lets the agent propose, run and evaluate controlled experiments. It does **not**
change the account strategy — a result produces a recommendation, and acting on it is
Phase 7's job.

```
Analytics → ExperimentAgent (proposes) → ExperimentValidationService (decides)
   → Experiment → control + variant arms
   → Content Creator (Phase 3) → PublishingService (Phase 4) → Instagram
   → AnalyticsService (Phase 5)
   → ExperimentEvaluationService (deterministic) → result → recommendation
```

The engine owns the experiment lifecycle and nothing else. Content generation, publishing
and metrics are the existing Phase 3/4/5 services; Phase 6 calls them rather than
reimplementing them.

## The division of labour

| Concern | Owner |
|---|---|
| Hypothesis, candidate variable/metric | ExperimentAgent (LLM) |
| Whether the design is valid | `ExperimentValidationService` (code) |
| Which arm each post goes to | `assignSlots` / `buildBalancedQueue` (code) |
| Metric values | `AnalyticsService` (Phase 5) |
| Winner, lift, confidence | `ExperimentEvaluationService` (code) |
| Explaining the result | ExperimentAgent (LLM) |
| Changing strategy | **nobody, in Phase 6** |

The LLM never computes a statistic and never decides whether a design is sound.

## Lifecycle

```
draft ──▶ ready ──▶ running ──▶ analyzing ──▶ completed
                       │                   └─▶ inconclusive
                       ├─▶ paused
                       ├─▶ cancelled
                       └─▶ failed
```

`inconclusive` is a terminal **success** of the process: the experiment ran correctly and
the data did not support a winner. That is a real answer, not a failure.

Statuses are appended to the existing `experiment_status` enum via `ALTER TYPE ... ADD
VALUE`, so no existing row was rewritten.

## Supported variables

Defined once in `experiment-config.ts`; nothing else hard-codes the list.

| Variable | Applies to | Example |
|---|---|---|
| `format` | content brief | reel vs carousel |
| `topic` | content brief | one pillar vs another |
| `hook` | content brief | generic vs pain-point |
| `cta` | content brief | "save this" vs "follow" |
| `caption_style` | content brief | long vs short |
| `posting_time` | schedule | morning vs evening |

Adding a variable is one entry in that file.

## Validation

`ExperimentValidationService` is the authority. It returns structured errors and warnings.

**Errors** (block creation): unsupported variable or metric, missing hypothesis, no control
or no variant, duplicate arm names, two arms with the same value, invalid sample size,
non-positive observation window, duration beyond the ceiling, a variable already under
test, too many active experiments, and a **confounded design**.

**Warnings** (allowed, but recorded): sample size below the configured minimum, a raw count
chosen as the primary metric, a vague hypothesis, and a single incidental difference
between arms.

### Confounders

The substantive check. Everything except the variable under test should match across arms:

```
GOOD                          BAD
same topic                    different topic
same format                   different format
different hook  ← variable    different cta
                              different audience
```

If the arms differ in **two or more** dimensions besides the variable, the design is
rejected: a difference in the result could not be attributed to anything. One incidental
difference warns. `allowMultiFactor: true` downgrades the rejection to a warning for
someone who deliberately wants a multi-factor test.

## Assignment

Arms are interleaved across publishing slots:

```
slot 0 → control   slot 1 → variant   slot 2 → control   slot 3 → variant
```

Publishing all controls on Monday and all variants on Friday would make the day a
confounding variable. Assignment is a pure function of the slot index — reproducible, not
random — and `buildBalancedQueue` tops up whichever arm is behind rather than restarting
the cycle, so a partial failure does not leave the arms lopsided.

## Evaluation

Deterministic, no LLM. Rules fire in order and the first one that matches decides:

| # | Rule | Outcome |
|---|---|---|
| 1 | Any arm below `minSamplesPerVariant` | `insufficient_data` |
| 2 | Arms more lopsided than `maxSampleImbalanceRatio` | `inconclusive` |
| 3 | Primary metric unavailable for an arm | `insufficient_data` |
| 4 | Control median is 0 | `inconclusive` (variant moved) or `no_clear_winner` |
| 5 | Difference below `minRelativeLift` | `no_clear_winner` |
| 6 | Otherwise | `variant_winner` / `control_winner` |

**Medians, not means.** One viral post must not decide an experiment, exactly as with the
Phase 5 baseline.

**Only published posts count**, and only those that actually reported the metric.
`assigned` and `observations` are tracked separately, so "6 posts, 1 measured" is visible
rather than hidden.

### What the result never says

No significance test is performed, so the vocabulary is capped accordingly:

- A win is a **directional winner** or a **promising signal** — never "proven",
  "significant" or "conclusive". A test asserts the conclusion text contains neither
  "proven" nor "significant".
- Confidence is `low` or `medium`. **It never reaches `high`**, because a median comparison
  cannot support that claim.
- Confidence has an **absolute floor**: fewer than 5 measured posts per arm is always
  `low`, regardless of configuration. Without this, setting `minSamplesPerVariant: 1` would
  let a single post per arm report `medium` — the configuration would be grading its own
  homework.

### Zero denominators

A control median of 0 does not produce infinite lift. The result says the ratio *cannot be
computed against zero* and reports a directional signal at most. If both arms are 0, there
is nothing to distinguish them.

## Idempotency

`evaluation_key` is derived from the primary metric and each arm's observation count. The
`UNIQUE (experiment_id, evaluation_key)` constraint means re-evaluating unchanged data
returns the existing row with `created: false` — the database enforces it, not the caller.

Evaluations are **append-only**. A new post changes the key, so a genuinely new conclusion
is recorded alongside the old one; nothing is overwritten. Experiment history stays
auditable.

## Concurrency and cost

| Setting | Default | Purpose |
|---|---|---|
| `EXPERIMENT_MIN_SAMPLES_PER_VARIANT` | 5 | Posts per arm before any winner |
| `EXPERIMENT_MIN_RELATIVE_LIFT` | 0.10 | Difference considered meaningful |
| `EXPERIMENT_OBSERVATION_WINDOW_HOURS` | 24 | Time an arm is observed |
| `EXPERIMENT_MAX_DURATION_DAYS` | 14 | An experiment must not run forever |
| `MAX_ACTIVE_EXPERIMENTS_PER_ACCOUNT` | 1 | Concurrent experiments muddy attribution |
| `MAX_EXPERIMENT_CONTENT_PER_DAY` | 4 | Caps LLM, image and publishing cost |
| `EXPERIMENT_MAX_SAMPLE_IMBALANCE_RATIO` | 2 | 8 vs 1 is not a comparison |

The conservative rule is **one active experiment per account and variable**, enforced both
at creation and again at start — the account's state can change in between.

Experiment configuration is **frozen onto the row at creation**. Changing a default later
cannot retroactively turn a past `inconclusive` into a `winner`.

## Safety

Experiments publish through `PublishingService`, so every Phase 4 guarantee still applies:
the kill switch, publishing policy, rate limits and `AUTO_PUBLISH_ENABLED` are unchanged
and cannot be bypassed. If publishing is disabled, an experiment can still exist and still
analyze data it already has — only new publishing is blocked.

Cancelling an experiment cancels every arm, and `attachContent` refuses cancelled
experiments and cancelled arms. Already-published posts and past evaluations are left
untouched.

## Queue

The existing `experiments` queue, processed by `agent-worker` at concurrency 1 (two
concurrent evaluations of one experiment would race for the same idempotency key):

| Job | Effect |
|---|---|
| `check-experiment-progress` | Evaluates only once every arm has met its target |
| `evaluate-experiment` | Evaluates immediately |

`check-experiment-progress` deliberately does nothing when arms are short, rather than
recording an "insufficient data" row on every tick.

## API

| Endpoint | Purpose |
|---|---|
| `GET /api/experiments/config` | Supported variables and metrics |
| `GET /api/experiments/:accountId` | List for an account |
| `GET /api/experiments/detail/:id` | Experiment, arms, evaluations, posts |
| `GET /api/experiments/:id/variants` \| `/results` \| `/progress` \| `/schedule` | Detail views |
| `POST /api/experiments` | Create (201, or **422 with structured issues**) |
| `POST /api/experiments/:id/ready` \| `/start` \| `/pause` \| `/cancel` | Lifecycle |
| `POST /api/experiments/:id/content` | Attach a content post to an arm |
| `POST /api/experiments/:id/evaluate` | Run evaluation |
| `POST /api/experiments/propose` | ExperimentAgent designs one (creates nothing) |
| `POST /api/experiments/:id/summarize` | ExperimentAgent explains a result |

Creation returns 422 rather than a generic 400 so the caller learns *which* rule the design
broke.

## Dashboard

Active / completed / inconclusive groups, with a detail pane showing hypothesis, variable,
primary metric, arms, per-arm progress as `published / target`, the comparison chart, and
earlier evaluations.

Sample size is rendered next to every bar and never hidden: a bar twice as long drawn from
two posts means something very different from the same bar drawn from twenty.

## Limitations

- **No significance test.** Results are directional. A proper test (and the sample sizes it
  needs) is future work.
- **Median comparison only.** No variance, confidence intervals or sequential-testing
  correction.
- Defaults are development values chosen to keep a POC honest, **not statistically
  universal rules**.
- Low sample sizes produce directional signals, not conclusions — the engine says so
  rather than leaving the reader to infer it.
- Instagram only. The engine has no platform-specific logic; it uses the existing platform
  abstraction, so another platform needs no experiment changes.
- An account with no distribution cannot produce a usable result: with zero reach, rate
  metrics are undefined and evaluation correctly refuses to conclude.

## Where Phase 7 connects

Phase 6 stops at:

```
Experiment result → recommendation
```

Phase 7 owns the step after it: reading `experiment_evaluations`, deciding whether the
evidence justifies a change, and writing a new `strategy_versions` row. Everything it
needs is already persisted — the variable tested, the arms, per-arm medians, sample sizes,
the thresholds applied and why the outcome was reached.

Nothing in Phase 6 writes to `strategy_versions`, and an integration test asserts the
strategy version count is unchanged across an experiment run.

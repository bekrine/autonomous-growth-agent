# Analytics

Phase 5 makes the system **measure** what published content actually did. It does not
make the system learn: nothing here changes strategy. That is deliberate and enforced —
see "The AnalyticsAgent cannot change strategy" below.

```
Instagram
   ↓  InstagramAnalyticsProvider        (the only file that knows Meta exists)
AnalyticsService                        (collect → normalize → derive → persist)
   ↓  PostgreSQL                        (raw snapshots + normalized metrics, append-only)
Performance calculator                  (baseline, derived rates, score — deterministic)
   ↓  AnalyticsAgent                    (explains the numbers; cannot act on them)
Insights → Dashboard
```

## The layering rule

```
RAW PLATFORM DATA → NORMALIZED METRICS → DERIVED METRICS → PERFORMANCE ANALYSIS → AI INSIGHTS
```

Each layer is kept, not replaced. `analytics_snapshots.metrics` holds the sanitized
provider payload; `analytics_metrics` holds the normalized numbers computed from it. If
normalization is later found to be wrong, the raw response is still there to re-derive
from.

## Supported metrics

Meta's metric set moves. `impressions` and `video_views` were retired in favour of
`views` (April 2025), and validity differs by media product type. So the adapter
**discovers** availability instead of assuming it: each candidate metric is requested
individually, and anything the API rejects is recorded as `available: false` with the
platform's reason.

Requesting metrics one at a time costs extra calls but buys per-metric availability — a
single invalid name in a batched request fails the whole request and would lose every
other metric.

| Media product type | Candidates requested |
|---|---|
| FEED | reach, likes, comments, shares, saved, views, total_interactions, follows, profile_visits |
| REELS | reach, likes, comments, shares, saved, views, total_interactions |
| STORY | reach, views, replies, total_interactions |

Verified against the live Graph API (v21.0, FEED/IMAGE): all nine FEED candidates are
accepted. `impressions` is rejected outright —

> `(#100) Starting from version v22.0 and above, the impressions metric is no longer supported`

— which is why `views` is the canonical name and `impressions` maps onto it rather than
being requested. `engagement` is likewise not a valid media metric.

Account level: `followers_count`, `follows_count`, `media_count` (basic fields), plus
`reach`, `views`, `profile_views`, `accounts_engaged` (insights).

### Required permission

Insights need **`instagram_manage_insights`**. Without it every `/insights` call fails
with `(#10) Application does not have permission for this action`, while basic profile
fields keep working. The scope is included in `INSTAGRAM_SCOPES`, but **a connection
authorized before Phase 5 must be reconnected** — the old token simply does not carry it.

The failure is surfaced explicitly ("Permission denied — the connection is missing
instagram_manage_insights. Reconnect the account.") rather than collapsed into "no data",
because the two need completely different responses from an operator.

### Zero is not unavailable, either

The inverse case matters just as much, and the live smoke test exercised it: a brand-new
account's first post returned `reach: 0, likes: 0, …` — genuinely zero, reported by the
platform. Those are stored as `available: true, value: 0`.

Every derived rate over them is then **unavailable** ("Cannot compute: reach is 0"), not
`0%`. Zero reach is a fact; an engagement rate over zero reach is undefined.

## Unavailable is not zero

The single most important rule here. A metric the platform did not return is stored with
`available = false` and a reason — never as `0`.

Treating absence as zero would quietly corrupt everything downstream: averages, baselines,
and every derived rate. A post whose `shares` we could not read is not a post with no
shares.

The same applies to derived metrics: if a numerator component or the denominator is
missing, the rate is **unavailable**, not `0%`.

## Normalization

`packages/agent-core/src/analytics/normalization.ts` maps platform names onto canonical
ones, keeping the original in `platform_metric_name`:

| Platform | Canonical |
|---|---|
| `saved` | `saves` |
| `impressions`, `video_views`, `plays`, `views` | `views` |
| `profile_visits`, `profile_views` | `profile_views` |
| `followers_count`, `follower_count` | `followers` |

When two platform names collapse onto one canonical name, the **available** reading wins —
not the last one seen.

## Derived metrics

Deterministic arithmetic, computed in application code. No LLM is involved, so the same
inputs always give the same answer.

| Metric | Formula |
|---|---|
| `engagement_rate` | `(likes + comments + shares + saves) / reach` |
| `share_rate` | `shares / reach` |
| `save_rate` | `saves / reach` |
| `follow_conversion` | `follows / reach` |
| `views_to_follow_conversion` | `follows / views` |

Every derived metric stores its `formula` and `inputs` in `analytics_metrics.computation`,
so any number on the dashboard can be audited back to the measurements it came from.

**Zero denominators return "unavailable", not 0%.** A post with `reach = 0` has an
undefined engagement rate; reporting 0% would make it look identical to a post that
reached thousands and engaged nobody.

## Baseline and performance score

The baseline is the **median** of recent eligible posts (`ANALYTICS_BASELINE_POST_COUNT`,
default 10). Median rather than mean: one viral post would drag an average far above what
typical content achieves, making every normal post look like a failure. Each metric is
medianed independently, so a post missing `saves` does not shrink the sample for `reach`.

```
Performance score = 0.30·reach + 0.20·engagement + 0.20·shares + 0.15·saves + 0.15·follows
```

Each component is the post's value **divided by the baseline median**, so `1.0` means
"typical for this account". An absolute threshold would be meaningless across accounts of
different sizes.

Weights are configuration, not a business rule baked into code. Components whose metric or
baseline is unavailable are dropped and the remaining weights renormalized; `coverage`
reports how much of the formula was actually available, so a score from one of five
components is never presented as equivalent to a complete one.

## Collection schedule

A finite ladder of windows after publication (`ANALYTICS_COLLECTION_WINDOWS`, minutes;
default `60,360,1440,4320`):

| Window | Default |
|---|---|
| `initial` | ~1 hour |
| `early` | ~6 hours |
| `daily` | ~24 hours |
| `extended` | ~72 hours |

Once the ladder is exhausted the post stops being collected. That is what makes an API
storm structurally impossible rather than merely discouraged.

If the worker runs late — or the stack was down — the **furthest due window** is recorded,
not every earlier one. The platform reports current totals, so backfilling old windows
would store identical numbers under different labels.

`content_analytics_state` drives selection: the worker asks for posts whose
`next_snapshot_at` has arrived and does not scan published content.

## Scheduling and the event flow

```
PublishingService (publish succeeds)
        ↓  outbox_events: content.published        — same transaction as the publish
OutboxPublisher → BullMQ `analytics` queue
        ↓
analytics-worker → AnalyticsService.schedulePostCollection()
        ↓  (later, on the repeatable sweep)
AnalyticsService.collectForPost()
```

Collection is a reaction to a durable fact, never triggered by the browser. A crash
between publish and scheduling leaves the event pending rather than losing it.

The sweep is a **BullMQ repeatable job**, not `setInterval`/`setTimeout`: the cadence
survives restarts and there is one scheduler even with several worker replicas.

## Collection state

`content_analytics_state.status`:

| Status | Meaning |
|---|---|
| `pending` | Scheduled, nothing collected yet |
| `collecting` | A collection is in flight |
| `up_to_date` | Latest window collected, all metrics available |
| `partial` | Collected, but some metrics were unavailable |
| `failed` | Collection failed; see `last_error` |

`partial` is never rounded up to success. The dashboard uses this to distinguish
"0 shares" from "shares data not yet available".

## Idempotency

Enforced by the **database**, not by application bookkeeping:

```sql
UNIQUE NULLS NOT DISTINCT (social_account_id, content_post_id, metric_type, collection_window)
```

`NULLS NOT DISTINCT` is essential rather than decorative. Account-level snapshots have a
`NULL content_post_id`, and Postgres's default treats every NULL as distinct — without it
the same account/day could insert repeatedly and silently corrupt follower history. (This
was caught by a test, not by reading the schema.)

Re-collecting a window returns the existing snapshot with `created: false`.

## Retries and failure recovery

Bounded, and split by whether another attempt could plausibly help:

| Retryable | Not retryable |
|---|---|
| rate limiting, transient platform error, network timeout | invalid token, permission denied, unsupported media, invalid external id, account disconnected |

A non-retryable failure clears `next_snapshot_at`, so the worker stops selecting that post
entirely — this is what prevents endless retries against a disconnected account. Retryable
failures are rescheduled, bounded by `ANALYTICS_MAX_COLLECTION_ATTEMPTS`.

## Rate limiting and cost

- Worker concurrency defaults to **1** (`ANALYTICS_CONCURRENCY`).
- Only posts genuinely due are collected.
- The collection ladder is finite.
- **No LLM call happens during collection.** All metric work is arithmetic. The
  AnalyticsAgent runs only when an interpretation is requested, so LLM cost is
  proportional to analysis, not to data volume.

## Content identity

Analytics attach to the exact published version, not to a topic or title:

```
content_post → content_generation (version) → publishing_job → external_post_id → snapshot
```

`analytics_snapshots.content_generation_id` records which generated version was measured.
This is what will let a later phase answer "which exact generated content performed well?"
rather than merely "which idea did".

Dimensions available for grouping: format, content pillar, topic/title, hook, objective,
posting hour (UTC), posting day (UTC), generation version, and — reserved for Phase 6 —
`experiment_id` / `experiment_variant_id` on `content_posts`.

## Time handling

All timestamps are stored in UTC. Posting hour and posting day are computed in UTC, and
the dashboard converts only at render time. A "best posting hour" that silently mixed
timezones would be meaningless.

Account snapshots are keyed by UTC day, so a second collection on the same day is a no-op
rather than a second row.

## The AnalyticsAgent cannot change strategy

Three independent barriers, not just an instruction in the prompt:

1. **Schema.** `AnalyticsInsightSchema` has no field capable of expressing a strategy
   change — only `summary`, `observations`, `opportunities`, `risks`, `dataQuality`. A
   test asserts the exact key set.
2. **No actions.** The agent returns an empty `actions` array. Actions are how agents
   cause effects in this codebase; analytics has none.
3. **Separate entry point.** `analyzePerformance()` writes `analytics_insights` and
   `agent_decisions`. It never touches `strategy_versions`, and an integration test
   asserts the strategy version count is unchanged across a run.

`opportunities` are suggestions for a human to consider ("test more short-form video"),
not instructions the system will act on.

### Sample-size discipline

Below `MIN_SAMPLE_FOR_CLAIMS` (5 posts) the agent may only report early signals:
confidence is **clamped to ≤ 0.45 after the model answers** (a model told not to overclaim
will still sometimes overclaim), findings are prefixed "Early signal:", and a reported
sample size can never exceed the number of posts that actually exist.

One post outperforming the median is an early signal, not evidence that a format works.

## Insight types

`format`, `topic`, `content_pillar`, `hook`, `cta`, `posting_time`, `audience_response`,
`growth`, `anomaly`. Each insight stores evidence, confidence, sample size and time range;
each observation is also written to `agent_decisions` as a `performance_observation` so it
is queryable in the existing audit trail.

## Account growth

Daily account snapshots build follower history. Growth is computed from the **difference
between observed snapshots** — never inferred from a single current follower count, and
never interpolated across gaps. With fewer than two snapshots, change is reported as
unavailable rather than as 0.

## API

| Endpoint | Returns |
|---|---|
| `GET /api/analytics/accounts/:accountId/overview` | Followers, content counts, baseline, top posts, insights |
| `GET /api/analytics/accounts/:accountId/posts?sortBy=&limit=` | Per-post metrics + dimensions, sortable |
| `GET /api/analytics/accounts/:accountId/growth` | Follower series + day-over-day deltas |
| `GET /api/analytics/accounts/:accountId/insights` | Stored agent observations |
| `GET /api/analytics/posts/:contentId` | One post: status, metrics, snapshot history |
| `POST /api/analytics/posts/:contentId/collect` | Manual collection (same service the worker uses) |
| `POST /api/analytics/accounts/:accountId/collect` | Manual account snapshot |
| `POST /api/analytics/accounts/:accountId/analyze` | Run the AnalyticsAgent |
| `GET /api/analytics/:accountId` | Phase 1 route, retained |

Raw provider payloads are **not** exposed through the API. They are stored sanitized for
debugging, but the public contract is the normalized metrics.

## Security

Provider responses are sanitized before persistence: any key matching
`access_token|client_secret|app_secret|code|token` is redacted. Analytics rows are
long-lived and widely read, so a credential must never reach them.

## Configuration

```env
ANALYTICS_ENABLED=true
ANALYTICS_COLLECTION_WINDOWS=60,360,1440,4320   # minutes after publication
ANALYTICS_BASELINE_POST_COUNT=10
ANALYTICS_MAX_COLLECTION_ATTEMPTS=3
ANALYTICS_SWEEP_INTERVAL_MINUTES=15
ANALYTICS_CONCURRENCY=1
```

## Testing

Unit tests mock the Graph client and never reach Meta. Integration tests use a scripted
`PlatformAnalyticsProvider` against a real Postgres.

```bash
npm test
```

## What Phase 5 is, and is not

At the end of Phase 5 the system has **MEASURED**, not **LEARNED**:

| Phase | Capability |
|---|---|
| 5 | Measure + understand |
| 6 | Experiment |
| 7 | Learn + adapt |

A generated summary is not learning. Nothing in this phase closes the loop back into
strategy — that is Phase 7's job, and it will build on the raw history preserved here.

# Workers-native backend — Load & limits check (Cloudflare FREE plan)

**Date:** 2026-05-31
**Scope:** `deploy/cloudflare-workers/` — Workers-native TS port of the Bowtie AI
Content Tool backend (Phase 8 parity work).
**Workload profile:** internal marketing/editorial tool, a handful of editors,
low concurrency (≈1–3 concurrent runs in practice), no PII/PHI.

> **Limit numbers marked "verify"** should be re-confirmed against the current
> Cloudflare docs before cutover; the platform free-plan ceilings move over time.
> All *code* numbers below are read directly from the committed source.

---

## 0. Where the numbers come from (code anchors)

| Constant | Value | Source |
|---|---|---|
| `MAX_ITERATIONS` (internal audit loop) | `2` | `src/workflows/production.ts:59` |
| `MAX_HITL2_ROUNDS` (reviewer revision rounds) | `3` | `src/workflows/production.ts:61` |
| `CONCURRENCY_CAP` (analyse_candidate fan-out) | `5` | `src/workflows/topic_expansion.ts:32` |
| `MAX_IN_FLIGHT` (citation URL resolution) | `8` | `src/agents/citations.ts:8` |
| `link_check_concurrency` | `8` | `src/config/refresh.ts:76` |
| `scan.batch_size` | `200` | `src/config/refresh.ts:60` |
| `scan.llm_cap_per_tick` | `20` | `src/config/refresh.ts:63` |
| `link_check_timeout_ms` | `3000` | `src/config/refresh.ts:75` |
| Hyperdrive postgres.js | `{ max: 5, fetch_types: false }` | `src/db/client.ts` |
| Gemini egress | 1 DO RPC → 1 `RealGeminiClient.generate()` | `src/gemini/proxy_do.ts`, `do_client.ts` |

---

## 1. Workflows — step inventory

Three production workflows are wired in `wrangler.jsonc` (plus two TEST-ONLY PoC
workflows, `gemini-poc` / `hitl-spike`, which are out of scope and must be
removed before cutover).

### 1.1 ProductionWorkflow (`src/workflows/production.ts`)

The single long-lived run pipeline. Structure (refresh path; the `create` path
skips `fetch-article` + `gap-analysis`):

| step name | kind | line |
|---|---|---|
| `load-run` | `step.do` | 237 |
| `outline` (strategy) | `step.do` | 269 / 410 |
| `await-hitl1` | `step.waitForEvent` | 292 |
| `apply-hitl1` | `step.do` | 296 |
| `fetch-article` | `step.do` | 379 |
| `gap-analysis` | `step.do` | 389 |
| `writer-{round}-{iteration}` | `step.do` | 481 |
| `resolve_citations-{round}-{iteration}` | `step.do` | 508 |
| `render-{round}-{iteration}` | `step.do` | 529 |
| `audit-{round}-{iteration}` | `step.do` | 558 |
| `await-hitl2-{iteration}` | `step.waitForEvent` | 317 |
| `compliance` | `step.do` | 326 |
| `detect-seo` | `step.do` | 650 |
| `publish` | `step.do` | 654 |
| `on-error-persist` | `step.do` | 211 |

**Counts (code):** `step.do` appears at 15 call sites; `step.waitForEvent` at 2
sites; `step.sleep` / `step.sleepUntil`: **0**.

**Worst-case dynamic step count.** The production loop
(`writer → resolve_citations → render → audit`) runs up to `MAX_ITERATIONS = 2`
internal passes, and the whole strategy→production cycle repeats up to
`MAX_HITL2_ROUNDS = 3` reviewer rounds. The bounded worst case:

```
load-run                                1
strategy outline + (fetch + gap)        3   (refresh path)
await-hitl1 + apply-hitl1               2
production loop: 4 steps × 2 iters × 3 rounds = 24
await-hitl2 (1 per round)               3
compliance + detect-seo + publish       3
------------------------------------------------
worst-case total                       ≈ 36 durable steps
```

So a pathological run tops out around **~36 steps**. Typical happy-path runs
(1 audit iteration, 1 HITL_2 round) are **~12 steps**.

**CF Workflows limits (verify):**

- Max steps per instance: **1,024** (verify). Worst case ~36 → **>96% headroom.**
- Step return value (state) size: **1 MiB** per step (verify). Each `step.do`
  here returns a small scalar or a short row (`RunLoadRow`, `draftId`, boolean,
  `chosenRoute`). The largest is `load-run`/draft rows — well under 1 MiB. The
  full draft markdown is **persisted to Postgres**, not returned through the step
  boundary, so step outputs stay tiny. **OK.**
- Concurrent instances (free): low ceiling (verify — historically ~25–100 on
  free). At a few concurrent editor runs we are far inside it. **OK.**
- Instance retention: completed instances retained for a bounded window (verify,
  ~3 days free). HITL gates can pause a run for hours/days at `await-hitl2`;
  confirm the *pause* duration is bounded by the **instance running lifetime**,
  not the completed-retention window. A run abandoned at a HITL gate longer than
  the max instance lifetime would be reaped — acceptable for this tool, but note
  it. **Low risk.**

**Verdict: ProductionWorkflow stays comfortably within limits.**

### 1.2 TopicExpansionWorkflow (`src/workflows/topic_expansion.ts`)

Front II. No HITL interrupt. Structure:

| step name | kind | line |
|---|---|---|
| `load-batch` | `step.do` | 97 |
| `topic-gen` | `step.do` | 121 |
| `fan-out` | `step.do` | 141 |
| `analyse-{cid}` | `step.do` (fan-out, chunked) | 170 |
| `aggregate` | `step.do` | 177 |
| `on-error-persist` | `step.do` | 79 |

**Counts (code):** `step.do` at 6 sites; no `waitForEvent`; no `sleep`.

**Worst-case dynamic step count.** `analyse-{cid}` is **one durable step per
generated topic candidate**. With `topic_count = N`, the workflow runs
`4 + N` steps (load + gen + fan-out + aggregate + N analyse steps). The chunking
loop (`CONCURRENCY_CAP = 5`) only bounds *how many run in parallel*, not the
*total*. For a typical batch (N = 8–15) that's ~12–19 steps. Even an aggressive
batch of N = 50 topics is ~54 steps — still far under the 1,024-step ceiling
(verify). **OK,** with the caveat in §6: total steps scale linearly with
`topic_count`.

**Longest chain:** load-batch → topic-gen → fan-out → analyse-{cid} → aggregate
= 5 sequential stages (the analyse stage is wide, not deep).

**Verdict: within limits; watch `topic_count` if it ever goes very large.**

### 1.3 RefreshScanWorkflow (`src/workflows/refresh_scan.ts`)

CMS Stage 0 nightly scan. Structure:

| step name | kind | line |
|---|---|---|
| `scan-tick` | `step.do` | (single step) |

**Counts (code):** exactly **1** `step.do`, no `waitForEvent`, no `sleep`.

The whole scan (select due articles → per-article WP fetch + deterministic audit
+ budgeted LLM audit → insert evaluation → advance schedule) runs **inside one
durable step** via `scanTick`. This is the workflow with the highest *per-step*
subrequest pressure — analysed in §2.3.

**Verdict: trivially within the step-count limit (1 step); the risk is
*subrequest count inside that single step*, not the step count.**

---

## 2. Subrequest budget (free plan: 50 subrequests / invocation — verify)

Each Workflow **step** gets its own subrequest budget (the step is the unit of
execution/retry). What counts as a subrequest here:

- **Gemini call** via `GEMINI_PROXY` DO: `DoGeminiClient.generate()` does a DO
  RPC (`stub.generate(...)`), and the DO runs **one** `RealGeminiClient.generate()`
  → **one** outbound `fetch` to Google. Net: **~1 subrequest per generate** (the
  DO RPC itself is a binding call, but the externally-billed subrequest is the
  single Google fetch). One generate per agent node.
- **WordPress REST call** (`src/wordpress/client.ts`): each `fetch` to
  `…/wp-json/…` = 1 subrequest. Distinct calls: `fetchPostByUrl`, post lookup,
  options/meta lookups, SEO-plugin detect, and the publish PUT/POST.
- **DB query** via Hyperdrive: the **first** query opens a pooled connection
  (Hyperdrive proxies it; the connection is reused/pooled, so steady-state
  queries do **not** each cost a fresh upstream TLS handshake). Treat the
  connection open as the subrequest cost; subsequent queries on the same pooled
  connection are effectively free against the per-invocation ceiling. `getSql`
  uses `{ max: 5 }` so at most 5 backends per step. **Low pressure.**
- **Citation/link fetches:** outbound `fetch` per URL (HEAD, with a GET retry on
  ≥400) — the real fan-out risk (see §2.1, §2.3).

### 2.1 ProductionWorkflow — per-step subrequest profile

| step | Gemini | WP | DB | URL fetches | worst-case subreqs |
|---|---|---|---|---|---|
| `outline` / `gap-analysis` / `writer` / `audit` | 1 | 0 | few | 0 | ~2 |
| `resolve_citations-*` | 0 | 0 | 1 conn + N inserts | **1 HEAD (+1 GET retry) per chunk, capped 8 in-flight** | see below |
| `detect-seo` | 0 | 1–2 | 0 | 0 | ~2 |
| `publish` | 0 | 1–2 | 1 | 0 | ~3 |

**`resolve_citations` is the one production step that can fan out.** It resolves
every grounding chunk; `resolveChunk → resolveUrl(sql, vertexUri)` is
**cache-aware** (checks `url_resolution_cache` first; only a cache miss does the
HEAD/GET to follow the Vertex redirect). `MAX_IN_FLIGHT = 8` bounds *concurrency*,
not the *total*. So the subrequest count ≈ number of **cache-miss** chunks × (1
HEAD, +1 GET on ≥400). A Gemini grounding response typically yields a handful to
~10–20 chunks; with cache warming, real misses are far fewer.

- Typical: 5–15 chunks, most cache hits → **<10 subrequests.** Safe.
- Cold cache, ~20 chunks, several needing the GET retry → could approach
  **~30–40 subrequests** in one step. **This is the closest production step gets
  to the 50 ceiling.** Still under, but the least headroom in the pipeline.

### 2.2 TopicExpansionWorkflow — per-step subrequest profile

Each `analyse-{cid}` step runs `topic_dedup` + `topic_hot` (`Promise.all` of two
Gemini calls) over the DB → **~2 Gemini subrequests + 1 DB conn per step**, i.e.
~3 subrequests per step. Because each candidate is **its own step**, the fan-out
does **not** accumulate into a single step's budget. **No subrequest risk.**

### 2.3 RefreshScanWorkflow — the budget hot-spot

The entire scan runs in **one** `step.do`. Per article (`scanArticle`):

- 1 WP fetch (`fetchPostByUrl`)
- deterministic audit → **broken-link check fetches every external `href`** in
  the article HTML, `link_check_concurrency = 8` (concurrency only), 1 HEAD
  (+1 GET retry on ≥400) per link
- 0 or 1 Gemini call (LLM audit, only when deterministic fails *and* under
  `llm_cap_per_tick = 20`)
- a few DB writes (shared pooled connection)

With `batch_size = 200` articles **in a single step**, the link-check fetches
alone can be **hundreds to thousands of subrequests** in one invocation —
**far past the 50/invocation ceiling.**

> **This is the single most important finding.** A nightly scan over a
> non-trivial inventory, all inside one durable step, will exceed the free-plan
> subrequest budget. The deterministic link-check is the dominant contributor
> (every external link in every scanned article), with WP fetches second.
> See §6 recommendations (chunk per-article into separate steps, and/or cap
> links-checked-per-article and articles-per-step).

---

## 3. Concurrency caps in code

| Cap | Value | Bounds | Protects subrequest budget? |
|---|---|---|---|
| `CONCURRENCY_CAP` (`topic_expansion.ts:32`) | 5 | parallel `analyse-{cid}` **steps** in a chunk | Indirectly — limits parallel Gemini load on `GEMINI_PROXY`; each analyse is its own step so per-step budget is unaffected. |
| `MAX_IN_FLIGHT` (`citations.ts:8`) | 8 | in-flight URL HEAD resolutions within `resolve_citations` | **Yes** — caps simultaneous outbound URL fetches; combined with cache it keeps the step well under 50. |
| `link_check_concurrency` (`refresh.ts:76`) | 8 | in-flight link checks within the deterministic audit | Bounds *parallelism* only, **not total** — the total is `links × articles` and is **not** protected because the whole scan is one step (see §2.3). |
| `Promise.all` (dedup+hot) (`topic_expansion.ts:222`) | 2 | the two Gemini calls per candidate | Fine — 2 calls. |
| `Promise.all` (`db/articles.ts:288,364`) | n/a | read-path aggregation in API routes (not a workflow step) | Read-only DB fan-out on a request handler; low volume. |

**Key nuance:** `link_check_concurrency` and `MAX_IN_FLIGHT` are *rate*
(semaphore-style) caps, not *total-work* caps. They protect a step's budget only
when the total work per step is itself bounded. That holds for citations
(per-draft, small) but **not** for refresh scan (per-tick, 200 articles).

---

## 4. Durable Objects

### 4.1 `RUN_STREAM` (`src/run-stream.ts`) — SSE hub

- One DO instance per run (`idFromName(runId)`), single-threaded. The Workflow
  POSTs events to `/append`; the browser holds an SSE `GET /events`.
- Persists a capped replay buffer (`EVENT_BUFFER_SIZE = 500`); `*.thinking`
  events are broadcast live but **not** persisted (prevents buffer eviction of
  milestones). 15 s heartbeat keeps idle SSE alive across HITL pauses.
- **Load implication:** writes (`/append`) are serialized per run on one DO. At a
  few concurrent editors, each on a *different* run → different DO instance, so
  there is **no cross-run contention**. Within a single run the event rate
  (milestone events + thinking chunks) is well within a single DO's throughput.
  **OK.**

### 4.2 `GEMINI_PROXY` (`src/gemini/proxy_do.ts`) — US-pinned egress shim

- One logical instance: `idFromName(\`gemini-proxy-${locationHint}\`)` with
  `locationHint: "enam"`. Every Gemini call in the system funnels through this
  **single US-pinned DO** to bypass the Asia/HK geo-block on Google AI Studio.
- The DO holds no state; it just runs `RealGeminiClient.generate()` from a US
  colo. Because a DO is **single-threaded**, concurrent `generate()` RPCs are
  effectively **serialized** through this one instance.
- **Is it a bottleneck?** Gemini latency dominates (seconds per generate). With
  a single instance, two simultaneous generates queue behind each other. At the
  stated load (a few concurrent runs, and each run is itself mostly sequential
  through `step.do`), the realistic concurrent-generate count is low (≈1–5).
  Queuing adds latency but does not break anything. **Fine at expected load.**
- **If load grows:** the funnel becomes a throughput cap. Mitigation is to shard
  by `idFromName(\`gemini-proxy-${locationHint}-${shard}\`)` across a few US-pinned
  instances. Not needed now (noted in §6).
- **Cleanup:** the TEST-ONLY `GEMINI_PROBE` DO (migrations `v2`) must be removed
  before cutover.

---

## 5. Cron — nightly refresh scan

- Trigger: `"0 2 * * *"` (daily 02:00 UTC) in `wrangler.jsonc`.
- The `scheduled()` handler in `src/index.ts` does **not** run the scan inline —
  it `ctx.waitUntil(env.REFRESH_SCAN.create({ params: { triggerSource: "cron" } }))`,
  i.e. it **kicks the RefreshScanWorkflow and returns immediately.** Confirmed.
- **Cron handler limits (verify):** the `scheduled()` invocation itself does
  almost nothing (one Workflow `create` binding call), so the cron handler's
  CPU/duration limit is a non-issue — the heavy lifting is delegated to the
  Workflow, which owns durability/retries.
- **Free-plan cron count:** free allows a small number of cron triggers
  (verify; historically up to ~3–5). One trigger here. **OK.**
- **The real constraint is inside the Workflow's single `scan-tick` step**, not
  the cron — see §2.3. A nightly scan over the article inventory does **not**
  fit cleanly in one step's subrequest budget once the inventory grows.

---

## 6. Verdict

| Dimension | Free-plan limit (verify) | Our worst case (code) | Headroom | Risk |
|---|---|---|---|---|
| Workflow steps / instance | ~1,024 | ProductionWorkflow ~36; TopicExpansion `4 + topic_count`; RefreshScan 1 | Very high | **Low** |
| Step output (state) size | ~1 MiB / step | small scalars/rows (drafts persisted to DB, not returned) | Very high | **Low** |
| Subreqs / invocation (production steps) | 50 | `resolve_citations` cold-cache ~30–40 | Slim but positive | **Medium** |
| **Subreqs / invocation (refresh scan-tick)** | **50** | **`batch_size=200` × links/article = hundreds–thousands in ONE step** | **Negative** | **HIGH** |
| Concurrent Workflow instances | low (free) | ≈1–3 runs | High | **Low** |
| Cron triggers | ~3–5 | 1 | High | **Low** |
| Cron handler CPU/duration | short | near-zero (delegates to Workflow) | High | **Low** |
| `GEMINI_PROXY` single-DO throughput | DO single-threaded | ≈1–5 serialized generates | Adequate | **Low** (Medium if load grows) |
| `RUN_STREAM` per-run DO | DO single-threaded | 1 DO/run, capped 500-event buffer | High | **Low** |
| Hyperdrive connections | pooled, `max:5`/step | ≤5 backends/step | High | **Low** |

### Recommendations

1. **(HIGH) Chunk the refresh scan so it is not one giant step.** Move the
   per-article scan into its **own** `step.do(\`scan-article-${id}\`)` (mirroring
   TopicExpansion's per-candidate step pattern), so each article's WP fetch +
   link checks live in a *separate* subrequest budget. This is the one change
   that turns RefreshScan from "exceeds the free-plan budget on a real inventory"
   into "safe and durably-retryable per article."
2. **(HIGH) Add per-article and per-tick link-check caps.** Even per-article,
   bound links-checked-per-article (e.g. cap at ~20 external links/article) and
   keep `batch_size` realistic for the actual inventory. Document the rule:
   *if inventory grows beyond ~N articles, scans must be chunked across steps (or
   across multiple cron ticks).*
3. **(MEDIUM) Keep an eye on `resolve_citations` cold-cache fan-out.** It is the
   closest production step to the 50-subrequest line. Keep `MAX_IN_FLIGHT = 8`,
   keep the `url_resolution_cache` warm/long-TTL, and consider capping the number
   of grounding chunks resolved per draft if Gemini ever returns very large
   grounding sets.
4. **(LOW) Keep `CONCURRENCY_CAP = 5` and `MAX_IN_FLIGHT = 8` as-is.** They match
   the Python semaphores and keep parallel Gemini/URL pressure modest; raising
   them only adds load on the single `GEMINI_PROXY` DO for no real throughput win
   at this scale.
5. **(LOW) Remove TEST-ONLY artifacts before cutover.** Drop the `gemini-poc` /
   `hitl-spike` PoC workflows and the `GEMINI_PROBE` DO (migrations `v2`) from
   `wrangler.jsonc`; they are explicitly marked TEST-ONLY and add no production
   value.
6. **(LOW) Plan a `GEMINI_PROXY` shard lever for later.** If concurrent runs ever
   climb, shard the US-pinned DO by name suffix; not needed at current load.

### Bottom line

Step counts, step-output size, DO usage, cron, and Hyperdrive are all
comfortably within the free plan for this low-concurrency, no-PII tool. **The one
genuine free-plan violation is the refresh scan packing up to 200 articles' worth
of WP + link-check fetches into a single Workflow step**, which blows the
50-subrequest-per-invocation ceiling on any real inventory. Splitting the scan
into per-article steps (Recommendation 1) resolves it and is the only must-fix
before relying on the nightly cron in production.

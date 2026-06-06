# Spec: Langfuse Observability + Eval Hub

**Date:** 2026-06-06
**Status:** Draft
**Author:** Franco Ma

---

## 1. Problem

The pipeline has structured logs (structlog), OTel spans (OTLP), and a
`content_tool.evals` table — but no visual debugger that ties a single run's
LLM calls together or lets you compare eval scores across experiments in one
place.

LangSmith would fill this role, but it is a US-hosted third-party SaaS. All
article content is public marketing copy (no PII/PHI), yet the org security
posture prefers data-residency control and avoids vendor lock-in for eval
storage. LangSmith also bundles prompt management, which conflicts with
Guardrail 1 below.

**Self-hosted Langfuse** (Docker / Kubernetes, same Supabase PostgreSQL or a
sidecar Postgres) provides:

- Per-trace generation waterfall with latency, token counts, cost, and raw
  prompt/response text.
- Score series over time per metric (brand_voice, hk_localisation, coverage,
  citation_alignment, citation_policy_compliance, refine_loop_convergence).
- Dataset + experiment view: fixtures from `evals/fixtures/gold_labels/route.csv`
  become Langfuse Dataset Items; each nightly run becomes an Experiment keyed
  by `commit_sha`.
- No LangSmith account required; data stays in the operator's own
  infrastructure.

---

## 2. Hard Guardrails — Non-Negotiable

> These must be preserved verbatim in every implementation file's module
> docstring and in the test suite.

**G1 — No Prompt Management.**
Langfuse must never store, serve, or version prompts. The table
`content_tool.prompt_templates` is the sole source of truth. Prompts flow
ONE-WAY: assembled text is recorded as the `input` field of a Langfuse
Generation (read-only audit trail). They never feed back into the app.
The `langfuse.get_prompt()` / `langfuse.create_prompt()` APIs must never be
called.

**G2 — Sha parity untouched.**
`content_tool/prompts_store.py` and the sha256 computation it uses to
fingerprint assembled prompts are read-only to this feature. The
`{{include:...}}` resolution logic is not modified. The sha value is passed to
Langfuse as a tag for correlation, never as a lookup key.

**G3 — LANGFUSE_ENABLED=false is a strict no-op.**
When the flag is absent or false, no `langfuse` package symbol is imported at
module level, no network connection is attempted, and the behavior of every
existing code path is byte-identical to the pre-feature baseline. Guards must
be checked at construction time (factory), not scattered across call sites.

**G4 — No DB migration.**
Scores live in Langfuse. `content_tool.evals` is unchanged.

---

## 3. Conceptual Mapping

| This codebase                              | Langfuse concept        | Notes                                                                 |
|--------------------------------------------|-------------------------|-----------------------------------------------------------------------|
| `run_id` (UUID)                            | Trace + Session ID      | One Trace per run; `session_id = str(run_id)` groups multi-step runs |
| `gemini.generate(agent=…)` call            | Generation              | Nested inside the Trace for its run                                   |
| `agent` string (e.g. `"writer"`)           | Generation `name`       | Human-readable span label                                             |
| `system_prompt` + `user_prompt`            | Generation `input`      | Recorded as `{"system": …, "user": …}` dict                          |
| `GeminiResult.raw_text`                    | Generation `output`     | Raw text string                                                       |
| `GeminiResult.tokens_in/out`               | `usage.input/output`    | Maps to Langfuse UsageBody                                            |
| `GeminiResult.thinking_tokens`             | `usage.total` addend    | Added to output tokens; stored in `metadata`                         |
| `GeminiResult.latency_ms`                  | Manually set end time   | `start_time + timedelta(ms=latency_ms)`                               |
| `(voice_slug, template_id, sha256)`        | Generation `tags`       | `["voice:<slug>", "tpl:<template_id>", "sha:<sha256[:12]>"]`         |
| `content_tool.evals` row (post-judge run)  | Score on Trace          | `langfuse.score(trace_id=run_id, name=metric, value=score)`           |
| `evals/fixtures/gold_labels/route.csv`     | Dataset + Dataset Items | Loaded once per nightly run; items keyed by `fixture_id`              |
| `commit_sha` (`runner.current_commit_sha`) | Experiment metadata     | `metadata={"commit_sha": sha}` on each Dataset Run item               |
| `GeminiResult.finish_reason`               | Generation `metadata`   | `metadata={"finish_reason": …}`                                       |
| `GeminiResult.grounding_chunks`            | Generation `metadata`   | `metadata={"grounding_chunks": […]}`                                  |

---

## 4. Architecture

### 4.1 Feature flag

```
LANGFUSE_ENABLED=true   # default: false (unset = off)
LANGFUSE_HOST=https://langfuse.internal
LANGFUSE_PUBLIC_KEY=pk-lf-…
LANGFUSE_SECRET_KEY=sk-lf-…
```

All four env vars checked at factory time. Missing vars when `LANGFUSE_ENABLED=true`
raise a clear startup error rather than silently disabling.

### 4.2 New module: `content_tool/observability/langfuse_client.py`

Thin wrapper around `langfuse.Langfuse`. Owns:

- `LangfuseClient` protocol (mirrors `GeminiClient` protocol pattern).
- `RealLangfuseClient` — wraps the SDK, exposes:
  - `start_trace(run_id, name, metadata) -> TraceHandle`
  - `record_generation(trace_handle, agent, input, output, usage, metadata, tags, latency_ms)`
  - `record_score(trace_id, name, value, comment)`
  - `flush()` (called at app shutdown)
- `NoopLangfuseClient` — all methods are pure no-ops, zero imports from `langfuse`.
- `make_langfuse_client() -> LangfuseClient` factory — reads env vars, returns
  `RealLangfuseClient` or `NoopLangfuseClient`.

### 4.3 `set_prompt_meta` ContextVar

New module `content_tool/observability/prompt_meta.py`:

```python
@dataclass(frozen=True)
class PromptMeta:
    voice_slug: str
    template_id: str
    sha256: str

_prompt_meta: ContextVar[PromptMeta | None] = ContextVar("langfuse_prompt_meta", default=None)

def set_prompt_meta(meta: PromptMeta | None) -> None: ...
def get_prompt_meta() -> PromptMeta | None: ...
```

Callers that know the prompt context (agents that call `prompts_store` before
calling `gemini.generate`) set this var. `ObservedGeminiClient` reads it and
attaches the tags. Judges set it via `run_judge` shim.

### 4.4 `ObservedGeminiClient` decorator

`content_tool/gemini/observed.py` — wraps any `GeminiClient`:

```python
class ObservedGeminiClient:
    def __init__(self, inner: GeminiClient, langfuse: LangfuseClient) -> None: ...

    async def generate(self, *, agent, system_prompt, user_prompt,
                       response_schema, tools) -> GeminiResult:
        # reads get_active_trace_id() and get_prompt_meta() from contextvars
        # delegates to inner.generate(...)
        # records generation to langfuse (fire-and-forget, never raises)
        # returns result unchanged
```

Pattern mirrors `RunEventLogWriter`: errors are swallowed, result is never
mutated, latency measured from wall-clock difference (or `GeminiResult.latency_ms`).

### 4.5 `set_active_trace_id` ContextVar

`content_tool/observability/trace_context.py`:

```python
_trace_id: ContextVar[str | None] = ContextVar("langfuse_trace_id", default=None)

def set_active_trace_id(run_id: str | None) -> None: ...
def get_active_trace_id() -> str | None: ...
```

### 4.6 Run-trace lifecycle in `RunExecutor`

In `content_tool/api/sse.py`, before the LangGraph `.astream()` loop starts:

```python
self._langfuse.start_trace(run_id=str(run_id), name="run", metadata={…})
set_active_trace_id(str(run_id))
```

After the loop completes (success or error), the trace is updated with final
status metadata. The `ObservedGeminiClient` picks up the trace ID automatically
via the contextvar.

### 4.7 Eval score forwarding in `evals/runner.py`

After `record_eval(...)`, call:

```python
langfuse.record_score(
    trace_id=str(run_id),
    name=metric,
    value=score,
    comment=json.dumps(judge_notes),
)
```

The `langfuse` instance is passed into `main()` from a factory call at startup.

### 4.8 Dataset + Experiment sync in `evals/runner.py`

On each nightly run:

1. Read `evals/fixtures/gold_labels/route.csv` → upsert as Langfuse Dataset
   (name `"gold_labels"`) with one item per row (`fixture_id` as external ID).
2. Create a Langfuse Dataset Run keyed by `commit_sha`.
3. For each fixture that was exercised, link the run item to the Dataset Run.

This is entirely additive — existing `record_eval` DB writes are unchanged.

### 4.9 Factory wiring

`content_tool/api/main.py` `init_runtime()`:

```python
langfuse = make_langfuse_client()
gemini = ObservedGeminiClient(
    inner=RealGeminiClient(…),
    langfuse=langfuse,
)
app.state.langfuse = langfuse   # for flush at shutdown
```

`evals/runner.py` `main()`:
```python
langfuse = make_langfuse_client()
gemini = ObservedGeminiClient(inner=RealGeminiClient(…), langfuse=langfuse)
```

`content_tool/cli.py` and `evals/run_judges_adhoc.py` follow the same pattern.

---

## 5. Phases

### P1 — Core instrumentation (Python backend only)

**Goal:** every `gemini.generate` call in a live run produces a Langfuse
Generation nested in a Trace; LANGFUSE_ENABLED=false is verified no-op.

Deliverables:
- `content_tool/observability/langfuse_client.py` (protocol + real + noop + factory)
- `content_tool/observability/prompt_meta.py` (PromptMeta contextvar)
- `content_tool/observability/trace_context.py` (trace_id contextvar)
- `content_tool/gemini/observed.py` (ObservedGeminiClient)
- `content_tool/api/main.py` — factory wired, trace start/end in SSE loop
- `content_tool/api/sse.py` — `set_active_trace_id` calls around graph execution
- `pyproject.toml` — `langfuse>=3,<4` in optional `[observability]` extra
- Tests: `tests/unit/test_observed_gemini_client.py` (fake langfuse, noop path,
  real path with mock, error-swallow guarantees)

### P2 — Prompt-meta tagging

**Goal:** every Generation carries `["voice:<slug>", "tpl:<id>", "sha:<sha[:12]>"]` tags.

Deliverables:
- `content_tool/observability/prompt_meta.py` — `set_prompt_meta` calls added
  to each agent node that calls `prompts_store.get_assembled_*` before
  `gemini.generate` (writer, outline, gap_analysis, audit, topic agents).
- `evals/judge_runner.py` — `set_prompt_meta` shim before `gemini.generate`.
- Tests: verify tags appear on generated Langfuse payload.

### P3 — Eval score forwarding + Dataset sync

**Goal:** `content_tool.evals` writes are mirrored to Langfuse Scores; gold-label
fixtures are a Langfuse Dataset enabling experiment comparison by `commit_sha`.

Deliverables:
- `evals/runner.py` — `record_score` calls after each `record_eval`; dataset
  upsert + run linking logic.
- `evals/langfuse_dataset.py` — dataset upsert helpers (isolated module).
- Tests: `tests/unit/test_langfuse_dataset.py`, `tests/unit/test_runner_scores.py`
  (both use fake client).

### P4 — CLI + ad-hoc judge wiring + self-hosted deploy notes

**Goal:** all four `RealGeminiClient` construction sites are wrapped; operator
has a one-command self-hosted Langfuse stack.

Deliverables:
- `content_tool/cli.py` — `ObservedGeminiClient` wrapper.
- `evals/run_judges_adhoc.py` — `ObservedGeminiClient` wrapper.
- `deploy/langfuse/docker-compose.yml` — self-hosted Langfuse stack (Langfuse
  server + Clickhouse + Redis). Separate from the main app stack.
- `deploy/langfuse/README.md` — env var setup, wrangler-secret equivalents for
  Workers (N/A — Langfuse integration is Python-backend only; the TypeScript
  Workers port does not receive this integration in P4).
- Tests: integration smoke test (skipped unless `LANGFUSE_ENABLED=true` + all
  keys set) confirming `flush()` reaches a live server.

---

## 6. What This Does NOT Include

- Langfuse Prompt Management (`langfuse.get_prompt`, `langfuse.create_prompt`) — permanently excluded (G1).
- TypeScript Workers port instrumentation — deferred post-P4; Workers has its
  own tracing concerns and the Python backend remains the eval reference path.
- Any change to `content_tool/prompts_store.py` semantics or the sha256
  computation (G2).
- Any new DB migration (G4).
- LangSmith, Helicone, or any other third-party LLM observability SaaS.

# Plan: Langfuse Observability + Eval Hub

**Date:** 2026-06-06
**Spec:** `docs/superpowers/specs/2026-06-06-langfuse-observability.md`
**Status:** Ready to implement

---

## Prerequisites (do before P1)

1. Provision self-hosted Langfuse (see `deploy/langfuse/` created in P4, or use
   Langfuse Cloud for dev). Obtain `LANGFUSE_HOST`, `LANGFUSE_PUBLIC_KEY`,
   `LANGFUSE_SECRET_KEY`.
2. Confirm `langfuse>=3,<4` installs cleanly in the venv:
   `uv pip install "langfuse>=3,<4"` — verify no dependency conflict with
   `google-genai` or `opentelemetry-*`.
3. Read `langfuse` Python SDK v3 docs for:
   - `Langfuse(host, public_key, secret_key)` constructor.
   - `langfuse.trace(id, name, session_id, metadata)` → `StatefulTraceClient`.
   - `trace.generation(name, input, output, usage, metadata, tags, start_time, end_time)`.
   - `langfuse.score(trace_id, name, value, comment)`.
   - `langfuse.get_dataset(name)` / `langfuse.create_dataset(name)`.
   - `dataset.create_item(input, expected_output, id)`.
   - `langfuse.flush()`.

---

## P1 — Core Instrumentation

### Files created

| File | Purpose |
|------|---------|
| `content_tool/observability/trace_context.py` | `set_active_trace_id` / `get_active_trace_id` ContextVar |
| `content_tool/observability/prompt_meta.py` | `PromptMeta` frozen dataclass + ContextVar helpers |
| `content_tool/observability/langfuse_client.py` | `LangfuseClient` protocol, `RealLangfuseClient`, `NoopLangfuseClient`, `make_langfuse_client()` factory |
| `content_tool/gemini/observed.py` | `ObservedGeminiClient` decorator wrapping any `GeminiClient` |
| `tests/unit/test_observed_gemini_client.py` | Unit tests (fake client, noop path, error-swallow, tag assembly) |

### Files modified

| File | Change |
|------|--------|
| `pyproject.toml` | Add `langfuse>=3,<4` under `[project.optional-dependencies]` key `observability`; keep it out of `[project.dependencies]` so the package installs without it |
| `content_tool/api/main.py` | In `init_runtime()`: call `make_langfuse_client()`, wrap `RealGeminiClient` in `ObservedGeminiClient`; store `langfuse` on `app.state`; call `await app.state.langfuse.flush()` in the `lifespan` shutdown path |
| `content_tool/api/sse.py` | In `RunExecutor._run_graph()` (or equivalent inner coroutine): call `set_active_trace_id(str(run_id))` before `astream` loop; call `set_active_trace_id(None)` in `finally`; call `self._langfuse.start_trace(…)` before loop; `RunExecutor.__init__` receives `langfuse: LangfuseClient` |

### Implementation order

1. Write `trace_context.py` — trivial ContextVar, no deps.
2. Write `prompt_meta.py` — frozen dataclass + ContextVar, no deps.
3. Write `langfuse_client.py`:
   a. Define `LangfuseClient` Protocol with `start_trace`, `record_generation`, `record_score`, `flush`.
   b. Write `NoopLangfuseClient` — every method is a no-op, zero `langfuse` imports.
   c. Write `RealLangfuseClient` — import `langfuse` INSIDE the class `__init__` body so the module can be imported without the package installed.
   d. Write `make_langfuse_client()` — reads `LANGFUSE_ENABLED`; returns `NoopLangfuseClient` when false/absent; validates the three credential vars and raises `ValueError` when enabled but missing; returns `RealLangfuseClient`.
4. Write `observed.py`:
   a. `ObservedGeminiClient.__init__(inner, langfuse)`.
   b. `generate`: call `inner.generate(…)` first (no pre-call side effects), then `langfuse.record_generation(…)` in a `try/except Exception` that logs and ignores.
   c. Read `get_active_trace_id()` and `get_prompt_meta()` inside `generate` to build trace handle ref and tags.
5. Write tests first (TDD):
   - `test_noop_returns_inner_result` — LANGFUSE_ENABLED unset, result passes through unchanged.
   - `test_error_in_langfuse_does_not_propagate` — `record_generation` raises, `generate` still returns.
   - `test_tags_assembled_from_prompt_meta` — `PromptMeta` in contextvar → tags list matches spec.
   - `test_no_trace_id_skips_recording` — when `get_active_trace_id()` is None, `record_generation` is not called.
6. Wire `main.py` and `sse.py` last (integration surface, requires steps 1-4 done).

### Acceptance criteria P1

- `pytest tests/unit/test_observed_gemini_client.py` passes.
- `LANGFUSE_ENABLED=` (unset) + `uv run python -c "from content_tool.gemini.observed import ObservedGeminiClient"` succeeds even without `langfuse` installed.
- `ruff check content_tool/observability/ content_tool/gemini/observed.py` clean.
- `pyright content_tool/observability/ content_tool/gemini/observed.py` introduces zero new errors.

---

## P2 — Prompt-Meta Tagging

### Files modified

| File | Change |
|------|--------|
| `content_tool/agents/writer.py` | After `get_assembled_session(…)` call, call `set_prompt_meta(PromptMeta(voice_slug=…, template_id="writer", sha256=sha))` before `gemini.generate` |
| `content_tool/agents/outline.py` | Same pattern for template_id `"outline"` |
| `content_tool/agents/gap_analysis.py` | Same pattern for template_id `"gap_analysis"` |
| `content_tool/agents/audit.py` | Same pattern for template_id `"audit"` |
| `content_tool/agents/topic_gen.py` | Same pattern — uses standalone helper, slug from state |
| `content_tool/agents/topic_dedup.py` | Same pattern |
| `evals/judge_runner.py` | In `run_judge`: after `prompts_store.get_assembled_standalone(f"judge_{metric}")`, call `set_prompt_meta(PromptMeta(voice_slug="__shared__", template_id=f"judge_{metric}", sha256=sha_of(prompt)))` |

### Notes

- The sha256 of the assembled prompt is already computed in `prompts_store` return values where available. If the agent does not have direct access to the sha, compute `hashlib.sha256(prompt.encode()).hexdigest()` locally — this is a tag only, not the parity sha, so a local recompute is fine.
- Do NOT modify `prompts_store.py` semantics (G2). Only add `set_prompt_meta` calls at the call sites.
- `set_prompt_meta(None)` is called in the `finally` of each agent if the contextvar needs cleanup (verify whether the LangGraph node context isolation makes this unnecessary).

### Acceptance criteria P2

- A test run with `LANGFUSE_ENABLED=true` against a local Langfuse instance shows Generation records with the three expected tags.
- Unit test: `test_tags_from_judge_runner` — mocked `run_judge` call produces expected tags on the recorded generation.

---

## P3 — Eval Score Forwarding + Dataset Sync

### Files created

| File | Purpose |
|------|---------|
| `evals/langfuse_dataset.py` | `upsert_gold_labels_dataset(langfuse, csv_path)` and `link_run_to_dataset(langfuse, dataset_name, fixture_id, run_id, commit_sha)` helpers |
| `tests/unit/test_langfuse_dataset.py` | Unit tests for dataset helpers using fake client |
| `tests/unit/test_runner_scores.py` | Unit tests verifying `record_score` is called after `record_eval` in runner |

### Files modified

| File | Change |
|------|--------|
| `evals/runner.py` | (a) `main()` receives `langfuse: LangfuseClient` (from factory call at top of `main`); (b) after each `await record_eval(…)` call, add `langfuse.record_score(trace_id=str(run_id), name=metric, value=score, comment=…)`; (c) add dataset upsert + run-linking calls at the top of `main()` before the judge loop |

### Implementation order

1. Write `evals/langfuse_dataset.py` with `upsert_gold_labels_dataset` and `link_run_to_dataset`.
2. Write tests for those helpers against `NoopLangfuseClient` and a minimal fake.
3. Modify `evals/runner.py`: inject `langfuse`, add score forwarding after existing `record_eval` calls (two deterministic metrics + LLM-judge loop), add dataset sync.
4. Write `test_runner_scores.py`.

### Acceptance criteria P3

- `pytest tests/unit/test_langfuse_dataset.py tests/unit/test_runner_scores.py` passes.
- Nightly runner (`python -m evals.runner`) with `LANGFUSE_ENABLED=true` produces Scores visible in the Langfuse UI under the run's Trace.
- Gold-label CSV rows appear as Dataset Items in Langfuse under dataset `"gold_labels"`.

---

## P4 — CLI + Ad-hoc Judge Wiring + Deploy Notes

### Files created

| File | Purpose |
|------|---------|
| `deploy/langfuse/docker-compose.yml` | Self-hosted Langfuse v3 stack (langfuse-web, langfuse-worker, clickhouse, redis, postgres sidecar or Supabase connection string) |
| `deploy/langfuse/README.md` | Env var reference, startup steps, health check URL, how to set `LANGFUSE_*` vars in the Python backend |

### Files modified

| File | Change |
|------|--------|
| `content_tool/cli.py` | Wrap `RealGeminiClient` in `ObservedGeminiClient` (factory call); pass `langfuse` to wrap; `langfuse.flush()` at end of CLI command |
| `evals/run_judges_adhoc.py` | Same pattern as `cli.py` |

### Notes

- The TypeScript Workers backend is NOT instrumented in P4. Langfuse's Python
  SDK is the integration surface; a future phase would add the Workers port via
  Langfuse's REST API or a TS SDK — out of scope.
- `docker-compose.yml` uses official `ghcr.io/langfuse/langfuse` image. Langfuse
  v3 requires Clickhouse for traces. Do not use v2 (Postgres-only) — the Python
  SDK v3 targets the v3 server API.
- Env vars to set for the Python backend (add to `.env.local`, never commit):
  ```
  LANGFUSE_ENABLED=true
  LANGFUSE_HOST=http://localhost:3001
  LANGFUSE_PUBLIC_KEY=pk-lf-…
  LANGFUSE_SECRET_KEY=sk-lf-…
  ```

### Acceptance criteria P4

- `content-tool gap-analysis …` with `LANGFUSE_ENABLED=true` produces a Trace in Langfuse.
- `python evals/run_judges_adhoc.py` with `LANGFUSE_ENABLED=true` produces Generation records.
- `LANGFUSE_ENABLED=` (unset): all four entry points behave identically to pre-feature baseline (no imports, no network, existing tests all pass unchanged).

---

## Cross-cutting rules (all phases)

- Every new file: module docstring must quote G1 and G2 guardrails.
- Every new async method that touches Langfuse: wrap in `try/except Exception` and log with structlog at `warning` level; never raise into the calling code path.
- `pyright strict` on all new files: no `Any` escapes without `# pyright: ignore` and a comment.
- Ruff clean on all new files.
- No `langfuse` symbol at module import level in files that are imported unconditionally by the app (use local imports inside `__init__` or the `if ENABLED` branch inside the factory).
- Tests use a `FakeLangfuseClient` fixture (not `unittest.mock.MagicMock`) so the protocol is verified structurally.

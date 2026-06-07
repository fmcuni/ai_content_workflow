# Prompt-Improvement Advisor (LLM-as-judge meta-evaluator)

**Date:** 2026-06-07
**Status:** Spec
**Owner:** content-tool / evals + observability

## Problem

The project already runs four LLM-as-judge rubrics (`brand_voice`,
`hk_localisation`, `citation_alignment`, `coverage`) over published runs. They
are **diagnostic scorers**: each returns a 0–1 score plus an `issues[]` list and
mirrors that score to Langfuse (`evals/runner.py::_emit_langfuse_score`). They
tell you *that* output quality dipped, and *where* (which metric), but never
*how to fix it* — specifically, which **prompt** (system prompt fragment, writer
agent prompt, gap-analysis/outline prompt, or persona data) to change and **in
what direction**.

Operators currently read the scores, eyeball a few drafts, and hand-edit prompts
in `/prompts`. That loop is slow, unsystematic, and loses the cross-run signal
(a recurring brand-voice miss across 8 runs is far stronger evidence than one).

## Goal

Add an **aggregate, prescriptive** LLM-as-judge — the *Prompt-Improvement
Advisor* — that:

1. Aggregates the existing judge scores + issues across the last *N* published
   runs (per voice).
2. Attributes recurring weakness to the specific prompt template(s) most
   responsible for each metric.
3. Asks an LLM judge, per implicated prompt, to produce a **diagnosis**, a
   ranked list of **directional changes**, and a **concrete revised prompt
   proposal** (before/after).
4. Emits three outputs (all chosen by the requester):
   - a dated **Markdown report**,
   - **Langfuse write-back** (a score + structured comment per contributing
     trace), and
   - **concrete prompt-edit proposals** (before/after blocks, *not* auto-applied).

## Non-goals

- **No auto-apply / no PR open.** Prompt edits are surfaced for human review and
  pasted into `/prompts` (or committed) by an operator. Editing a live prompt is
  a real-world action; the advisor only proposes.
- **No Workers TS port.** Like the rest of `evals/`, this is Python-only and runs
  locally / via cron, never in the hot request path.
- **No new managed Langfuse evaluator.** We reuse the existing
  `create_score` write-back surface, not Langfuse's UI-configured evaluators
  (which can't do cross-run prescriptive synthesis).
- **No DB schema change** beyond seeding one new judge prompt row. The advisor
  reads existing `content_tool.evals` + `runs`; it does not persist its own
  findings to Postgres (the report file + Langfuse are the durable outputs).

## Design

### Data flow

```
content_tool.evals (judge metrics)  ──┐
content_tool.runs  (persona, mode) ──┤  aggregate per (voice, metric)
                                      ▼
              MetricAggregate{n, mean_score, fail_rate, sample_issues, run_ids}
                                      │  invert METRIC_PROMPT_ATTRIBUTION
                                      ▼
              AdvisorJob{voice, template_id, current_body, evidence[]}
                                      │  judge_prompt_advisor rubric  (Gemini)
                                      ▼
              AdvisorFinding{diagnosis, severity, directions[], proposed_prompt, confidence}
                                      ├──► Markdown report  (evals/out/prompt-advisor-<date>.md)
                                      ├──► Langfuse score + comment  (per contributing trace)
                                      └──► before/after prompt diff  (in the report)
```

### Attribution map (`METRIC_PROMPT_ATTRIBUTION`)

Each judge metric maps to the editable prompt template(s) that most plausibly
drive it. Every target is a real template_id (asserted by a unit test against
`prompts/` + `evals/judge/`). The map is inverted to gather, per template, the
union of weak-metric evidence.

| metric | attributed templates |
|---|---|
| `brand_voice` | `_writer_brand_block`, `writer_full_rewrite`, `writer_small_refresh`, `writer_create` |
| `hk_localisation` | `_writer_brand_block`, `writer_full_rewrite`, `writer_small_refresh`, `writer_create` |
| `citation_alignment` | `_writer_seo`, `writer_full_rewrite`, `writer_small_refresh`, `writer_create` |
| `coverage` | `gap_analysis`, `outline`, `writer_full_rewrite`, `writer_small_refresh` |

The rubric also instructs the model that some weaknesses trace to **persona
data** (voice_rules / glossary / banned_terms) or **source policy** rather than
the prompt text, and to say so in `directions` when that is the likelier cause —
covering the "or else" in the request without extra plumbing.

### Weakness gate

Run the advisor for a `(voice, template)` only when at least one attributed
metric is **weak**: `n >= MIN_SAMPLES` (default 3) **and** `fail_rate >=
MIN_FAIL_RATE` (default 0.20). This bounds Gemini cost and avoids advising on
prompts that are already performing.

### Advisor rubric — `evals/judge/prompt_advisor.md` → `judge_prompt_advisor`

A new shared (`__shared__`) **judge** template. Input payload (JSON):
`{template_id, category, current_body, voice_slug, evidence:[{metric, n,
mean_score, fail_rate, sample_issues}]}`. Strict JSON output:

```json
{
  "diagnosis": "…why the current prompt likely produces these failures…",
  "severity": 1-5,
  "directions": ["strengthen X", "remove Y", "add explicit rule Z", …],
  "root_cause_target": "prompt" | "persona_data" | "source_policy" | "mixed",
  "proposed_prompt": "…full revised body (or clearly-marked excerpt)…",
  "confidence": 0.0-1.0
}
```

`severity/5` becomes the Langfuse score value; the diagnosis + directions become
the comment.

### Outputs

- **Markdown report** (`evals/out/prompt-advisor-<YYYY-MM-DD>.md`, gitignored via
  `out/`): one section per `(voice, template)` finding, ordered by severity
  desc. Each section has an evidence table (metric · n · mean · fail-rate ·
  sample issues), the diagnosis, the directional bullets, a `root_cause_target`
  badge, the contributing run ids (= Langfuse trace ids), and a **before/after**
  fenced diff (`current_body` vs `proposed_prompt`).
- **Langfuse write-back**: best-effort, gated on `langfuse_enabled`, never
  raises (mirrors `evals/runner.py`). For each contributing run id, attach
  `create_score(trace_id=run_id, name="prompt_advisor.<template_id>",
  value=severity/5, comment=<diagnosis + directions JSON>)`.
- **Proposed edits**: the `proposed_prompt` is rendered in the report only —
  never written to the DB or prompt files.

### Files

| File | Role |
|---|---|
| `evals/judge/prompt_advisor.md` | New judge rubric (繁中 instructions, English JSON keys), mirrors the other judge `.md` sources |
| `evals/prompt_advisor.py` | Attribution map, aggregation, job building, advisor run + normalisation, Langfuse emit |
| `evals/prompt_advisor_report.py` | Deterministic Markdown rendering (before/after + evidence) |
| `evals/run_prompt_advisor.py` | CLI: `python -m evals.run_prompt_advisor [--limit N] [--voice slug] [--min-fail-rate F] [--out PATH] [--no-langfuse]` |
| `supabase/migrations/20260607000001_prompt_advisor_judge.sql` | Companion forward UPSERT seeding `judge_prompt_advisor` under `__shared__` (both `db reset` + `db push`) |
| `scripts/gen_prompt_seed.py` | Add `judge_prompt_advisor` to `_JUDGES` (seed-of-record for future regenerations) |
| `tests/unit/test_prompt_advisor.py` | Attribution invariants, aggregation, gate, normalisation, FakeGemini end-to-end, Langfuse gating |
| `tests/unit/test_prompt_advisor_report.py` | Report rendering is deterministic + contains evidence/before/after |

The rubric loader (`evals/prompt_advisor.py::_load_advisor_prompt`) prefers the
DB row (`prompts_store.get_template_row_standalone("judge_prompt_advisor")`) and
falls back to reading `evals/judge/prompt_advisor.md` from disk, so the tool runs
locally before the migration is pushed and picks up `/prompts` editor edits once
seeded.

### Safety / invariants

- Read-only against prompts and the DB; the only writes are the report file and
  best-effort Langfuse scores.
- Langfuse failures are swallowed (never break the report).
- Adding `judge_prompt_advisor` is safe under the per-voice library: judges stay
  global under `__shared__` and are **excluded** from the per-voice
  agent/partial equality assertion (`scripts/check_per_voice_backfill.sql`).
- `data_scope`: public editorial content only — evidence excerpts are article
  text + judge notes, no PII/PHI.

## Test plan

1. **Attribution map** — every attributed `template_id` resolves to a real
   bundled prompt source; every judge metric has ≥1 target.
2. **Aggregation** — from synthetic `Eval` rows, `MetricAggregate` computes
   correct n / mean / fail_rate and samples issues without unbounded growth.
3. **Gate** — `(voice, template)` below `MIN_SAMPLES`/`MIN_FAIL_RATE` produces no
   job; above produces one job carrying the union of weak-metric evidence.
4. **Advisor run** — `FakeGeminiClient` returns a canned finding; normalisation
   maps `severity` → score and clamps out-of-range values.
5. **Langfuse emit** — with a mock client + `reset_for_testing`, one score per
   contributing run id; disabled flag = no calls; client exception swallowed.
6. **Report** — deterministic Markdown, ordered by severity, contains evidence
   table + before/after blocks + run ids.

Target ≥80% coverage on the new modules.

# Prompts & Templates → Database (source of truth)

**Date:** 2026-05-29
**Status:** in progress

## Context

Today the live prompt bodies are `.md` files under `prompts/` (and `evals/judge/`).
Runtime agents `read_text()` them on every node call; the editor at `/prompts`
writes the files atomically and *separately* appends history to the
`prompt_versions` table. Consequences:

- UI edits only change the local filesystem — they do **not** propagate across
  environments (a deploy with a fresh checkout reverts them).
- "Source of truth" is split between disk (live) and DB (history).

Goal: make the **database the single source of truth** for all prompt
templates. Editor writes update the DB; runtime reads the DB. `.md` files are
kept as the human-readable seed source (they generate the seed migration).

## Decisions (confirmed)

1. **New `content_tool.prompt_templates` table** holds the live body per
   `template_id`. `prompt_versions` stays as append-only history (no FK — adding
   one risks the prod cutover, since `db push` does not run seed and would see an
   empty parent table against existing history rows).
2. **Keep `.md` files** as the seed source + golden-test input. Runtime stops
   reading them.
3. **Scope = all 19 templates**: 10 agent prompts + 5 partials + 4 eval judges.

## Schema

`content_tool.prompt_templates`:

| column | type | notes |
|---|---|---|
| template_id | varchar PK | e.g. `writer_small_refresh`, `_writer_schema`, `judge_brand_voice` |
| category | varchar | `agent` \| `partial` \| `judge` |
| filename | varchar | source filename for reference/seed regen |
| body | varchar | exact file content (incl. trailing newline) |
| sha256 | varchar | `sha256(body.utf8)` — must equal editor's `_sha256` |
| bytes | integer | `len(body.utf8)` |
| updated_at | timestamptz default now() | onupdate now() |
| updated_by | varchar null | last editor email |

Migrations (new, timestamped after the existing four):
- `*_prompt_templates.sql` — `CREATE TABLE` + index + seed `INSERT … ON CONFLICT
  DO NOTHING` (dollar-quoted bodies). Testcontainer-safe; applied by conftest and
  by `db push` (so prod is populated without relying on seed.sql).
- `*_prompt_templates_rls.sql` — `ENABLE ROW LEVEL SECURITY` + `postgres_allow_all`
  + `app_allow_all` policies (mirrors existing RLS migrations; skipped in tests
  like the other RLS migrations).

Seed SQL is produced by `scripts/gen_prompt_seed.py` (reads the registry + files,
computes sha/bytes). Re-runnable when the `.md` files change before cutover.

## Runtime loader — `content_tool/prompts_store.py`

- Module-level configured `session_factory` (set in `api/main.py` lifespan) +
  `_cache: dict[template_id, body]`.
- `async get_assembled(template_id, *, session)` → fetch body, resolve
  `{{include:NAME}}` recursively from DB, **byte-for-byte identical** to
  `writer.resolve_includes` (top-level body unstripped; included bodies
  `.rstrip("\n")` before recursion).
- `async get_assembled_standalone(template_id)` → opens its own session via the
  configured factory; for session-less callers (`topic_*`, `judge`, refresh
  evaluator).
- `get_body(...)` / `invalidate(template_id)` / `clear_cache()`.

Why a module global: `topic_*` `run_*`, `run_judge`, and
`refresh.evaluator.llm_audit_published` have **no DB session** in scope and
threading one through their signatures (+ all their unit tests) is invasive.
This mirrors the existing `app.state.session_factory` handle. Production hot-path
agents that already hold a session (`writer`, `audit`, `outline`, `gap_analysis`)
pass it explicitly.

## Consumer changes (read from store, not disk)

| file | change |
|---|---|
| `agents/writer.py` | `build_system_prompt` → `await store.get_assembled(route_id, session=session)`; keep `resolve_includes` + `PROMPT_PATHS` for the golden test |
| `agents/audit.py` | `build_system_prompt_from_pack(persona, today, *, template)` becomes pure (takes template text); async `build_system_prompt` fetches via store |
| `refresh/evaluator.py` | fetch `audit` template via `store.get_assembled_standalone("audit")`, pass into `build_system_prompt_from_pack` |
| `agents/outline.py` | `build_system_prompt(today, start_mode, *, session)` async; fetch `outline` + `outline_create_mode` from store |
| `agents/gap_analysis.py` | `build_system_prompt(today, *, session)` async |
| `agents/topic_{gen,dedup,hot}.py` | `build_system_prompt()` async → `store.get_assembled_standalone(id)` |
| `evals/judge_runner.py` | metric→template_id map; `store.get_assembled_standalone(id)` |

## Editor API — `api/routes/prompts.py`

Keep `_TEMPLATE_FILES`/`_PARTIAL_FILES`/`_REQUIRED_PLACEHOLDERS` as the registry +
validation rules. Replace all disk IO:
- GET list/template/schema/consumers → query `prompt_templates` (add session dep).
- PUT save / POST revert → optimistic-concurrency sha check against the DB row,
  `UPDATE prompt_templates` + `INSERT prompt_versions` in **one transaction**,
  then `store.invalidate(template_id)`.
- preview → resolve includes from DB via store (with edited-buffer override).
- list endpoint stays scoped to agent+partial (frontend unchanged); judges are in
  the table for runtime but not listed in the editor.

## Tests

- `conftest.apply_migrations`: also apply `*_prompt_templates.sql` (table + seed)
  after baseline, before `seed.sql`.
- `prompts_store` configured for tests: in `api_client` fixture (reuses
  `pg_session_factory`) + small autouse fixtures in `test_topic_*`,
  `test_judge_runner` (session-less paths). Node tests pass their own session.
- Rewrite `test_api_prompts.py`: replace `restore_prompt` (disk snapshot) with a
  DB-row snapshot/restore fixture; assert DB body instead of file content.
- `test_writer_prompt_compose.py` golden test unchanged (still validates the
  `.md` seed files assemble correctly).

## Verification

- `pytest` green (esp. `tests/integration/test_api_prompts.py`, node tests,
  topic/judge unit tests, golden compose test).
- `ruff check .` + `pyright` no new errors in touched files.
- Manual: `supabase db reset` then GET `/prompts/templates/audit` returns the
  seeded body + sha; PUT an edit; confirm a *new run* picks up the edited prompt
  (store cache invalidated) — verify via the live API on :8000.

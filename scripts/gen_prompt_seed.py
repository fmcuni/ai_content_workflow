#!/usr/bin/env python3
"""Generate the per-voice prompt-template re-seed migration from the .md sources.

The database is the source of truth for prompt bodies at runtime; the .md files
under ``prompts/`` and ``evals/judge/`` are the human-editable seed source. This
script reads them, computes the sha256 + byte length the editor expects, and
emits a self-contained, forward-only Supabase migration that both
``supabase db reset`` (local) and ``supabase db push`` (prod) can apply.

Per-voice prompt library (2026-06-05)
-------------------------------------
``content_tool.prompt_templates`` is now scoped per voice: PK
``(voice_slug, template_id)`` with the reserved sentinel ``__shared__`` holding
the canonical agent/partial set plus all judges. This generator owns the
``__shared__`` **seed-of-record** only and emits a forward UPSERT that re-asserts
those rows from the current .md bodies (mirroring the
``20260602000002_topic_existing_search_prompt.sql`` forward-upsert pattern).

Why this is the only file the generator writes (and what it deliberately does
NOT do):

* It does **not** touch ``20260529000001_prompt_templates.sql`` — that migration
  is the **frozen pre-voice baseline**. It creates the table with PK
  ``(template_id)`` and runs BEFORE ``20260604172254_per_voice_prompt_library.sql``
  adds ``voice_slug`` and repoints the PK. Rewriting it into a per-voice shape
  would break ``supabase db reset`` ("column already exists" / duplicate PK), and
  it is already applied on prod (supabase runs each migration once by name), so
  rewriting it reaches prod with nothing anyway. Body edits propagate via this
  forward re-seed instead.
* It writes **only** the ``__shared__`` rows. It does **not** fan re-seed rows
  out across every voice. Runtime loaders resolve a template by the chain
  ``voice → __shared__ → bundled file`` (spec "Phase 0 decisions"), so keeping
  ``__shared__`` authoritative is sufficient for a voice that was created before
  a template existed — it falls through to ``__shared__``.

Consequences to keep in mind (documented so they are not later misread as bugs):

* On ``supabase db reset`` the Phase 1 migration backfills each existing voice
  (e.g. ``bowtie-editor``) from the ``__shared__`` body BEFORE this re-seed runs.
  So after a body edit + regenerate + reset, the NEW body lands under
  ``__shared__`` while a voice's OWN row keeps the body it was backfilled with.
  A voice only resolves through ``__shared__`` when it has no row of its own.
  Landing a body edit on an existing voice's row is a later-phase / operator
  action, not this generator's job.
* The Phase 1 backfill copies the then-current ``__shared__`` set into each
  voice, and ``scripts/check_per_voice_backfill.sql`` asserts each voice has
  exactly ``__shared__``-many agent/partial rows. ADDING a brand-new
  agent/partial template here (changing the registry below) would grow
  ``__shared__`` without growing pre-existing voices, breaking that equality
  assertion on reset. Adding a template later therefore needs a companion
  fan-out migration (or relaxing the assertion to be fallback-aware) — out of
  scope for a pure body re-seed.

Run from the repo root::

    python scripts/gen_prompt_seed.py

It overwrites ``supabase/migrations/20260605000001_reseed_prompt_templates_shared.sql``.
Output is deterministic (fixed path, statically-ordered registry, sha over the
exact body), so re-running with unchanged sources produces no diff.
"""

from __future__ import annotations

import hashlib
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
PROMPTS_DIR = REPO_ROOT / "prompts"
JUDGE_DIR = REPO_ROOT / "evals" / "judge"
OUT_PATH = (
    REPO_ROOT / "supabase" / "migrations" / "20260605000001_reseed_prompt_templates_shared.sql"
)

# Reserved sentinel voice for global / seed-of-record rows (judges + canonical
# agent/partial set). Mirrors content_tool.prompt_templates.voice_slug DEFAULT.
SHARED_VOICE = "__shared__"

# updated_by stamp on the re-seeded rows; identifies the source migration.
_UPDATED_BY = "migration:reseed_prompt_templates_shared"

# Dollar-quote tag for embedding arbitrary body text in SQL safely.
_DQ = "$pt$"

# template_id -> (category, source path). Order is stable for deterministic diffs.
_AGENTS = [
    "audit",
    "gap_analysis",
    "outline",
    "outline_create_mode",
    "writer_small_refresh",
    "writer_full_rewrite",
    "writer_create",
    "topic_gen",
    "topic_dedup",
    "topic_existing_search",
    "topic_hot",
]
_PARTIALS = [
    "_writer_brand_block",
    "_writer_schema",
    "_writer_seo",
    "_writer_refine_notes",
    "_writer_output_format_tail",
]
_JUDGES = {
    "judge_brand_voice": "brand_voice.md",
    "judge_coverage": "coverage.md",
    "judge_citation_alignment": "citation_alignment.md",
    "judge_hk_localisation": "hk_localisation.md",
}


def _registry() -> list[tuple[str, str, Path]]:
    """Return (template_id, category, source_path) for every template."""
    rows: list[tuple[str, str, Path]] = []
    for tid in _AGENTS:
        rows.append((tid, "agent", PROMPTS_DIR / f"{tid}.md"))
    for tid in _PARTIALS:
        rows.append((tid, "partial", PROMPTS_DIR / f"{tid}.md"))
    for tid, fname in _JUDGES.items():
        rows.append((tid, "judge", JUDGE_DIR / fname))
    return rows


def _sql_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def _values_clause() -> str:
    lines: list[str] = []
    for tid, category, path in _registry():
        if not path.exists():
            raise FileNotFoundError(f"prompt source missing: {path}")
        body = path.read_text(encoding="utf-8")
        if _DQ in body:
            raise ValueError(f"body of {tid} contains the dollar-quote tag {_DQ!r}")
        sha = hashlib.sha256(body.encode("utf-8")).hexdigest()
        nbytes = len(body.encode("utf-8"))
        lines.append(
            f"  ({_sql_literal(SHARED_VOICE)}, {_sql_literal(tid)}, {_sql_literal(category)}, "
            f"{_sql_literal(path.name)}, {_DQ}{body}{_DQ}, "
            f"{_sql_literal(sha)}, {nbytes})"
        )
    return ",\n".join(lines)


def build_migration() -> str:
    header = """\
-- AUTO-GENERATED by scripts/gen_prompt_seed.py -- do not edit by hand.
-- Forward re-seed of the '__shared__' prompt-template seed-of-record (canonical
-- agent/partial set + all judges) from the current prompts/ and evals/judge/ .md
-- sources. This is the path by which .md body edits reach both `supabase db
-- reset` (local) and `supabase db push` (prod) AFTER the per-voice migration.
--
-- Ordering: runs after 20260604172254_per_voice_prompt_library.sql, so the
-- table already exists with PK (voice_slug, template_id). No CREATE TABLE here.
-- The frozen pre-voice baseline 20260529000001_prompt_templates.sql still owns
-- table creation; this migration only re-asserts row bodies.
--
-- Scope: writes ONLY voice_slug='__shared__'. Per-voice rows are owned by the
-- per-voice backfill / operator edits; loaders fall back voice -> __shared__ ->
-- file, so keeping __shared__ authoritative is sufficient. ON CONFLICT DO UPDATE
-- keeps re-runs idempotent and lets body edits land. Parity-safe: both the
-- Python and Workers backends read these bodies from content_tool.prompt_templates.

INSERT INTO content_tool.prompt_templates
    (voice_slug, template_id, category, filename, body, sha256, bytes)
VALUES
"""
    tail = (
        "\nON CONFLICT (voice_slug, template_id) DO UPDATE SET\n"
        "    category = EXCLUDED.category,\n"
        "    filename = EXCLUDED.filename,\n"
        "    body = EXCLUDED.body,\n"
        "    sha256 = EXCLUDED.sha256,\n"
        "    bytes = EXCLUDED.bytes,\n"
        "    updated_at = now(),\n"
        f"    updated_by = {_sql_literal(_UPDATED_BY)};\n"
    )
    return header + _values_clause() + tail


def main() -> None:
    OUT_PATH.write_text(build_migration(), encoding="utf-8")
    n = len(_registry())
    print(f"wrote {OUT_PATH.relative_to(REPO_ROOT)} ({n} templates under {SHARED_VOICE!r})")


if __name__ == "__main__":
    main()

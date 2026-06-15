# Voice Locale & Brand Portability — Plan

**Date:** 2026-06-15
**Spec:** `docs/superpowers/specs/2026-06-15-voice-locale-brand-portability.md`
**Branch:** `feat/voice-locale-portability` (dev Workers stack first, then prod)

**Status (2026-06-15):** Phases A + B + integration SHIPPED to the branch
(`10d0061`, `542a6f2`). Migrations `20260616000000_persona_locale` +
`20260616000001_reseed_shared_locale_tokens` applied to **dev**; `bowtie-en-my.locale`
set in dev; dev backend deployed. Verified on live dev DB: en → `## Sources` +
audit passes + English persona block + zero token leaks; HK-ZH byte-identical
(round-trip + goldens). **Stopped before prod promotion** per plan. Remaining:
apply migrations to prod, deploy prod, set prod locales, mark SHIPPED.

## How to run this with sub-agents

The work is a small **foundation** (Phase A) that several **independent**
workstreams depend on, then a **fan-out** (Phase B) of file-disjoint workstreams
that parallelise cleanly, then **integration** (Phase C).

- **Phase A is sequential and blocking** — one agent, land first.
- **Phase B workstreams own disjoint files** → spawn one sub-agent each, in
  parallel. The only shared file is `models/persona.py` / its TS mirror, owned
  solely by **B2** (others must not touch it).
- Each workstream changes **both backends** (Python `content_tool/` + TS
  `deploy/cloudflare-workers/src/`) and ships with tests. Production is the TS
  port — a PY-only change is incomplete.
- Recommended agents: `ecc:python-reviewer` / `ecc:typescript-reviewer` /
  `ecc:fastapi-reviewer` for review passes; `ecc:tdd-guide` for the test-first
  loop; `ecc:database-reviewer` for the migration. Use the `Workflow` tool only
  if the user opts into multi-agent orchestration.

### Dependency DAG

```
Phase 0 (DONE): copy prod voices → dev
        │
Phase A: VoiceLocale foundation (migration + loader, both backends)   [BLOCKING]
        │
        ├─ B1: sources/FAQ heading config        (resolve_citations, render_html, audit_checks + TS)
        ├─ B2: persona-block label parameterize   (models/persona.py + TS persona block)
        ├─ B3: brand/lang/market tokens           (writer.build_system_prompt, shared partials/templates + TS)
        └─ B4: topic_hot market token             (topic_hot.py + topic_hot template + TS)
        │
Phase C: reseed migration + golden/parity tests + dev e2e (bowtie-en-my) + docs
```

## Phase 0 — Copy prod voices to dev — ✅ DONE (2026-06-15)

Runtime voice config is intentionally not migration-synced, so dev was seeded
from prod for testing via `scripts/oneoff_copy_voices_prod_to_dev.py`
(idempotent, PK/natural-key upsert, public editorial config only):

| table | prod rows | copied to dev |
|---|---|---|
| publish_targets | 2 | 2 |
| personas | 8 | 8 |
| source_policy | 9 | 9 |
| prompt_templates | 149 | 149 |

Dev now holds `bowtie-editor` (Bowtie HK ZH), `bowtie-en-my`, `bowtie-zh-my`,
`bowtie-my`, and the test/smoke voices — enough to exercise the English path in
Phase C. **Delete the one-off script after Phase C; do not commit it.**

## Phase A — `VoiceLocale` foundation  *(blocking, one agent)*

**Owns:** `supabase/migrations/<ts>_persona_locale.sql`, `models/persona.py`
(add `VoiceLocale` model + parse helper; do NOT yet change `to_prompt_block` —
that's B2), `db/persona_model.py` (map `locale` column), `policy/personas.py`
(`_row_to_pack` carries `locale`), and the TS persona load
(`deploy/cloudflare-workers/src/.../persona*.ts`, postgres.js select + type).

**Do:**
1. Migration: `ADD COLUMN IF NOT EXISTS locale jsonb NOT NULL DEFAULT '{}'`.
2. `VoiceLocale` model with the §4.2 defaults (HK-ZH-preserving). Add a resolver
   `VoiceLocale.from_raw(dict)` and expose `PersonaPack.locale`.
3. Mirror the type + DB read in TS; keep the field optional so empty `{}` → all
   defaults.

**Done when:** loading any current voice yields a `VoiceLocale` equal to the
HK-ZH defaults; migration applies on `supabase db reset`; pyright/tsc clean;
parity gate still green (no behaviour change yet).

## Phase B — fan-out  *(parallel; file-disjoint)*

### B1 — Sources/FAQ heading from config  *(the live-bug fix)*
**Owns:** `agents/resolve_citations.py`, `agents/render_html.py`,
`agents/audit_checks.py` + TS mirrors (`resolve-citations.ts`, `render*.ts`,
`audit*.ts`).
**Do:** thread the resolved `VoiceLocale` into these nodes (load via
`run.persona`). `_sources_heading_for` returns `locale.sources_heading` when set
else current detection; `render_html` takes `faq_heading`/`sources_heading`;
`audit_checks` compares against the configured heading (default: accept both
Chinese scripts).
**Done when:** zh voices unchanged (golden); a voice with
`sources_heading="Sources"` renders `## Sources` and passes audit. Unit tests
both backends.

### B2 — Persona-block label parameterization
**Owns:** `models/persona.py` (`to_prompt_block`) + TS persona-block builder.
**Do:** accept a label set selected by `locale.ui_lang` (`zh-Hant` default = the
current strings with the `必須採用的香港用語` line neutralised to a brand-agnostic
"required phrasings" label; `en` set provided). No structural change to the
block.
**Done when:** HK-ZH block byte-identical (golden); `ui_lang="en"` emits English
labels with no Traditional-Chinese scaffolding.

### B3 — Brand/language/market tokens
**Owns:** `agents/writer.py` (`build_system_prompt`), shared prompt files
(`prompts/_writer_brand_block.md`, `prompts/_writer_schema.md`, shared
`writer_*` / `outline_*` bodies) + TS `build_system_prompt` equivalent.
**Do:** add `{brand_name}`/`{output_language}`/`{market}` `.replace()` calls
after the existing token replaces; swap the literals in the shared files for
those tokens. (Reseed of the DB `__shared__` rows is Phase C.)
**Done when:** with HK-ZH defaults the assembled prompt is byte-identical
(golden, both backends); setting `brand_name`/`output_language` changes the
assembled text accordingly.

### B4 — `topic_hot` market token
**Owns:** `agents/topic_hot.py` + `prompts/topic_hot.md` + TS topic-hot.
**Do:** interpolate `{market}` (from `VoiceLocale`) in place of the literal
`Google 香港繁中 SERP`.
**Done when:** HK-ZH prompt unchanged; a MY voice asks about its own market.

## Phase C — integration  *(sequential, one agent)*

1. **Reseed migration** for the `__shared__` prompt rows edited in B3 (tokens),
   following the existing `reseed_*` migration pattern. Assert it touches only
   `voice_slug='__shared__'` rows and leaves per-voice row counts unchanged.
2. **Golden + parity:** add byte-identical golden snapshots for `bowtie-editor`
   (system prompt + rendered HTML) in both backends; run
   `node deploy/cloudflare-workers/parity/check-parity.mjs` → green.
3. **Apply migrations:** dev (`supabase db push --db-url "$DEV_POSTGRES_URL"`)
   then prod (`supabase db push`). Keep both in sync.
4. **Set `bowtie-en-my.locale` in dev** (the §4.3 example) and run a create-mode
   and a refresh-mode article end-to-end on the dev Workers stack. Self-verify
   the published-shape HTML via `scripts/claude-debug` (DEV-ONLY; never approve/
   publish — WordPress is shared with prod).
5. **Promote:** deploy the same commit to prod; set prod locales for
   `bowtie-en-my` / `bowtie-zh-my`. Delete `scripts/oneoff_copy_voices_prod_to_dev.py`.
6. **Docs/memory:** note the new `personas.locale` SSOT in project CLAUDE.md
   "Conventions" (one line) and update this plan to SHIPPED.

## Test matrix (both backends)

| Check | HK ZH (baseline) | EN (bowtie-en-my) |
|---|---|---|
| Assembled system prompt | byte-identical to pre-change | English; no `必須採用的香港用語`, no `Bowtie` literal forced |
| Sources heading | `資訊來源`/`资讯来源` (auto) | `Sources` |
| `audit_checks` sources gate | passes | passes |
| `render_html` FAQ heading | `常見問題` | `Frequently Asked Questions` |
| `topic_hot` prompt | `Google 香港繁中` | MY market |
| Parity gate | green | green |

## Out of scope (follow-ups)

- Admin UI to edit `personas.locale` (seed via DB for now).
- Translating operator-facing strings (`audit_checks.suggested_fix`, writer
  structural-error/retry text).
- `source_policy` default block `香港相關性與時效` (already overridable per voice).

# Voice Locale & Brand Portability — Spec

**Date:** 2026-06-15
**Status:** Proposed
**Reference voice:** `bowtie-editor` — *Bowtie HK ZH* (the canonical baseline; all defaults must reproduce its current output byte-for-byte)

## 1. Goal

Make it cheap and safe to stand up a voice with a **different brand identity,
output language, or local market** without editing Python/TypeScript or
hand-rewriting every prompt. Today the per-voice *data* layer already supports
this (per-voice prompt templates, partials, source policy, persona packs with a
`voice → __shared__ → bundled-file` fallback), but **locale and brand leak into
code** in places a voice cannot override:

- A non-Chinese voice (live `bowtie-en-my`) gets a **Traditional-Chinese
  `資訊來源` sources heading welded onto its English article**, and **fails its
  own audit** because the audit hard-requires that Chinese heading.
- Every voice — incl. English — gets **Traditional-Chinese scaffolding labels**
  and a field literally named **`必須採用的香港用語`** ("Hong Kong terms") injected
  into its system prompt.
- The brand string **`Bowtie`** and **`香港繁體中文`** are baked into the *shared*
  default templates/partials, so onboarding a brand means cloning ~18 files and
  risking silent HK-ZH/Bowtie leakage on any partial you forget to override.

This spec keeps the current structure. It introduces **one per-voice locale
config (single source of truth)** and threads a handful of values through the
**existing** token/`.replace()` assembly path and three post-processing call
sites. No new tables, no flow changes, no schema-breaking edits.

## 2. Non-goals

- No refactor of the graph, the prompt-store, or the per-voice resolution chain.
- No new UI required to ship (admin editing of locale is a nice-to-have, listed
  optional). Locale can be seeded via the runtime DB like voices/prompts are.
- No change to `WriterOutput`/schema field shapes (already language-neutral).
- Not translating operator-facing strings (e.g. `audit_checks.suggested_fix`,
  writer structural-error messages) — out of scope, tracked as a follow-up.

## 3. Background — where brand/locale lives today

| Layer | Per-voice overridable now? | Brand/locale coupling |
|---|---|---|
| Prompt templates `writer_*`, `outline_*`, `topic_*`, `audit` | ✅ DB `(voice_slug, template_id)` → `__shared__` → file | Shared defaults hardcode `Bowtie`, `香港繁體中文`, `香港讀者` |
| Prompt partials `_writer_brand_block`, `_writer_schema`, … | ✅ DB partial rows resolved inside `get_assembled` | `_writer_brand_block` hardcodes `Bowtie`; `_writer_schema` hardcodes `Bowtie 機構資訊` |
| Source policy | ✅ per-voice, editable `prompt_block` + tokens | Default block line `香港相關性與時效` (already overridable → low) |
| `PersonaPack.to_prompt_block` (`models/persona.py`) | ❌ Python | Traditional-Chinese labels + `必須採用的香港用語` |
| `resolve_citations._sources_heading_for` | ❌ Python | Sources heading by Chinese char-count; non-Chinese → Traditional `資訊來源` |
| `render_html` FAQ/sources split | ❌ Python | Fallback `常見問題`, split regex Chinese-only |
| `audit_checks` | ❌ Python | Hard-requires `<h2>資訊來源\|资讯来源</h2>` |
| `topic_hot.py` | ❌ Python (prompt built in code) | Hardcodes `Google 香港繁中 SERP` |

**Production runs the TypeScript Workers port** (`deploy/cloudflare-workers/`),
not the Python backend. Every code change below MUST be mirrored in TS, and the
parity gate (`deploy/cloudflare-workers/parity/check-parity.mjs`) kept green.

## 4. Design — one per-voice `VoiceLocale`

### 4.1 Storage (additive migration)

Add a single nullable JSONB column to the existing voice row:

```sql
ALTER TABLE content_tool.personas
  ADD COLUMN IF NOT EXISTS locale jsonb NOT NULL DEFAULT '{}'::jsonb;
```

No new table. `personas` already *is* the voice (keyed by `slug`, loaded by
`load_persona`). RLS/grants unchanged (column inherits table policy). Mirror the
column read in the TS `postgres.js` persona query.

### 4.2 Shape (`VoiceLocale`, defaults reproduce HK ZH)

A small Pydantic model (+ TS interface) with **defaults that exactly reproduce
`bowtie-editor` today** — so an empty `{}` locale is a no-op:

| Field | Default (HK ZH) | Used by |
|---|---|---|
| `output_language` | `"香港繁體中文"` | `{output_language}` token in templates |
| `brand_name` | `"Bowtie"` | `{brand_name}` token in partials/templates |
| `market` | `"Google 香港繁中"` | `{market}` token; `topic_hot` prompt |
| `sources_heading` | `null` → fall back to script detection | `resolve_citations`, `render_html`, `audit_checks` |
| `faq_heading` | `"常見問題"` | `render_html` FAQ fallback/split |
| `ui_lang` | `"zh-Hant"` | selects persona-block label set |

`sources_heading=null` preserves today's Traditional↔Simplified auto-detection
for the zh voices; a non-Chinese voice sets it explicitly (e.g. `"Sources"`).

### 4.3 Example: `bowtie-en-my`

```json
{
  "output_language": "English (Malaysia)",
  "brand_name": "Bowtie",
  "market": "Google Malaysia (gobowtie.com/my)",
  "sources_heading": "Sources",
  "faq_heading": "Frequently Asked Questions",
  "ui_lang": "en"
}
```

### 4.4 Threading (the only code touch-points)

1. **`writer.build_system_prompt`** — after the existing `{persona_block}` /
   `{today_date}` / `{source_policy_block}` replaces, add
   `.replace("{brand_name}", loc.brand_name)`, `{output_language}`, `{market}`.
   Backward-compatible: templates with no token → no-op.
2. **Shared partials/templates** — swap literal `Bowtie` → `{brand_name}` and
   `香港繁體中文` → `{output_language}` in `_writer_brand_block`, `_writer_schema`,
   and the `writer_*` / `outline_*` shared bodies. Reseed via migration. Because
   the HK-ZH defaults equal the old literals, the assembled prompt for
   `bowtie-editor` is **byte-identical** (assert in a golden test).
3. **`PersonaPack.to_prompt_block(context_text, *, labels)`** — accept a label
   set; pick `zh-Hant` (current strings, incl. a neutralised "required
   phrasings" label) or `en` from `locale.ui_lang`. Default `zh-Hant` → no-op
   for HK ZH.
4. **`resolve_citations._sources_heading_for(markup, *, configured)`** — return
   `configured` when set, else current char-count detection.
5. **`render_html`** — accept `faq_heading` / `sources_heading`; use them for the
   fallback heading and the sources/FAQ split tokens (still self-heals from the
   model's own heading first).
6. **`audit_checks`** — compare the rendered sources `<h2>` against the voice's
   configured heading (defaulting to accepting both Chinese scripts, as today).
7. **`topic_hot.py`** — interpolate `{market}` instead of the literal
   `Google 香港繁中`.

Call sites 4–7 all have run context → load voice via `run.persona` →
`load_persona().locale`. Pass the resolved `VoiceLocale` down; do not re-query
per row.

## 5. Acceptance criteria

- **No-op for HK ZH:** assembled writer/outline/topic prompts and the rendered
  HTML for `bowtie-editor` are byte-identical before/after (golden test, both
  backends).
- **English voice clean:** `bowtie-en-my` produces an English `## Sources`
  heading (not `資訊來源`), passes `audit_checks`, and its system prompt contains
  no Traditional-Chinese scaffolding labels.
- **Parity gate green** over read-only routes after the TS mirror.
- **Single source of truth:** changing a voice's market/language/headings is a
  `personas.locale` edit + (optional) template token, never a code edit.
- Lint/type clean: `ruff`, `pyright` (no new errors in touched files), `tsc`,
  `eslint`. No weakening of pyright/ruff config.

## 6. Rollout

1. Land foundation + both-backend changes behind defaults (no behaviour change).
2. Apply migration to **dev** (`db push --db-url "$DEV_POSTGRES_URL"`) then
   **prod** (`db push`); keep both in sync.
3. Set `bowtie-en-my.locale` in the **dev** DB (prod voices already copied to dev
   for testing — see plan §0) and run an English create + refresh end-to-end on
   the dev Workers stack; self-verify via `scripts/claude-debug`.
4. Promote to prod; set `bowtie-en-my` / `bowtie-zh-my` locales in prod DB.

## 7. Risks

- **TS/PY drift** — mitigated by the parity gate + golden tests in both backends.
- **Reseed clobbering per-voice template edits** — reseed touches `__shared__`
  rows only (the per-voice rows are untouched); assert row counts pre/post.
- **`sources_heading` mis-set for a zh voice** — leaving it `null` keeps the safe
  auto-detection; only set it for non-Chinese voices.

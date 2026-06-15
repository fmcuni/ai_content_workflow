# Bowtie AI Content Tool — Update Article Route (MVP) — Design Spec

| Field | Value |
|---|---|
| Date | 2026-05-21 |
| Status | Draft, awaiting user review |
| Owner | Franco (product) + engineering team |
| Reference | n8n workflow `AI Content Creation - 2) Update article (1).json` |
| Target | Internal Bowtie content team; runs locally for MVP |

## 1. Goal

Replace the existing n8n "Update Article" workflow with a Python + LangGraph application that:

- Reads an existing published Bowtie blog article and a topic/keywords brief.
- Performs SERP-based gap analysis against the top 5 Google HK 繁中 organic results.
- Decides between `small_refresh` (≤30% rewrite, preserve 70%+ of structure) and `full_rewrite` (rebuild structure).
- Produces a section outline, drafts the article in HK 繁中, audits it for compliance/brand/format, and publishes it to WordPress as a Draft.
- Gives editors two human-in-the-loop gates (post-strategy, post-production) and keeps every artefact queryable for compliance review.

## 2. Scope

### In scope (MVP)

- **Update existing article** route only. Both `small_refresh` and `full_rewrite` modes.
- Four agents: `gap_analysis`, `outline`, `writer`, `audit` — all on Gemini 3.5 Flash.
- Deterministic citation resolver + source-policy filter.
- Deterministic Markdown → WordPress HTML renderer (shortcodes, Bowtie FAQ widget HTML, JSON-LD FAQPage).
- Postgres persistence (state + checkpoints + compliance log).
- Local-only deploy for MVP. Postgres on Cloud post-MVP.
- Next.js + FastAPI web UI with live progress (SSE).
- Push to WordPress as **Draft** (never auto-publish in MVP). Editor flips status to publish inside WP.
- Two HITL gates: post-strategy (optional, on by default) and post-production (mandatory).

### Out of scope (deferred to fast-follow or v2)

- **Create new article** route (the "Pick ideas → Topic list → Outline → Write" branch of the flow diagram).
- **Research agent** with PDF / proprietary-data ingestion.
- **Translate** to other locales (繁中 → 簡中 / EN).
- **Image generation / featured image** (manual for MVP).
- **GA / Search Console performance feedback loop** ("Doing well" vs "Needs improvement" branch of the diagram).
- **Auto-publish** (Draft only in MVP).
- **Scheduled re-review** (2-week / 1-month) — needs a cron layer, deferred.

## 3. High-level architecture

### Process layout

```
┌─────────────────┐       ┌──────────────────────┐
│ Next.js (local) │ HTTP  │   FastAPI service    │
│   - Trigger UI  │◀─────▶│   - /runs (POST)     │
│   - HITL UI     │  SSE  │   - /runs/{id}/...   │
│   - Diff view   │◀──────│   - /runs/{id}/events│
└─────────────────┘       └─────────┬────────────┘
                                    │ invokes
                                    ▼
                          ┌──────────────────────┐
                          │   LangGraph engine    │
                          │ ┌──────────────────┐ │
                          │ │ Strategy subgraph │ │
                          │ └──────────────────┘ │
                          │ ┌──────────────────┐ │
                          │ │Production subgraph│ │
                          │ └──────────────────┘ │
                          └─────────┬────────────┘
                                    │
                                    ▼
                          ┌──────────────────────┐
                          │ Postgres (local now,  │
                          │ cloud post-MVP)       │
                          │ - langgraph.*         │
                          │ - content_tool.*      │
                          └──────────────────────┘
                                    │
            ┌───────────────────────┼─────────────────────┐
            ▼                       ▼                     ▼
   ┌────────────────┐   ┌──────────────────┐   ┌──────────────────┐
   │ Gemini API     │   │ WordPress REST   │   │ Vertex redirect  │
   │ (3.5 Flash)    │   │ /wp-json/wp/v2/* │   │ resolution (HEAD)│
   │ + googleSearch │   │                  │   │                  │
   │ + urlContext   │   │                  │   │                  │
   └────────────────┘   └──────────────────┘   └──────────────────┘
```

### Root graph

```
START
  ↓
trigger ─→ fetch_article ─→ Strategy subgraph ─→ HITL_1 ─→ Production subgraph ─→ HITL_2 ─┬─(approve)─→ persist ─→ publish_to_wordpress ─→ END
                                                                                          ├─(request_changes)─→ spawn_new_run ─→ END
                                                                                          └─(reject)─→ END
```

### Strategy subgraph (Gap → Outline)

```
START → gap_analysis → outline → END
```

### Production subgraph (Writer ⇄ Audit + Render)

```
START → writer → resolve_citations → render_html → audit ─(pass)─→ END
                                                     │
                                                     │ (fail, iteration < 2)
                                                     ▼
                                                  writer  ← refine notes
```

The audit conditional edge:
- `audit.overall_pass == true` → exit subgraph
- `audit.overall_pass == false` AND `state.iteration < 2` → loop to writer with refine notes
- `audit.overall_pass == false` AND `state.iteration >= 2` → exit subgraph with failing audit attached; HITL_2 still runs

## 4. Agents

All four agents share a base Gemini config: model `gemini-3.5-flash`, `thinking_level = "high"`, `temperature = 1.0`, `responseMimeType = "application/json"`, `responseJsonSchema` (with `propertyOrdering` stripped — it triggers `INVALID_ARGUMENT` on `responseJsonSchema`).

All system prompts follow the Gemini 3 prompt-ordering convention: `[Context & source material]` → `[Main task instructions]` → `[Negative, formatting, and quantitative constraints]`. Critical "do not" rules go at the end of the prompt because Gemini 3.x can drop early negative constraints in long prompts.

### 4.1 `gap_analysis`

| | |
|---|---|
| Tools | `googleSearch` + `urlContext` |
| Input | `topic`, `keywords[]`, `article_url`, `edit_note`, `mode`, `today_date` |
| System prompt | Ported verbatim from n8n `Settings` node (HK 繁中 SEO strategist). See Appendix A. |
| Output schema | `target_query`, `top_pages[5]`, `current_article_assessment{strengths, outdated_points, weak_sections, structure_status}`, `content_gaps{missing_topics, missing_intents, freshness_gaps, semantic_gaps, source_trust_gaps, ai_extractability_gaps, hk_localization_gaps, faq_gaps}`, `recommended_outline`, `update_plan{must_add, must_update, must_remove, must_reorder, faq_to_add, facts_to_verify}`, `chosen_route`, `route_reason` |

**Route override logic** (applied after the LLM responds, not via prompt): if input `mode != "auto"`, force `state.chosen_route = mode` and keep the LLM's `route_reason` as supporting context. Mirrors the n8n `Override` switch.

### 4.2 `outline`

| | |
|---|---|
| Tools | None |
| Input | `gap_analysis` (full), `existing_article_markdown`, `chosen_route`, `acf_adv_id`, `acf_widget_id` |
| Purpose | Convert `gap_analysis.recommended_outline` (free text) into a structured section plan. Lets HITL_1 edit it cleanly and gives Writer a typed contract. |
| Output schema | `h1`, `meta_description_hint`, `sections[]: {heading_level, heading_text, action: keep\|update\|add\|remove\|reorder, intent, key_points[], format_hint: paragraph\|bullet\|numbered\|table, source_note}`, `faq_section[]: {question, answer_intent, action}`, `shortcode_positions: {adv_panel_after_section_index, page_widget_before: "faq"}` |

For `small_refresh`: outline preserves original H2 wording unless the gap analysis flags it. For `full_rewrite`: outline can restructure freely.

### 4.3 `writer`

| | |
|---|---|
| Tools | `googleSearch` + `urlContext` |
| Input | `outline`, `gap_analysis`, `existing_article_markdown`, `chosen_route`, `acf_adv_id`, `acf_widget_id`, `persona`, `brand_voice_pack`, `audit_notes` (only on refine loop) |
| System prompt | Two variants ported from n8n `small_refresh` and `full_rewrite` nodes. See Appendix A. Additions over n8n: persona block prepended; refine-loop awareness; citation policy (deny Bowtie + competitors, prefer GOV/EDU); placeholder rename `%%acf_adv%%` → `%%adv_panel%%`, `%%acf_widget%%` → `%%page_widget%%`. |
| Output schema | `{diagnose: string (~100字), markup: string (final Markdown), citation_intents: [{claim, why_cited}]}` |

**Citation behavior** (prompted, enforced by audit + deterministic post-processing):

- Actively use `googleSearch` + `urlContext` to verify time-sensitive facts (years, fees, policy, regulation, eligibility, medical or insurance content).
- Must NOT cite `bowtie.com.hk` or any other insurance company. Prefer `.gov.hk`, `.gov`, `.edu`, `.edu.hk`, and the WHO + HK regulatory bodies (IA, IFEC, HKMA, DH, CHP, HA, MPFA, VHIS).
- Exception: when `topic_category` is `community-response`, `patient-experience`, or `social-discussion`, community sources (Reddit, LIHKG, hk.discuss, baby-kingdom) are allowed.
- Writer does **NOT** author the `## 資訊來源` section. That section is built deterministically by `resolve_citations` from `groundingMetadata`.

**Persona handling**: `persona` is a key into `prompts/brand_voice/<persona>.yaml`. Pack contains: voice rules, banned terms (mainland-China vocabulary list), required HK phrasings, disclaimer templates, tone examples. Default persona = `bowtie-editor`. Doctor-bylined personas can be added by dropping new YAMLs.

### 4.4 `audit`

| | |
|---|---|
| Tools | None (LLM call is preceded by deterministic Python checks) |
| Input | `final_markup` (post-`render_html`), `gap_analysis.update_plan`, `citation_intents`, `citations[]` (resolved), `persona`, `today_date` |
| Output schema | `{overall_pass: bool, severity_summary: {high, medium, low}, findings[]: {id, category: format\|compliance\|voice\|coverage\|safety\|citation, severity: high\|medium\|low, location, issue, suggested_fix, must_fix: bool}}` |

**Two-stage audit**:

1. **Deterministic Python checks** (fast, free, run first):
   - Shortcode skeleton regex: `# H1` on line 1; `%%meta desc=...%%` on line 2; one `[adv_panel id="N"]` after first paragraph; one `[page_widget id="N"]` before FAQ; FAQ uses `<div class="editor__faq">` block (post-render); 資訊來源 is last section.
   - No raw HTML tags in Writer Markdown except in the allow-list block (HTML appears only after `render_html` converts).
   - JSON-LD FAQPage validates (Pydantic model derived from `schema.org/FAQPage`).
   - Citation policy: cross-check `citations[*].policy_decision` against source_policy.yaml. Any `policy_decision = "denied"` AND `was_displayed = true` → finding with `must_fix=true`.
   - Coverage: every item in `gap_analysis.update_plan.must_add / must_update / must_remove / faq_to_add` is either present in the markup (heuristic: keyword overlap ≥ threshold) or absent (flagged for LLM judgement).

2. **LLM check** (Gemini, structured JSON output, no tools):
   - Claim safety: no fabricated numbers, dates, regulations, medical or insurance claims.
   - Brand voice: matches persona pack (LLM rates 1–5 against tone examples).
   - HK localisation: lists any mainland-China-specific vocabulary present.
   - Coverage check (where heuristic was inconclusive).
   - `citation_intents[].claim` is supported by at least one allowed citation.

**Loop rule** (in graph code, not LLM-decided):
```python
if (findings.high > 0 or any(f.must_fix for f in findings)) and state.iteration < 2:
    return "writer"  # with refine notes
else:
    return "END"
```

Since `temperature = 1.0` is required by Gemini 3.x, audit determinism comes from the deterministic stage, not from low-temp judgement.

## 5. Citation handling & source policy

### `resolve_citations` node (deterministic Python, no LLM)

Pipeline per draft:

1. Read `response.candidates[0].groundingMetadata.groundingChunks[]` → each chunk has `web.uri` (Vertex redirect) + `web.title`.
2. For each chunk:
   - Check `content_tool.url_resolution_cache` by `vertex_uri`. If hit and not expired (7d TTL), use cached `final_url`.
   - Else HTTP HEAD with `follow_redirects=True`, 5s timeout, capture final URL. UPSERT cache.
   - Extract registrable apex via `tldextract`.
3. Apply `config/source_policy.yaml`:
   - If `domain` in `deny.domains` (and topic_category NOT in `community_exception.topic_categories`) → `policy_decision = "denied"`, `denied_reason = "bowtie_owned" | "competitor"`.
   - If domain in `community_exception.allowed_domains` AND topic_category matches → `policy_decision = "community_exception"`.
   - Else → `policy_decision = "allowed"`.
4. INSERT `content_tool.citations` row per chunk (allowed + denied — denied kept for audit visibility).
5. Build `## 資訊來源` HTML section deterministically from `policy_decision = "allowed"` and `policy_decision = "community_exception"` rows:
   ```html
   <h2>資訊來源</h2>
   <ol>
     <li><a href="https://www.ia.org.hk/tc/...">www.ia.org.hk</a></li>
     <li><a href="https://www.vhis.gov.hk/tc/...">www.vhis.gov.hk</a></li>
     ...
   </ol>
   ```
   Display text = registrable apex (e.g. `www.ia.org.hk`); href = final URL (never the Vertex redirect).
6. Append to `state.final_markup` (Markdown form: `## 資訊來源\n1. [www.ia.org.hk](https://...)\n...`). The Markdown→HTML pass in `render_html` will produce the final `<ol>`.

### `config/source_policy.yaml`

```yaml
deny:
  domains:
    - bowtie.com.hk
    - bowtie.com
    - manulife.com.hk
    - axa.com.hk
    - prudential.com.hk
    - aia.com.hk
    - china-life.com.hk
    - blueocean.com.hk
    - chubb.com.hk
    - zurich.com.hk
    - hsbclife.com.hk
    - fwd.com.hk
prefer:
  tlds: [".gov.hk", ".gov", ".edu", ".edu.hk"]
  domains:
    - ia.org.hk
    - ifec.org.hk
    - hkma.gov.hk
    - dh.gov.hk
    - chp.gov.hk
    - ha.org.hk
    - mpfa.org.hk
    - vhis.gov.hk
    - who.int
community_exception:
  topic_categories: [community-response, patient-experience, social-discussion]
  allowed_domains: [reddit.com, hk.discuss.com, lihkg.com, baby-kingdom.com]
```

## 6. WordPress integration

### `fetch_article` node (read)

- Input: `article_url` (any Bowtie blog URL).
- Pipeline (mirrors n8n's WP resolution logic):
  1. HTTP GET the article URL. Extract `Link` response header → parse `<...?p=NNNN>; rel=shortlink` → post id.
  2. If no shortlink header, fall back to slug extraction from URL path.
  3. GET `https://www.bowtie.com.hk/blog/wp-json/wp/v2/posts/{id}?_fields=id,slug,categories,link,title,status,author,content`.
  4. GET `/wp/v2/categories?include=<cat_ids>` for category names.
  5. Convert `content.rendered` HTML → Markdown via `markdownify` (custom rules to preserve `[adv_panel]` / `[page_widget]` / FAQ block).
- INSERT `content_tool.fetched_articles`.

### `publish_to_wordpress` node (write — after HITL_2 approval)

- Method:
  - `PUT /wp-json/wp/v2/posts/{wp_post_id}` if updating existing post (the Update flow's typical case).
  - `POST /wp-json/wp/v2/posts` if no `wp_post_id` (shouldn't happen in Update route; safety net).
- Auth: WordPress **Application Password**, per-editor, stored in env (`WP_APP_PASSWORD_{editor_id}`) or a secrets manager post-MVP.
- Payload:
  ```python
  {
    "title": render.seo_title,
    "content": render.html_body,                   # includes JSON-LD + shortcodes + FAQ widget
    "excerpt": runs.wp_excerpt,
    "status": runs.wp_publish_status,              # MVP default: "draft"
    "date": runs.wp_publish_at,                    # if status=="future"
    "slug": runs.wp_slug,                          # preserve existing on update by default
    "categories": runs.wp_category_ids,
    "tags": runs.wp_tag_ids,
    "author": runs.wp_author_id,
    "featured_media": runs.wp_featured_media_id,
    "meta": {
      "_yoast_wpseo_metadesc": render.meta_description,    # if Yoast detected
      "rank_math_description": render.meta_description     # if RankMath detected
    }
  }
  ```
- **SEO plugin detection** at startup: GET `/wp/v2/types/post` → inspect supported `meta` keys → choose which key to send. Cache result.
- **Idempotency / conflict safety**: include header `If-Unmodified-Since: <current post's modified_gmt>`. If WP returns 412 → run goes to `failed` with `wp_push_error = {code: "conflict"}`; editor sees a "WP post was modified externally — re-fetch and re-run?" prompt.
- Retry: 3× on 5xx and 429. No retry on 4xx (other than 412).
- On success: UPDATE `runs.wp_pushed_post_id`, `wp_pushed_at`, `wp_publish_status`, `status = "published"`.

### Safety guards (MVP)

- **Default status = "draft"** — never publish-live without explicit editor toggle in HITL_2.
- **Dry-run mode**: `POST /runs/{id}/dry-publish` returns the exact WP REST payload + final HTML preview without calling WP.
- **Staging WP target**: `WP_BASE_URL` env-switched. Default to staging; require explicit `WP_TARGET=production` env var to point at live.

## 7. HTML rendering & FAQ schema

### `render_html` node (deterministic Python, between `resolve_citations` and `audit`)

| Input fragment | Output |
|---|---|
| Writer Markdown line 1 `# Title` | Stripped from body; stored as `seo_title` |
| Writer Markdown line 2 `%%meta desc=...%%` | Stripped from body; stored as `meta_description` |
| Body Markdown | HTML via `markdown-it-py` with strict allow-list (no inline `<script>` / `<style>` / `<iframe>` etc.) |
| `%%adv_panel id=N%%` | `[adv_panel id="N"]` (WordPress shortcode, passes through HTML conversion as text) |
| `%%page_widget id=N%%` | `[page_widget id="N"]` |
| FAQ triplet `%%acf_faq type=q%% ... %%acf_faq type=a%% ... %%end%%` | Bowtie FAQ widget HTML (see below) + JSON-LD FAQPage script (prepended to body) |
| `## 資訊來源\n1. [...](...)` | `<h2>資訊來源</h2><ol><li>...</li></ol>` |

### FAQ rendering — exact target HTML

Matching the Bowtie theme reference (大腸癌 article):

```html
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "大腸癌各期數的存活率是多少？",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "根據醫管局香港癌症資料統計中心發布的分期存活率數據..."
      }
    },
    { "@type": "Question", "name": "...", "acceptedAnswer": {...} }
  ]
}
</script>

<h2>常見問題</h2>
<div class="editor__item editor__faq">
  <div class="e-faq__wrap">
    <div class="e-faq__list is--active">
      <div class="e-faq__head">大腸癌各期數的存活率是多少？<span class="e-faq__icon icon-add"></span></div>
      <div class="e-faq__body" style="display: block;">
        <p>根據醫管局香港癌症資料統計中心...</p>
      </div>
    </div>
    <div class="e-faq__list">
      <div class="e-faq__head">大腸癌可以完全根治嗎？<span class="e-faq__icon icon-add"></span></div>
      <div class="e-faq__body"><p>可以。若能在早期...</p></div>
    </div>
    <!-- ... -->
  </div>
</div>
```

Rules:
- First `<div class="e-faq__list">` always carries class `is--active`, and its `<div class="e-faq__body">` gets inline `style="display: block;"`.
- All other items: no extra class, no inline style.
- Answer paragraphs wrapped in `<p>...</p>`. Multi-paragraph answers produce multiple `<p>` tags.
- JSON-LD block is inside `post_content` as the first child. Yoast/RankMath also do inline JSON-LD; works without plugin cooperation.

### `render_html` output (stored in `content_tool.renders`)

```python
{
  "seo_title": str,                     # WordPress post.title
  "meta_description": str,              # post.meta._yoast_wpseo_metadesc / rank_math_description
  "html_body": str,                     # post.content (JSON-LD + body + shortcodes + FAQ + 資訊來源)
  "faq_schema_jsonld": dict,            # the FAQPage object (also embedded in html_body)
  "excerpt_suggestion": str,            # first 160 chars of first paragraph, sanitised
  "slug_suggestion": str                # preserve existing slug on update; only suggest new for create
}
```

## 8. State, persistence & DB schema

### LangGraph state (TypedDict)

```python
class ContentToolState(TypedDict):
    # input (set at trigger)
    run_id: str
    article_url: str
    topic: str
    keywords: list[str]
    mode: Literal["auto", "small_refresh", "full_rewrite"]
    edit_note: str | None
    acf_adv_id: int
    acf_widget_id: int
    persona: str
    topic_category: str | None
    today_date: str

    # fetched
    existing_article_markdown: str | None
    wp_post_id: int | None
    wp_categories: list[dict] | None

    # strategy
    gap_analysis: dict | None
    outline: dict | None
    chosen_route: Literal["small_refresh", "full_rewrite"] | None

    # production
    writer_output: dict | None
    grounding_chunks: list[dict] | None
    citations: list[dict] | None
    render: dict | None                   # seo_title, meta_description, html_body, ...
    final_markup: str | None              # Markdown, post-資訊來源 append
    audit_findings: dict | None
    iteration: int

    # HITL
    hitl_1_decision: str | None
    hitl_1_edits: dict | None
    hitl_2_decision: str | None
    hitl_2_notes: str | None

    # lifecycle
    status: str
    error: dict | None
```

### Postgres — `content_tool.*` schema

```sql
CREATE SCHEMA content_tool;

-- one row per run
CREATE TABLE content_tool.runs (
  run_id              UUID PRIMARY KEY,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by          TEXT NOT NULL,
  status              TEXT NOT NULL,
  article_url         TEXT NOT NULL,
  topic               TEXT NOT NULL,
  keywords            JSONB NOT NULL,
  mode                TEXT NOT NULL,
  edit_note           TEXT,
  acf_adv_id          INT NOT NULL,
  acf_widget_id       INT NOT NULL,
  persona             TEXT NOT NULL,
  topic_category      TEXT,
  today_date          DATE NOT NULL,
  chosen_route        TEXT,
  iteration_count     INT NOT NULL DEFAULT 0,
  hitl_1_decision     TEXT,
  hitl_1_notes        TEXT,
  hitl_2_decision     TEXT,
  hitl_2_notes        TEXT,
  approved_at         TIMESTAMPTZ,
  approved_by         TEXT,

  -- WordPress publish metadata (filled at HITL_2)
  wp_author_id        INT,
  wp_category_ids     JSONB,
  wp_tag_ids          JSONB,
  wp_featured_media_id INT,
  wp_slug             TEXT,
  wp_excerpt          TEXT,
  wp_publish_status   TEXT,             -- draft | future | publish
  wp_publish_at       TIMESTAMPTZ,
  wp_pushed_post_id   INT,
  wp_pushed_at        TIMESTAMPTZ,
  wp_push_error       JSONB,

  error               JSONB
);
CREATE INDEX runs_status_idx     ON content_tool.runs(status);
CREATE INDEX runs_created_at_idx ON content_tool.runs(created_at DESC);

CREATE TABLE content_tool.fetched_articles (
  run_id              UUID PRIMARY KEY REFERENCES content_tool.runs(run_id) ON DELETE CASCADE,
  fetched_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  wp_post_id          INT,
  wp_categories       JSONB,
  raw_html            TEXT,
  markdown            TEXT NOT NULL
);

CREATE TABLE content_tool.gap_analyses (
  run_id              UUID PRIMARY KEY REFERENCES content_tool.runs(run_id) ON DELETE CASCADE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  model               TEXT NOT NULL,
  thinking_level      TEXT NOT NULL,
  payload             JSONB NOT NULL,
  tokens_in           INT, tokens_out INT, thinking_tokens INT,
  latency_ms          INT,
  raw_response        JSONB
);

CREATE TABLE content_tool.outlines (
  run_id              UUID PRIMARY KEY REFERENCES content_tool.runs(run_id) ON DELETE CASCADE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload             JSONB NOT NULL,
  edited_by_human     BOOLEAN NOT NULL DEFAULT FALSE,
  human_edits         JSONB
);

CREATE TABLE content_tool.drafts (
  draft_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id              UUID NOT NULL REFERENCES content_tool.runs(run_id) ON DELETE CASCADE,
  iteration           INT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  diagnose            TEXT NOT NULL,
  markup_raw          TEXT NOT NULL,
  final_markup        TEXT,
  citation_intents    JSONB NOT NULL,
  grounding_chunks    JSONB,
  tokens_in           INT, tokens_out INT, thinking_tokens INT,
  latency_ms          INT,
  UNIQUE (run_id, iteration)
);

CREATE TABLE content_tool.citations (
  citation_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id            UUID NOT NULL REFERENCES content_tool.drafts(draft_id) ON DELETE CASCADE,
  chunk_idx           INT NOT NULL,
  vertex_uri          TEXT NOT NULL,
  final_url           TEXT,
  domain              TEXT,
  title               TEXT,
  policy_decision     TEXT NOT NULL,
  denied_reason       TEXT,
  was_displayed       BOOLEAN NOT NULL DEFAULT FALSE,
  resolution_error    TEXT,
  resolved_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX citations_draft_id_idx ON content_tool.citations(draft_id);

CREATE TABLE content_tool.url_resolution_cache (
  vertex_uri          TEXT PRIMARY KEY,
  final_url           TEXT,
  domain              TEXT,
  resolved_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at          TIMESTAMPTZ NOT NULL,
  error               TEXT
);

CREATE TABLE content_tool.renders (
  render_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id            UUID NOT NULL REFERENCES content_tool.drafts(draft_id) ON DELETE CASCADE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  seo_title           TEXT NOT NULL,
  meta_description    TEXT NOT NULL,
  html_body           TEXT NOT NULL,
  faq_schema_jsonld   JSONB,
  excerpt_suggestion  TEXT,
  slug_suggestion     TEXT
);

CREATE TABLE content_tool.audit_runs (
  audit_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id            UUID NOT NULL UNIQUE REFERENCES content_tool.drafts(draft_id) ON DELETE CASCADE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  overall_pass        BOOLEAN NOT NULL,
  severity_high       INT NOT NULL DEFAULT 0,
  severity_medium     INT NOT NULL DEFAULT 0,
  severity_low        INT NOT NULL DEFAULT 0,
  llm_findings        JSONB NOT NULL,
  deterministic_findings JSONB NOT NULL,
  tokens_in           INT, tokens_out INT,
  latency_ms          INT
);

-- Compliance audit trail (immutable; one row per persisted run)
CREATE TABLE content_tool.compliance_log (
  log_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id              UUID NOT NULL UNIQUE REFERENCES content_tool.runs(run_id),
  persisted_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  persona             TEXT NOT NULL,
  article_url         TEXT NOT NULL,
  wp_pushed_post_id   INT,
  chosen_route        TEXT NOT NULL,
  sources_cited       TEXT NOT NULL,
  sources_denied      TEXT,
  audit_overall_pass  BOOLEAN NOT NULL,
  audit_severity_summary JSONB NOT NULL,
  approver_email      TEXT NOT NULL,
  iteration_count     INT NOT NULL,
  gemini_model        TEXT NOT NULL,
  total_tokens        INT,
  est_cost_usd_cents  INT
);

-- Evals (run by CI + nightly cron)
CREATE TABLE content_tool.evals (
  eval_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ran_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  metric              TEXT NOT NULL,
  fixture_id          TEXT NOT NULL,
  run_id              UUID,
  score               NUMERIC,
  pass                BOOLEAN,
  judge_notes         JSONB,
  commit_sha          TEXT NOT NULL
);
```

LangGraph checkpointer tables live in the same database, separate schema (default `public` or explicit `langgraph`). Initialised once via `PostgresSaver.from_conn_string(...).setup()` at app startup.

### Migrations

- App schema: **Alembic** under `migrations/`.
- Checkpointer schema: managed by LangGraph's `PostgresSaver.setup()`.

## 9. Data flow & HITL gates

### Single-run trace (happy path)

| Step | Node | Side effects |
|---|---|---|
| T+0 | `trigger` (API handler) | INSERT runs (status=pending); SSE opened |
| T+1s | `fetch_article` | INSERT fetched_articles; UPDATE runs.status=strategy |
| T+1–40s | `gap_analysis` | INSERT gap_analyses; UPDATE runs.chosen_route |
| T+40–55s | `outline` | INSERT outlines |
| T+55s | **HITL_1** | UPDATE runs.status=hitl_1; LangGraph `interrupt()` |
| T+?+ | (editor) | UPDATE outlines (if edited); UPDATE runs.hitl_1_decision; resume |
| T+? | `writer` (iter=0) | INSERT drafts(iteration=0) |
| T+? | `resolve_citations` | UPSERT url_resolution_cache; INSERT citations; UPDATE drafts.final_markup |
| T+? | `render_html` | INSERT renders |
| T+? | `audit` | INSERT audit_runs |
| T+? | (refine loop if needed) | iter=1 / iter=2 drafts |
| T+? | **HITL_2** | UPDATE runs.status=hitl_2; LangGraph `interrupt()` |
| T+? | (editor) | UPDATE runs (wp_*, hitl_2_decision, approved_at/by); resume |
| T+? | `persist` | UPDATE runs.status=persisted |
| T+? | `publish_to_wordpress` | PUT WP; UPDATE runs.wp_pushed_post_id; INSERT compliance_log |

### HITL gate decisions

| Gate | Decision | State effect | Graph effect |
|---|---|---|---|
| HITL_1 | Approve | none | continue to Production |
| HITL_1 | Edit outline | `outline.payload` mutated; `outlines.edited_by_human=true` | continue with edited outline |
| HITL_1 | Override route | `state.chosen_route` flipped | continue with new route |
| HITL_1 | Cancel | `runs.status="cancelled"` | END |
| HITL_2 | Approve | `runs.hitl_2_decision="approve"`; WP fields populated | continue to publish |
| HITL_2 | Request changes (with notes) | new `runs` row referencing this run via `metadata.parent_run_id`; `hitl_2_notes` becomes new run's `edit_note` | END this run; new run starts fresh |
| HITL_2 | Reject | `runs.status="rejected"` | END |

"Request changes" deliberately starts a fresh run rather than re-entering the writer loop — by HITL_2 the editor's feedback is too rich to round-trip as audit_notes, and a fresh gap analysis is usually warranted.

### HITL_2 editor controls (UI scope)

The Next.js HITL_2 page exposes:
- HTML body (TipTap rich editor with shortcode-aware nodes; raw HTML toggle)
- SEO title (post.title)
- Meta description (160-char limit shown)
- Slug (preserved by default on update; editor can change)
- Excerpt (160-char suggestion editable)
- Author (dropdown from `/wp/v2/users`, default = persona-mapped user, fallback = run creator)
- Categories (multi-select; pre-filled from fetched_articles.wp_categories)
- Tags (multi-select with autocomplete from `/wp/v2/tags`)
- Featured image (URL or upload → `/wp/v2/media`)
- Publish status: Draft / Schedule / Publish (MVP default = Draft)
- Schedule date+time (if Schedule)
- FAQ items: add / edit / delete / reorder (regenerates HTML widget + JSON-LD)
- "Why this change" rationale (auto-summary of `diagnose` + audit findings; editor can edit)
- Diff view (current published HTML vs new HTML, side-by-side)
- Internal-link suggestions (3–5 anchors matched from `gap_analysis.semantic_entities` against a Bowtie URL sitemap — editor inserts via TipTap)
- Cost meter for this run

### SSE event contract

```
{
  "event": "<node>.start" | "<node>.done" | "<node>.error" | "hitl.interrupted",
  "run_id": str,
  "iteration": int,
  "timestamp": ISO8601,
  "payload": object  // node-specific
}
```

### Concurrency

- One Gemini call in flight per run (graph is sequential within a run).
- Multiple runs concurrent at process level, bounded by asyncio semaphore (default 4) to stay within Gemini quota.
- `resolve_citations` HTTP HEAD fan-out: `asyncio.gather` with 8-way concurrency, 5s per-URL timeout. Individual failures don't fail the node.

### Idempotency

- `run_id` is UUID, generated at trigger. Re-posting the same trigger spawns a new run; nothing is shared between runs except the `url_resolution_cache`.
- Node-level idempotency from LangGraph: a crash mid-graph resumes from the last checkpoint without re-executing completed nodes.

## 10. Error handling & observability

### Retry policy

| Failure | Behavior |
|---|---|
| Gemini `429` / `500` / `503` / `DEADLINE_EXCEEDED` | Backoff 2s → 8s → 32s, max 3 attempts |
| Gemini `400 INVALID_ARGUMENT` (schema rejected) | No retry; surface as `schema_error` (code fix needed) |
| Gemini `SAFETY_BLOCK` | No retry; surface with safety ratings; editor decides |
| Malformed JSON despite responseJsonSchema | One reflection retry, then fail node |
| Truncated output (`finishReason: MAX_TOKENS`) | One concise-retry, then fail node |
| Pydantic validation of LLM output fails | One reflection retry with validation error context, then fail node |
| WP REST fetch failure | 3× backoff retry; hard fail if persistent |
| WP REST push 5xx / 429 | 3× backoff retry |
| WP REST push 412 (`If-Unmodified-Since` conflict) | No retry; surface as conflict; editor re-fetches |
| WP REST push other 4xx | No retry; surface raw error |
| Vertex redirect resolution failure | No retry (per-URL); resolution_error stored; audit flags `citation:unresolved` |
| Postgres transient | psycopg pool pre_ping; node raises and is replayed via checkpoint |
| HTML sanitisation rejects writer output (raw `<script>` outside our injection) | Hard fail at `render_html`; surface `security:html_sanitization_failed`; run halts pending human review |

LangGraph `RetryPolicy` is configured per node; non-retryable errors bypass retry via exception-type check.

### Observability stack

1. **Structured logs** — JSON lines to stdout. `{ts, level, run_id, node, event, model, thinking_level, tokens_in, tokens_out, latency_ms}`. Dev: pretty-print via `rich`. Prod: pipe to whatever Bowtie's log stack is.
2. **OpenTelemetry tracing** — one trace per run; spans per node carry tokens + latency + cost. Local dev: Jaeger Docker. Cloud later: GCP Cloud Trace via OTLP exporter.
3. **Cost meter** — Python computes per-call cost from `tokens_in / tokens_out / thinking_tokens` × Gemini 3.5 Flash prices loaded from `config/pricing.yaml` (hand-maintained, no deploy needed for price changes). UI shows per-agent and per-run totals.
4. **Compliance log** — `content_tool.compliance_log` (see schema). CSV-exportable from UI for IA regulator review.

## 11. Testing & evals

### Code tests (pytest, hermetic, every PR)

| Layer | Coverage |
|---|---|
| Unit | `source_policy.is_allowed`, `resolve_citations.resolve_one` (respx mocks), `render_html` (golden files), audit deterministic checks, Pydantic models for every LLM response shape, WP REST adapter (respx) |
| Node integration | Each node with fake Gemini returning canned responses; assert Pydantic validates, DB rows written, state mutated. Postgres for tests via `testcontainers-python`. |
| End-to-end graph | One happy-path run + one refine-loop run, all-fake-LLM; assert full state machine, SSE events fire, all DB rows present. |

### LLM evals (promptfoo, weekly + on prompt-change)

**Reference evals** (deterministic graders):
- `gap_analysis.chosen_route` matches gold label (20 hand-labeled pairs)
- `gap_analysis.top_pages.length == 5` (schema check)
- Writer output JSON-validates 100% (30 runs)
- `render_html` produces valid HTML5 + JSON-LD validates against `schema.org/FAQPage`
- Citation domains all in allow-list (sampled from last 30 prod runs)
- Refine loop converges within 2 iterations (sampled from last 30 prod runs)

**LLM-as-judge evals** (separate Gemini run, no prompt leakage):
- Brand-voice adherence (1–5 vs persona pack; target mean ≥4)
- Coverage of `update_plan.must_add`
- Citation-claim alignment (judge re-reads cited URLs via urlContext to confirm support)
- HK localisation (lists any mainland-China vocabulary present)
- Factuality on time-sensitive claims (judge with grounding re-verifies)

### Fixtures

- `tests/fixtures/articles/` — 20 published Bowtie articles in markdown, hand-curated across topic categories.
- `tests/fixtures/gemini_responses/` — sanitised real Gemini responses for replay.
- `tests/fixtures/gold_labels/` — `route.csv`, `must_address_items.csv`, owned by content team.

### CI shape

| Trigger | Runs | Time budget |
|---|---|---|
| Every PR | Lint (`ruff`), type-check (`pyright`), unit + integration + E2E (all fake-LLM), reference evals | ≤ 5 min |
| PR labeled `prompt-change` | Above + 5-fixture judge-eval sample | ≤ 15 min |
| Nightly cron | Full eval suite + last 30 prod runs sampled | overnight |
| Manual `evals.yml` workflow | Full eval suite on demand | n/a |

### Not tested in MVP

- Load testing (single-tenant, ~50 runs/day expected).
- Browser E2E via Playwright on Next.js (manual QA for HITL flows in MVP).
- WP push against real WP in CI (mocked; one manual smoke test against staging WP before each release).
- Multi-locale outputs (out of scope until v2).

## 12. Configuration & secrets

### Env vars (MVP)

```
# Database
POSTGRES_URL=postgresql://localhost:5432/content_tool

# Gemini
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-3.5-flash
GEMINI_THINKING_LEVEL=high

# WordPress
WP_BASE_URL=https://staging.bowtie.com.hk        # default staging; toggle to prod via WP_TARGET
WP_TARGET=staging                                 # staging | production
WP_APP_PASSWORD=...                               # per-editor; future: secrets manager

# Observability
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
LOG_LEVEL=info

# Concurrency
MAX_CONCURRENT_RUNS=4
```

### Config files (under `config/`)

- `source_policy.yaml` — deny / prefer / community_exception (full content in Section 5)
- `pricing.yaml` — Gemini per-million-token prices (input, output, thinking) for cost meter
- `personas/bowtie-editor.yaml` — default persona pack: voice rules, banned terms, HK phrasings, disclaimer templates, tone examples
- `personas/dr-byline-template.yaml` — template for doctor personas (one file per doctor)
- `persona_to_wp_user.yaml` — `{persona: wp_user_id}` map for HITL_2 default author

### Secrets handling

- MVP: env vars from `.env.local` (gitignored). One `.env.example` checked in.
- Post-MVP: GCP Secret Manager (matches expected cloud deployment target).
- `WP_APP_PASSWORD_*` per-editor secrets stored separately; never in repo or logs.

## 13. "Good to have" — fast-follow list

Built into MVP only if cheap; otherwise spec'd here for follow-up:

| Idea | MVP? | Notes |
|---|---|---|
| Diff view (current HTML vs new HTML) | ✅ MVP | Editor confidence; uses `difflib` + Monaco diff component |
| Internal-link suggestions | ✅ MVP | Match gap_analysis semantic entities against Bowtie URL sitemap |
| Slug + excerpt auto-suggest (rule-based) | ✅ MVP | First-160-chars / H1-derived |
| Reading time + word count | ✅ MVP | Trivial |
| Cost meter per run | ✅ MVP | Section 10 |
| Compliance log CSV export | ✅ MVP | Section 8 schema |
| "Why this change" rationale auto-summary | ✅ MVP | Cheap, useful |
| Auto-detect SEO plugin (Yoast / RankMath) | ✅ MVP | Section 6 |
| Dry-run mode | ✅ MVP | Section 6 |
| Image alt-text suggestions (Gemini Vision) | 🟡 fast-follow | After Writer output stabilises |
| Open Graph title/description | 🟡 fast-follow | When OG copy differs from SEO |
| Scheduled re-review (2-week / 1-month cron) | 🟡 fast-follow | Closes the analytics loop in the diagram |
| Multi-locale translate (繁中 → 簡中 / EN) | ❌ v2 | New subgraph |
| A/B title test | ❌ v2 | Low priority at this stage |
| GA / Search Console performance hook | ❌ v2 | Feeds back into next review run |
| Featured image generation (Imagen) | ❌ v2 | Manual upload for MVP |

## 14. Open questions

(None blocking MVP — listing here for future decisions.)

- **Editor identity model** — MVP relies on email-based `created_by` from a header. Need real SSO (Google Workspace OIDC) before cloud deploy.
- **WP user impersonation** — when persona maps to a different WP user than the editor running the tool, do we publish as that user even though the actual editor approved it? IA-regulatory question. MVP behavior: publish as persona user, log approver email in `compliance_log.approver_email` separately.
- **Gemini cost ceiling** — actual per-run cost at thinking_level=high with tools enabled is not yet measured. Will be tracked via cost meter from day 1; hard ceiling not implemented in MVP. Decide on ceiling once we have 1-2 weeks of real run data.
- **Bowtie SEO plugin** — confirm whether `bowtie.com.hk` runs Yoast or RankMath in production. Both code paths supported; auto-detection covers either.
- **Schema rejection mitigation** — gap_analysis schema is the deepest. If Gemini rejects it (`INVALID_ARGUMENT` for nesting), we shorten property names per the structured-output limitations note. Tested in CI.

## Appendix A — System prompt ports from n8n

Three prompts are ported from the n8n flow's `Settings`, `small_refresh`, and `full_rewrite` set-nodes. Restructured to Gemini 3's recommended `[Context]` → `[Task]` → `[Constraints]` order (negative constraints at the END of the prompt).

### A.1 Gap analysis system prompt

(Full verbatim port + Gemini 3 reordering — see `prompts/gap_analysis.md` in repo. Excerpt:)

```
你是香港繁體中文 SEO 內容更新策略助手...
今天是 {today_date}

你的任務：
1. 根據使用者提供的 topic 與 focus_keywords，判斷最合理的 Google 香港繁體中文搜尋查詢。
2. 在 Google 香港繁體中文搜尋結果中，撇除廣告後，找出 Organic 排名最高的 5 個頁面。
3. 閱讀 existing_article_markdown，並比較上述 top 5 頁面，做 content gap analysis。
4. ...
6. 最後自動判斷應採用：
   - small_refresh：只補新資訊...保留 70% 以上原文結構；估計整體改動不應超過 30%
   - full_rewrite：現有文章結構已落後...
...

輸出要求（負面約束放在最後）：
- 所有文字使用香港繁體中文
- route_reason 要具體，不可只寫「內容過時」或「需要更新」
- recommended_outline 必須可直接供 writer 使用
- top_pages 必須是 5 個，不多不少
- 不要捏造無法核實的年份或事實
- 只輸出 JSON
```

### A.2 `small_refresh` writer system prompt

Ported verbatim from n8n `small_refresh` set-node. Additions for new design:
- Persona block prepended (loaded from `personas/<persona>.yaml`).
- Citation policy block (deny Bowtie + competitors, prefer GOV/EDU; community exception clause).
- Placeholder rename: `%%acf_adv%%` → `%%adv_panel%%`, `%%acf_widget%%` → `%%page_widget%%`.
- Instruction added: "不要在 markup 中手寫 `## 資訊來源` 區塊；該區塊由後處理流程根據 grounding metadata 自動生成"
- Refine-loop awareness: if `audit_notes` present, address each finding without changing already-good sections.

### A.3 `full_rewrite` writer system prompt

Same additions as A.2; otherwise verbatim from n8n `full_rewrite` set-node.

### A.4 Audit system prompt (new)

New prompt; not derived from n8n (which had no separate audit). See `prompts/audit.md`. Skeleton:

```
你是 Bowtie 內容審核員，獨立審核已撰寫的文章...
你會收到：
- final_markup (HTML/Markdown)
- gap_analysis.update_plan
- citation_intents
- citations[] (resolved)
- persona pack

任務：
1. 評估 claim 安全性
2. 評估品牌語氣是否符合 persona pack
3. 評估香港在地化
4. 評估 update_plan 中 must_* 項目是否已處理
5. 評估 citation_intents 是否被 allowed citations 支持

輸出要求（負面約束放在最後）：
- 嚴格依照 schema 輸出 JSON
- 每個 finding 必須附 location 與 suggested_fix
- 不要重新撰寫文章，不要建議全文重寫
- must_fix=true 只可用於高嚴重度問題
```

## Appendix B — Source policy YAML

See full content in Section 5.

## Appendix C — WordPress REST contracts

### Fetch (existing post)

```
GET /wp-json/wp/v2/posts/{id}?_fields=id,slug,categories,link,title,status,author,content,modified_gmt
GET /wp-json/wp/v2/categories?include=<cat_ids>&_fields=id,name,slug
GET /wp-json/wp/v2/users?_fields=id,name,slug,email   (HITL_2 dropdown)
GET /wp-json/wp/v2/tags?search=...&_fields=id,name,slug  (HITL_2 autocomplete)
GET /wp-json/wp/v2/types/post (SEO plugin detection — once at startup, cached)
```

### Publish (update existing draft / new draft)

```
PUT /wp-json/wp/v2/posts/{wp_post_id}
Headers:
  Authorization: Basic <base64(editor:app_password)>
  If-Unmodified-Since: <current modified_gmt>
Body:
  {
    "title": "...",
    "content": "...",            // html_body with JSON-LD + shortcodes + FAQ
    "excerpt": "...",
    "status": "draft",           // MVP default
    "slug": "...",
    "categories": [12, 34],
    "tags": [7, 19],
    "author": 5,
    "featured_media": 42,
    "meta": {
      "_yoast_wpseo_metadesc": "..." OR "rank_math_description": "..."
    }
  }
```

Expected responses:
- `200` → success; capture `link`, `modified_gmt` for next conflict check.
- `412` → conflict; surface to editor.
- `5xx / 429` → retry per Section 10.
- `4xx` other → surface raw error.

### Media upload (featured image)

```
POST /wp-json/wp/v2/media
Headers:
  Authorization: Basic ...
  Content-Disposition: attachment; filename="..."
  Content-Type: image/jpeg
Body: <binary>

→ returns media id for featured_media field
```

---

## Implementation order (preview — not the implementation plan)

This is just to show the spec is shippable in small increments. The actual implementation plan comes from invoking `writing-plans`.

1. Postgres schema + Alembic migrations + fake Gemini test scaffolding
2. `gap_analysis` node + fixtures + reference eval
3. `outline` node
4. Strategy subgraph + HITL_1 + FastAPI `/runs` skeleton
5. `writer` node + persona pack loading
6. `resolve_citations` node + source policy + URL cache
7. `render_html` node + FAQ widget + JSON-LD + golden tests
8. `audit` node (deterministic + LLM) + refine loop
9. Production subgraph + HITL_2 interrupt
10. Next.js shell (trigger form + run list + run detail with SSE)
11. HITL_1 UI (gap analysis + outline editor + decision buttons)
12. HITL_2 UI (TipTap editor + WP meta form + diff view + cost meter)
13. WP fetch adapter (existing post resolution)
14. WP push adapter + SEO plugin detection + idempotency
15. Compliance log export + CSV download
16. Dry-run mode + staging WP smoke test
17. promptfoo eval harness + nightly cron

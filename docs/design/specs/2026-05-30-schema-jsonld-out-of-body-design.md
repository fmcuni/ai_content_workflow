# Schema JSON-LD: deliver out-of-body (not inlined in WP content)

- **Date:** 2026-05-30
- **Status:** Implemented
- **Scope:** Backend render/audit/publish + DB + WordPress companion plugin

## Problem

`render_html` prepended the article's structured-data graph as a raw
`<script type="application/ld+json">` block to the top of the WordPress post
**content** (`final = jsonld_script + body_html`). In the Gutenberg / block
editor this produced a stray leading blank line and an "invalid markup"
warning, because a raw `<script>` is not valid block content.

External recommendation:

> For SEO/schema JSON-LD, don't insert it into article body. Output it through
> `wp_head`, Yoast schema hooks, RankMath hooks, or your custom theme/plugin.
> That will remove the empty line cleanly and avoid invalid editor markup.

## Decision

Carry the schema graph **out-of-band**:

1. `render_html` still builds the FAQPage / DefinedTermSet pieces but **no longer
   inlines any `<script>`**. It returns them as a list on
   `RenderResult.schema_jsonld` and persists them to the new
   `renders.schema_jsonld` JSONB column.
2. `publish` (and the dry-publish preview) JSON-encode that list into the
   `_bowtie_schema_jsonld` post meta key (constant `SCHEMA_JSONLD_META_KEY` in
   `wordpress/client.py`). The post `content` stays free of `<script>`.
3. A WordPress companion mu-plugin
   (`docs/wordpress/bowtie-schema-jsonld.php`) registers that meta
   (`show_in_rest`) and merges the pieces into the page `<head>` via the Yoast
   `wpseo_schema_graph` filter and the RankMath `rank_math/json_ld` filter, with
   a guarded `wp_head` fallback when neither SEO plugin is active.

Delivery mechanism chosen by the operator: **Yoast/RankMath schema filter**.

## Touched surfaces

| Area | Change |
|---|---|
| `db/models.py` + migration `20260530000001` | new nullable `renders.schema_jsonld` JSONB |
| `agents/render_html.py` | build `schema_jsonld`; drop in-body `<script>`; persist |
| `graph/production.py` | thread `schema_jsonld` into render state |
| `agents/audit_checks.py` | `det-fmt-jsonld` now checks FAQPage in `schema_jsonld` when the FAQ widget is present, not a `<script>` in body |
| `agents/audit.py` | pass `render.schema_jsonld` to deterministic checks |
| `agents/publish.py` + `api/routes/runs.py` (dry-publish, `/render`) | emit `_bowtie_schema_jsonld` meta / expose field |
| `docs/wordpress/bowtie-schema-jsonld.php` | WP-side `wp_head` delivery |

## Deliberately unchanged

- `refresh/deterministic_checks.py::check_missing_faq_jsonld` keys off **legacy**
  `[acf_widget …]` / `bowtie-faq` shortcodes in published *post content* — not our
  tool's `editor__faq` widget — and only ever sees `wp_post.content_html` (never
  `wp_head`). It therefore neither inspects our new out-of-band schema nor
  false-positives on pages published under this scheme. Left as-is.

## Operational note (REQUIRED before live SEO benefit)

The Python side only writes the meta. **Structured data will not appear on live
pages until `docs/wordpress/bowtie-schema-jsonld.php` is installed** into
`wp-content/mu-plugins/` on the target WordPress environment. Until then, schema
is persisted + sent but not rendered (no SEO regression vs. the empty body — the
old in-body script is simply gone).

## Test coverage

- `tests/unit/test_render_html.py` — body carries no `<script>`; FAQPage /
  DefinedTermSet land in `schema_jsonld`.
- `tests/unit/test_audit_deterministic.py` — FAQ widget without schema is
  flagged; no widget ⇒ no finding.
- `tests/integration/test_publish_node.py` — `_bowtie_schema_jsonld` meta sent,
  body free of `<script>`.
- `tests/integration/test_dry_publish.py` — preview mirrors the schema meta.

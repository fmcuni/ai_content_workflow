# 2026-05-28 — Writer Prompt Unification & Prompt-Editor UI

## Goals

1. **Unify** the three writer prompts (`writer_small_refresh.md`,
   `writer_full_rewrite.md`, `writer_create.md`) so shared text lives in
   exactly one place. Each route file keeps only its unique slice.
2. **Ship a UI** under `/prompts` for editorial staff to read and edit every
   template in `prompts/`, including the new shared partial(s), with safe
   server-side validation of required placeholders before each save.

Constraints kept identical to today's behavior: pyright strict, ruff clean,
async everywhere, no behavior change to the actual rendered prompt string
that hits Gemini.

---

## Part 1 — Unify writer prompts

### What is shared vs. unique (from current diff)

Shared by all 3 (verbatim today):
- Header scaffolding lines (`{persona_block}`, `今天是 {today_date}`)
- `{source_policy_block}` injection
- 品牌與銷售中立 block (lines ~27–29)
- shortcode + FAQ rule + 不可捏造 rule (inside 硬性規則 — wording identical,
  numbering differs because small_refresh prepends 3 H1/H2/meta rules)
- JSON-LD schema / Yoast dedup block (~20 lines, byte-identical)
- SEO & AI Search 優化要求 (4 items, identical)
- refine_notes block (identical)
- 輸出格式要求 sections 2–5 (markup structural rules, no-HTML rule,
  citation_intents rule) — identical

Unique per route:
- **Role line** ("small refresh 版本" / "full rewrite 版本" / "全新文章")
- **你會收到** list (create omits `existing_article_markdown` /
  `gap_analysis` as content sources)
- **目標** block (small_refresh has the 70%/30% guardrails; full_rewrite
  treats existing as background only; create writes from scratch)
- **硬性規則** prefix (small_refresh: 6 items including H1/meta/H2 limits;
  full_rewrite & create: 4 items, free to rewrite headings)
- **寫作要求** item 1 ("先理解 existing_article_markdown…" for refresh
  routes; "以 outline 為結構藍本…" for create) — rest of list identical
- **diagnose** sentence in 輸出格式要求 #1

### Proposed factoring — include directives

Add a minimal `{{include:NAME}}` mini-syntax resolved by the writer loader:

- `prompts/_writer_brand_block.md` — 品牌與銷售中立
- `prompts/_writer_schema.md` — JSON-LD / Yoast dedup
- `prompts/_writer_seo.md` — SEO & AI Search 優化要求
- `prompts/_writer_refine_notes.md` — refine_notes block
- `prompts/_writer_output_format_tail.md` — output-format items 2–5
  (structural rules, no-HTML, citation_intents, JSON-only footer). Item 1
  (diagnose) stays in each route file because the wording differs.

Underscore prefix marks them as partials, never registered in
`_TEMPLATE_FILES` as agent prompts — but still exposed in the editor (see
Part 2).

**硬性規則 stays inlined per route** (intentionally duplicated). The block
has two layers and neither layer is worth a partial:

- Items 1–3 in `writer_small_refresh.md` (H1 only small tweak, meta can
  rewrite, H2 wording 原則上不可改) are genuinely route-specific — they
  do not exist in `full_rewrite` or `create`, which start with "可重寫 /
  可自由撰寫 H1、meta、H2".
- The shortcode positions, FAQ 必須出現 block, and 不可捏造 rule are
  byte-identical across all three routes but numbered differently (4–6
  in small_refresh, 2–4 in the other two). Extracting them as a partial
  would force renumbering or bullet-only formatting, which changes the
  rendered string. The ~9 lines of duplication are cheaper than that.

### Loader changes (writer.py)

`build_system_prompt` already does `template.read_text(...).replace(...)`.
Insert one extra step before placeholder replacement:

```python
def _resolve_includes(text: str, *, base: Path, seen: frozenset[str] = frozenset()) -> str:
    pattern = re.compile(r"\{\{include:([A-Za-z0-9_./-]+)\}\}")
    def sub(m: re.Match[str]) -> str:
        name = m.group(1)
        if name in seen:
            raise ValueError(f"include cycle: {name}")
        sub_path = base / f"{name}.md"
        return _resolve_includes(
            sub_path.read_text(encoding="utf-8"),
            base=base,
            seen=seen | {name},
        )
    return pattern.sub(sub, text)
```

Apply once before the `{persona_block}` / `{today_date}` /
`{source_policy_block}` substitutions so includes can themselves contain
the same placeholders (they do not today, but future partials might).

### Refactored route file shape (example: small_refresh)

```
{persona_block}

你是香港網誌內容更新編輯。… small refresh …

今天是 {today_date}

你會收到:
- topic
- focus_keywords
- existing_article_URL
- existing_article_markdown
- outline
- acf_adv_id
- acf_widget_id
- gap_analysis
- (若有) refine_notes

目標：
- 保留現有文章 70% 以上原有結構…
- 整體改動量以不超過約 30% 為原則
- …

{source_policy_block}

{{include:_writer_brand_block}}

硬性規則：
1. H1 只可 small tweak…
2. meta description 可以重寫。
3. H2 wording 原則上不可改…
4. shortcode 位置…
5. FAQ 必須出現…
6. 不可捏造…
   (full_rewrite / create variants start at item 1 = "可重寫/可自由撰寫
   H1、meta、H2…" and renumber shortcode/FAQ/不可捏造 as 2/3/4. Stays
   inlined per route — see note above.)

{{include:_writer_schema}}

寫作要求：
1. 先理解 existing_article_markdown，再…
2. …

{{include:_writer_seo}}

{{include:_writer_refine_notes}}

輸出格式要求：
1. diagnose 使用香港繁體中文，約 100 字，說明為何採取此 small refresh 路線。
{{include:_writer_output_format_tail}}

只輸出符合 schema 的 JSON。
```

### Tests

- New `tests/unit/test_writer_prompt_compose.py`:
  - Each route file resolves to a string byte-equal to the pre-refactor
    file content (snapshot the current strings first, refactor, assert
    equality so we know we made a pure-structural change).
  - Cycle detection raises `ValueError`.
  - Missing partial filename raises `FileNotFoundError`.
- Existing `tests/unit/test_writer.py` and integration tests should pass
  unchanged.

---

## Part 2 — Prompt-editor UI

### Backend

Edit [content_tool/api/routes/prompts.py](content_tool/api/routes/prompts.py):

1. Expose partials in a new `_PARTIAL_FILES` map alongside the existing
   `_TEMPLATE_FILES` so the UI can edit them too. Both maps share the
   same `_PROMPT_DIR`.
2. Add **`GET /prompts/templates`** returning the list of `{template_id,
   filename, category, sha256}` — `category` ∈ {`agent`, `partial`} — so
   the UI can render two sections.
3. Add **`GET /prompts/templates/{template_id}/schema`** returning the
   required placeholder set for that template. Derive by parsing the file
   for `{name}` and `{{include:name}}` tokens; cross-reference against a
   per-agent allowlist (`PROMPT_PLACEHOLDERS["writer_small_refresh"] =
   {"persona_block", "today_date", "source_policy_block"}`) so unknown
   placeholders are flagged.
4. Add **`PUT /prompts/templates/{template_id}`** with body
   `{"template": "<full file content>", "expected_sha256": "<from GET>"}`.
   - Reject if `expected_sha256` no longer matches on disk (optimistic
     concurrency, HTTP 409).
   - Reject if any required placeholder is removed (HTTP 400).
   - Reject if any `{{include:X}}` references a non-existent partial.
   - Reject if file > 64 KiB.
   - Write atomically (`tmp + os.replace`) and return the new sha256.
   - Git history is the audit trail — no DB versioning in v1.
5. Add **`GET /prompts/templates/{template_id}/consumers`** returning the
   list of route template_ids that include this file. For agent prompts
   the list is `[template_id]` itself. For partials it is computed by
   scanning route files for `{{include:<name>}}` and is what the editor
   uses to drive its preview tabs.
6. Add **`POST /prompts/templates/{template_id}/preview`** with body
   `{"template": "<draft>", "route": "<route_template_id>", "context":
   {...}}` returning the fully assembled **system prompt for that
   route**, never just a fragment:
   - If `template_id` is an agent prompt (e.g. `writer_small_refresh`),
     `route` must equal `template_id` (or be omitted and default to it).
     The server resolves includes against the on-disk partials and the
     route body comes from the request's `template`.
   - If `template_id` is a partial (e.g. `_writer_brand_block`), `route`
     is required and must be in that partial's `consumers` list. The
     server reads the route file from disk, swaps the named partial for
     the request body's draft, and resolves the rest from disk.
   - Placeholders substituted with either request `context` overrides or
     live values: `persona_block` from a default persona,
     `source_policy_block` rendered live, `today_date` from
     `date.today()`.
   - Returns `{"resolved": "<final string>", "route": "<route_id>"}`.

### Frontend

New pages under `web/app/prompts/`:

- **`page.tsx`** (list view): two sections — "Agent prompts" and "Shared
  partials". Each row: name, last-modified, sha256 short hash, edit link.
- **`[templateId]/page.tsx`** (editor view):
  - CodeMirror 6 via `@uiw/react-codemirror` (smaller than Monaco; add
    only if not already in the web bundle).
  - Right rail: chips for each required placeholder; chip turns red when
    that placeholder is missing from the current buffer.
  - **Preview pane — always shows assembled system prompts, never raw
    fragments.** Behavior depends on what is being edited:
    - Editing a **route file** (`writer_small_refresh`, `writer_full_rewrite`,
      `writer_create`, or any other agent prompt): single "Preview as
      system prompt" pane. Calls `POST .../preview` with `route =
      template_id`.
    - Editing a **partial** (`_writer_brand_block`, `_writer_schema`,
      etc.): tabbed preview, one tab per consumer route returned from
      `GET .../consumers` (typically all three writer routes). Each tab
      calls `POST .../preview` with `route = <that_route>`, passing the
      current draft as the partial's body. Lets the editor verify the
      partial reads correctly inside every route it feeds.
  - "Save" disabled while validation is red. On click, sends the PUT with
    the current sha256.
  - Conflict toast if 409 returned (someone else changed the file).
- Server access via the existing `web/lib/api.ts` helper.

### Out of scope for v1

- Version history / revert UI (use `git log prompts/`).
- Per-environment overrides (all envs read the same files).
- Role-based access control (any authenticated session can edit; tighten
  later if needed).
- Live-edit while a run is mid-flight: writer.py reads the file at
  prompt-build time, so saved edits take effect on the next run only —
  acceptable for v1, document in the UI.

### Tests

- `tests/integration/test_prompts_api.py`:
  - GET list returns ≥ 10 agent templates + new partials
  - GET schema returns expected placeholder set per template
  - PUT with valid body updates file + sha256 changes
  - PUT with missing required placeholder → 400
  - PUT with stale sha256 → 409
  - PUT with body referencing unknown `{{include:X}}` → 400
  - POST preview for an agent prompt returns a string containing the
    resolved `source_policy_block` content
  - POST preview for a partial with `route=writer_small_refresh` returns
    the full assembled small_refresh system prompt with the request body
    swapped in for the partial's on-disk content
  - POST preview for a partial with a `route` that does not include that
    partial → 400
  - GET consumers for `_writer_brand_block` returns the three writer
    route ids
- Playwright smoke at `web/tests/prompts-editor.spec.ts`: open editor,
  delete `{persona_block}`, save blocked; restore, save succeeds.

---

## Work order

1. Add `_resolve_includes` to [writer.py](content_tool/agents/writer.py) +
   snapshot tests for current rendered strings.
2. Extract the 5 partials listed above; replace inlined blocks in the
   three route files with `{{include:…}}` directives. Snapshot tests must
   stay green.
3. Backend: list / schema / preview / PUT endpoints + tests.
4. Frontend: list page → editor page → preview pane. Ship behind a feature
   flag (`NEXT_PUBLIC_PROMPT_EDITOR=1`) until reviewed.
5. Docs: short section in CLAUDE.md under "Conventions" pointing at the
   editor and the partial convention.

## Risks

- **Silent prompt drift.** Mitigation: byte-equality snapshot tests for
  the three writer routes assert no semantic change in step 1–2.
- **Editor saves break a live run.** Mitigation: writer.py reads at
  build-time and we don't hot-reload mid-run; document that saves apply
  to *next* run.
- **Sha-mismatch UX confusion.** Mitigation: editor refreshes from server
  on 409 with a clear "remote changed" banner; users diff and re-apply.
- **Partial editing without context.** Mitigation: editor for partials
  shows a "used by" list (computed by grepping route files for the
  include name).

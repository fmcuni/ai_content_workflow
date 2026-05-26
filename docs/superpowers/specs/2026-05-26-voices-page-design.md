# Voices — Persona & Langgraph Inspector Page

**Date:** 2026-05-26
**Status:** Approved design, pending implementation plan
**Owner:** Franco Ma

## Purpose

Give the editorial team a single page that:

1. Lists every persona ("house voice") the desk can write in.
2. Lets editors **create, edit, and archive** personas through the UI (today this requires committing a YAML file).
3. Shows the LangGraph topology with each agent's system prompt template, the schema of the user prompt it builds at runtime, and which agents actually consume the persona.

The page answers two questions that today require reading code: *"what voice will this run use?"* and *"where in the pipeline does the voice actually take effect?"*.

## Current state (for context)

- Personas live as YAML in [config/personas/](../../../config/personas/) — only `bowtie-editor.yaml` exists. Schema is `PersonaPack` in [content_tool/models/persona.py](../../../content_tool/models/persona.py).
- Loader [content_tool/policy/personas.py](../../../content_tool/policy/personas.py) reads from disk only. No API, no UI, no DB table.
- LangGraph topology:
  - Root ([content_tool/graph/root.py](../../../content_tool/graph/root.py)): `START → strategy → production → publish_or_revise → (END | production_revise → publish_or_revise → END)`. HITL_1 interrupt before `production`; HITL_2 before `publish_or_revise`.
  - Strategy ([content_tool/graph/strategy.py](../../../content_tool/graph/strategy.py)): `fetch_article → gap_analysis → outline`.
  - Production ([content_tool/graph/production.py](../../../content_tool/graph/production.py)): `writer → resolve_citations → render_html → audit → (END | bump → writer)`, max 2 internal iterations.
- Of the LLM agents, only **writer** ([content_tool/agents/writer.py:32](../../../content_tool/agents/writer.py)) and **audit** ([content_tool/agents/audit.py:18](../../../content_tool/agents/audit.py)) consume the persona via `{persona_block}` substitution. `gap_analysis` and `outline` do not. `fetch_article`, `resolve_citations`, `render_html`, `publish` are deterministic (no LLM).
- Existing web nav ([web/components/Masthead.tsx](../../../web/components/Masthead.tsx)): `Runs · Library`. Page typography: Fraunces display, IBM Plex Sans/Mono, Noto Serif/Sans TC.

## Aesthetic direction

**Concept: the Style Sheet.** Personas are house voices; the langgraph is the production schedule; agents are desks. The page is an extension of the existing broadsheet newsroom aesthetic — no new fonts, no purple gradients, no generic CRUD layouts.

Page identity:

- New top-level nav entry: `Runs · Library · Voices` (English label "Voices"; URL `/voices`).
- Kicker / hed / dek pattern matching `SectionHead`:
  - Kicker: `Style Sheet · Voices`
  - Hed: `House Voices`
  - Dek: `The personas that shape the desk's copy — and the route each story walks before press.`

Motion is restrained: one staggered page-load reveal (rolodex → style card → workflow rows), 220ms row expand, 240ms drawer slide with paper-grain overlay strengthening. No parallax, no gradient meshes.

**The unforgettable detail** is the **Redline List** — banned terms struck through with their required replacement in italic serif (`信息 → 資訊`). Specific to Bowtie's HK editorial reality, visually distinctive, immediately useful.

## Page composition

Single scrolling broadsheet. Four movements separated by hairline rules with small uppercase Plex Mono section labels in the margin.

### Movement 1 — The Rolodex

Horizontal strip of contributor-card-sized cards near the top. Selected card has the accent-color underline; others are dimmed. The last card is `+ 新撰稿人格 / + New voice` — dashed rule, opens the Compose drawer. Toggle to reveal archived personas.

### Movement 2 — The Style Card (selected persona)

Full-bleed editorial block for the selected persona:

- Display name in Noto Serif TC ~96px, opsz tuned up; English `slug` in Plex Mono small-caps as kicker beneath.
- Voice rules ("語氣規則") as a justified body column with hanging bullets in the left margin.
- **Redline list**: each `banned_term → required_phrasing` pair set as `<s>banned</s> → <em>required</em>`. Own component (`RedlineList`).
- Disclaimer templates: small section, each template labelled (e.g. `medical`, `insurance`) in Plex Mono small-caps with the template body in serif italic.
- Tone examples: two side-by-side pull quotes with `好` / `壞` dropcaps in Noto Serif TC 64px; example text in Fraunces italic; vertical hairline between them.
- Small `Edit voice` link top-right (opens drawer prefilled). Delete sits behind a confirm inside that drawer, never as a primary affordance.
- Usage tag: "12 published · 2 in flight" — pulled from `/personas/{slug}/usage`.

### Movement 3 — The Press Workflow (the langgraph)

Vertical galley running down the column — one horizontal row per agent. Not boxes and arrows.

Each row contains, left to right:

- 2-digit Plex Mono number ("01", "02", …) in the gutter.
- Agent name in Fraunces display.
- Tag chips: `LLM` or `DETERMINISTIC`; the red-ink `PERSONA-BOUND` tag appears **only on `writer` and `audit`** — this is how the page answers "which agents does my persona influence."
- One-sentence description of the system prompt, set in serif body.
- `↓` glyph to expand inline.

Between rows, where HITL interrupts live, a thick rule with tracked-out Plex Mono small caps: `GATE · HITL_1` (before production), `GATE · HITL_2` (before publish_or_revise).

Sub-graphs (`strategy`, `production`) are introduced by a small "Sub-graph" margin label. The `production → publish_or_revise → production_revise` loop is drawn as a curved back-rule on the left edge labelled `REVISION LOOP · max 3`.

The deterministic agents (`fetch_article`, `resolve_citations`, `render_html`, `publish`) appear in the workflow but don't expand into a prompt inspector — they only show their function-level description.

### Movement 4 — Inside the row (expanded)

Inline expansion, no modal. Two columns:

- **Left (~60%)**: system prompt template. `{persona_block}` shown as an inline italic note `[ persona block — see Style Card above ]` so the injection point is visible. For `writer`, a small toggle switches between `small_refresh.md` and `full_rewrite.md`.
- **Right (~40%)**: user prompt schema as a manuscript form — field name in Plex Mono small-caps, type/source in plain body. Below it, `Load example from run…` combobox of recent runs; selecting a run fetches the rendered user prompt and shows it underneath in monospace.

## Compose drawer (Create / Edit persona)

Right-side drawer (not centered modal), slides over the right ⅓ so the Style Card behind stays visible — editors literally draft against the existing house style.

- Cream background matching `bg-paper`, black ink, hairline field underlines instead of bordered inputs.
- Section labels in Plex Mono uppercase tracked-out.
- Field order follows the YAML: `slug`, `name`, `voice_rules[]`, `banned_terms[]`, `required_phrasings[]`, `disclaimer_templates{}`, `tone_examples{good[], bad[]}`.
- Repeating-list fields: one underline per entry, `＋ 加一行` to add, "×" in margin to remove.
- Footer: `Save` as solid block button; `Archive this voice` as a small red-ink link in the bottom corner, only visible in Edit mode, behind a confirm step.

Slug is editable on Create only; on Edit it becomes read-only (because the slug is referenced by `runs.persona` rows and must remain stable).

## Data model

New Postgres table; YAML becomes a one-shot seed source.

### `personas` table (Alembic migration)

| column | type | notes |
|---|---|---|
| `persona_id` | `uuid` PK | |
| `slug` | `text` unique not null | URL-safe; matches the string already stored in `runs.persona`. |
| `name` | `text` not null | Display name. |
| `voice_rules` | `jsonb` not null | `string[]`. |
| `banned_terms` | `jsonb` not null | `string[]`. |
| `required_phrasings` | `jsonb` not null | `string[]`. |
| `disclaimer_templates` | `jsonb` not null | `Record<string,string>`. |
| `tone_examples` | `jsonb` not null | `{good: string[], bad: string[]}`. |
| `is_archived` | `boolean` default false | Soft delete. Never hard-delete — old runs reference the slug. |
| `created_at` | `timestamptz` default now | |
| `updated_at` | `timestamptz` default now | |
| `created_by` | `text` nullable | Editor email. |
| `updated_by` | `text` nullable | Editor email. |

**Why slug-not-FK on `runs.persona`:** `runs.persona` already stores persona as free-text. The slug field gives uniqueness + read-time lookup without touching the `runs` schema or breaking in-flight runs. A future FK migration is its own project.

### Migration data step

A one-time data migration inserts the contents of [config/personas/bowtie-editor.yaml](../../../config/personas/bowtie-editor.yaml) into the new table so existing runs continue to resolve. The YAML file stays in repo for traceability and as the cold-start fallback.

### `load_persona(slug)` refactor

[content_tool/policy/personas.py:10](../../../content_tool/policy/personas.py:10) becomes async and DB-first:

1. Try DB; if found, return `PersonaPack.model_validate(row_to_dict)`.
2. Fall back to YAML file (preserves boot-with-empty-DB behaviour and unit-test isolation).

Three call sites update accordingly: [writer.py:34](../../../content_tool/agents/writer.py:34), [audit.py:19](../../../content_tool/agents/audit.py:19), [refresh/evaluator.py](../../../content_tool/refresh/evaluator.py). All are already in async contexts.

### Archive semantics

Archived personas:

- Do not appear in the Rolodex by default (toggle to reveal).
- Do not appear in the `/runs/new` persona picker.
- Still resolve via `load_persona` so historical runs render correctly.

There is no hard-delete from the UI.

## API surface

Two new routers, both following the existing pattern in [content_tool/api/routes/](../../../content_tool/api/routes/).

### `/personas` router

| method | path | purpose |
|---|---|---|
| `GET` | `/personas` | List active personas. `?include_archived=true` to include archived. Returns full packs to avoid N+1. |
| `GET` | `/personas/{slug}` | One pack. |
| `POST` | `/personas` | Create. Body = full pack + `slug`. 409 on slug collision. |
| `PUT` | `/personas/{slug}` | Replace. Updates `updated_by` / `updated_at`. |
| `POST` | `/personas/{slug}/archive` | `is_archived = true`. |
| `POST` | `/personas/{slug}/restore` | `is_archived = false`. |
| `GET` | `/personas/{slug}/usage` | Count of runs grouped by status using this persona. Drives the Style Card usage tag and gates archive-confirm copy. |

### `/prompts` router

| method | path | purpose |
|---|---|---|
| `GET` | `/prompts/graph` | Static graph metadata — nodes, edges, HITL gates, sub-graph membership, `uses_persona` flag, `kind: "llm" \| "deterministic"`, optional `system_prompt_template_id`. Hand-written constant in Python; the topology changes via code review, not at runtime. |
| `GET` | `/prompts/templates/{template_id}` | Raw system prompt template contents. `template_id` ∈ {`audit`, `gap_analysis`, `outline`, `writer_small_refresh`, `writer_full_rewrite`}. |
| `GET` | `/prompts/user-example?run_id=…&agent=…` | Re-runs `build_user_prompt(...)` against the persisted inputs for a past run and returns the rendered string. Read-only — no LLM call. |

**Why expose user-prompt-builder as an endpoint:** the user prompt is computed code, not data. The only honest way to show it filled in is to re-run the deterministic builder over a real run's inputs. Cheap (DB reads + string concat), and gives editors a real artifact instead of a mock.

`/prompts/user-example` requires that the run has progressed far enough to have the inputs the agent needs (e.g. `outline` requires gap_analysis row to exist). Returns 422 if inputs are missing, with a message naming what's missing.

## Web layer

- `web/lib/api.ts` gains `personasApi` and `promptsApi` blocks, matching the shape of `articlesApi` / `refreshApi`.
- New route: `web/app/voices/page.tsx`.
- New nav entry in [web/components/Masthead.tsx](../../../web/components/Masthead.tsx).
- New components under `web/components/voices/`:
  - `Rolodex.tsx` — persona-card strip + new-voice card.
  - `StyleCard.tsx` — hero block for the selected persona.
  - `RedlineList.tsx` — banned→required substitution list (own component; reusable, testable).
  - `PressWorkflow.tsx` — vertical galley of agents + HITL gates.
  - `AgentRow.tsx` — one expandable row.
  - `PromptInspector.tsx` — two-column system+user prompt view with the run-example picker.
  - `ComposeDrawer.tsx` — right-side drawer for create/edit/archive.

React Query keys: `["personas"]`, `["persona", slug]`, `["persona-usage", slug]`, `["prompt-graph"]`, `["prompt-template", id]`, `["user-example", runId, agent]`.

## Acceptance criteria

1. `/voices` page loads, listing every active persona; the seeded `bowtie-editor` renders identically to today's YAML.
2. Selecting a persona populates the Style Card with name, voice rules, redline list, disclaimers, tone examples, and usage tag.
3. The Press Workflow shows all agents in both sub-graphs, both HITL gates, and the revision loop. Only `writer` and `audit` carry the `PERSONA-BOUND` tag.
4. Expanding an LLM agent shows its system prompt template (with `{persona_block}` injection point marked) and user prompt schema. Selecting a past run via the picker renders a real user prompt below it.
5. Compose drawer creates a new persona end-to-end; new persona is immediately available in `/runs/new`'s picker and resolves via `load_persona` for new runs.
6. Editing an existing persona updates the DB; new runs pick up the change. The slug is read-only on edit.
7. Archiving a persona removes it from the Rolodex default view and `/runs/new`; existing runs that reference it still resolve correctly.
8. All existing run/refresh tests still pass after the `load_persona` async refactor.

## Out of scope

- **Persona versioning / snapshot-at-run.** Worthwhile, but its own spec. This PR is edit-in-place + archive-don't-delete.
- **A/B testing two personas on one topic.**
- **Per-agent persona overrides** (one persona for writer, another for audit).
- **FK on `runs.persona`.** Slug stays free-text.
- **WYSIWYG preview of the rendered `{persona_block}` substring.** Implicit — the inspector shows the injection point, and `to_prompt_block()` output is inferable from the Style Card.

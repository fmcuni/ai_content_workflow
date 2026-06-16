# Voice Studio — graph UI for managing a voice, its agents & prompts

**Date:** 2026-06-16
**Status:** Spec (design-direction interview complete; not yet implemented)
**Surface:** Web (`web/`), Next.js 16 / React 19, frontend-led over existing endpoints

## Goal

A Dify-style graph page that lets an editor manage **one voice** end-to-end:
see its agent pipeline and the connections between agents/prompts, and preview
how the system prompt, user prompt, and Gemini JSON schema **stack together**,
illustrated with a **real run's** values.

## Resolved design decisions (interview)

1. **Graph model — fixed canvas, edit prompts only.** The LangGraph topology is a
   code-reviewed constant (`config/prompt_graph.ts` / `prompt_graph.py`); the UI
   renders it read-only and is *not* a topology builder. Node clicks edit prompts.
2. **Placement — `/voices/[slug]` detail page.** The graph is the main view of the
   voice-detail page. `/prompts` stays the flat power-user library. Glossary stays a
   sub-route (its editor gets reused here).
3. **Canvas tech — React Flow (`@xyflow/react` v12).** Supports React 19. Custom node
   components keep our aesthetic; we get pan/zoom/minimap/edge-routing for free.
4. **Inspector — right-docked panel**, canvas shrinks, node stays highlighted.
   Collapsible. Deterministic nodes show a read-only "no prompt" state.
5. **Editing — extract a shared `<PromptEditor>`** from the monolithic
   `app/prompts/[templateId]/page.tsx` and use it in BOTH that page and the inspector.
   Full parity: edit, save, sha256 optimistic-concurrency, version history, revert,
   preview. One editor, no drift.
6. **"Changes" preview — prompt-assembly viewer, not a git diff.** Show how prompts
   stack: base template + `{{include:NAME}}` partials + persona/locale/source-policy
   tokens → **assembled system prompt** (via `POST /prompts/templates/:id/preview`),
   and the **user prompt filled from a real run** (via `GET /prompts/user-example`),
   alongside the read-only **JSON schema** (`GET /prompts/templates/:id/schema`).
7. **Run anchor — one run picker in the page header**, defaulting to the most recent
   completed run for this voice. Illustrates every node. Nodes without a real-run
   builder (`topic_*`, deterministic) fall back to reference templates.
8. **Mode — segmented switcher** (Rewrite / Create / Expand Topics) next to the run
   picker; canvas re-renders that mode's nodes/edges/gates. Default `refresh`.
9. **Partials — secondary node layer with dotted include-edges** to consumer agents
   (via `GET /prompts/templates/:id/consumers`, reversed). Selecting a partial
   highlights its consumers and opens the inspector to edit it. Makes edit
   blast-radius visible.
10. **Voice scope — full voice management inline** via a **polymorphic inspector**:
    agent node → prompt tabs; partial node → partial editor; voice header / "Voice
    context" node → Locale / Source-policy / Glossary / Publish-target tabs. Locale +
    source-policy render as **context-input nodes** with inject-edges into
    persona-using agents (they actually feed the assembled prompt). Reuse existing
    editors (`SourcePolicyEditor`, `components/publish-targets/`, `components/voices/`),
    extract the glossary + locale editors — no duplicate editors.
11. **Node cards — static metadata + one light run chip.** Name, kind badge
    (LLM / deterministic / gate), persona-aware indicator, template id(s) with an
    "overridden vs `__shared__`" marker. With a run anchored: one chip
    (executed · not-in-this-mode · writer iteration count). No token/latency
    telemetry — that stays in `/runs`.
12. **Visual direction — editorial base, differentiated "schematic" canvas.** Existing
    letterpress palette/type (paper `#F8F5EE`, ink, rust `#B0331E`, Fraunces + IBM Plex
    Mono, hairline rules, 2–8px radii). Canvas gets a faint graph-paper texture +
    engineering-drawing edge labels. Rust accent reserved for the selected node and the
    `audit → writer` refine loop-back edges. Dotted hairline include-edges for partials.

## Existing backend (no new endpoints needed for Phase 1)

| Need | Endpoint | Notes |
|---|---|---|
| Topology per mode | `GET /prompts/graph?mode=` | nodes/edges/gates, `system_prompt_template_id`, `kind`, `uses_persona`, `sub_graph`, `alt_template_ids` |
| Template list (voice-scoped) | `GET /prompts/templates?voice=` | agent + partial + judges |
| Assembled system prompt | `POST /prompts/templates/:id/preview` | expands includes + substitutes persona/locale/source-policy |
| Real-run user prompt | `GET /prompts/user-example?run_id=&agent=` | builders: gap_analysis, outline, writer, audit |
| JSON schema + refs | `GET /prompts/templates/:id/schema` | `response_json_schema`, `user_prompt_template`, locale-resolved |
| Include consumers | `GET /prompts/templates/:id/consumers` | reverse for partial→agents edges |
| Save / history / revert | `PUT/GET /prompts/templates/:id`, `/history`, `/revert` | sha256 concurrency |

Phase 2/3 voice-config + run-chip may need: a runs-for-voice list filter and a light
per-run node-execution summary (reuse `/runs` + `/costs` data; no rebuild).

## Out of scope

- Editing topology / adding/removing nodes (code-reviewed only).
- Full run telemetry on canvas (lives in `/runs`).
- Editing the JSON schema or user-prompt templates from the UI (code-defined).

## Phasing

- **PR1 — graph + prompt management.** Route, editorial React Flow canvas (3 modes),
  node cards, partials + include-edges, run picker, polymorphic inspector with the 3
  prompt tabs (assembled system / real-run user / JSON schema) + extracted
  `<PromptEditor>` inline edit. Independently shippable & dev-verifiable.
- **PR2 — full inline voice management.** Locale / source-policy / glossary /
  publish-target tabs in the inspector + context-input nodes + inject-edges (reuse +
  extract existing editors).
- **PR3 — run-chip execution overlay + polish.**

## Verification

Dev-first (`npm run cf:deploy:dev`), self-verify UI via `scripts/claude-debug`
(screenshots → Read). Vitest component tests (`.tsx`), Playwright e2e for the
node→inspector→edit→save flow. Match `web/AGENTS.md` Next 16 conventions.

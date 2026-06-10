# Spec — FAQ widget supports tracked changes (per-item)

- **Date:** 2026-06-10
- **Status:** implemented
- **Area:** web / run-editor tracked-changes review (HITL_2 + /edit)

## Problem

The in-house tracked-changes engine (`web/lib/tracked-changes.ts`) diffs the
committed baseline against the working body as an HTML-aware token stream and
renders `<ins>`/`<del>` for review. The Bowtie FAQ accordion widget
(`div.editor__faq`, a TipTap atom node — see `web/components/tiptap/FaqAccordion.ts`)
serializes to nested `e-faq__list` / `e-faq__head` / `e-faq__body` divs.

Editing a question/answer's **text** already diffs cleanly. But **removing a FAQ
item garbles the review**: because the flat token diff aligns the shared
structural tags across different items, the removed item's question *and* answer
text float into the **surviving item's question line**, e.g.

```
<div class="e-faq__head"><del>Q1?</del><del>A1.</del>Q2? …
```

Compounding it, the positional chrome (`is--active` class + the first item's
`style="display: block;"`) lives only on the **first** item, so removing item 1
shifts that chrome — a raw-HTML diff would surface it as spurious tracked
changes. The FAQ also renders as unstyled raw divs in the review surface (no
theme CSS there).

## Goal

Per-item-aware tracked changes for the FAQ widget:

- **Edit** a Q or A → inline word/CJK-level `<ins>`/`<del>` in the right cell.
- **Remove** an item → that whole item shown struck-through, as one hunk.
- **Add** an item → that whole item shown inserted, as one hunk.
- No spurious chrome changes; accept/reject round-trips to correct markup.
- Legible rendering of the FAQ in the review surface.

## Design

All work stays inside the existing engine so accept/reject reconstruction
(`commitHunk`/`dismissHunk`/`commitAll`/`dismissAll`) and the collab-blame walk
(`web/lib/run-editor/collab-blame.ts`) keep working unchanged.

1. **FAQ-aware tokenization.** `tokenizeHtml` detects each `editor__faq` region
   (via a div-depth scanner — *not* a regex on HTML) and emits:
   - the wrapper open/close tags as ordinary tag tokens (so collab-blame's
     `isFaqOpen` + div-depth atom walk stays balanced), and
   - each `e-faq__list` item as **one chrome-free atom token**
     (`canonicalFaqItemHtml`: identity = `(q, a)` only; `is--active` and
     `display: block;` stripped). A chrome-free body round-trips to canonical
     markup because `FaqAccordion` re-derives the chrome on load.

   With items atomic, a whole add/remove is one clean part — no cross-item text
   floating — and chrome-stripping kills the positional-chrome noise.

2. **Edit refinement.** An edited item appears as a removed-atom run beside an
   added-atom run. `refineFaqItemEdits` pairs removed↔added atoms by Q+A
   similarity and replaces each matched pair with a fine sub-diff (reusing the
   engine's own plain tokenizer), so edits show inline. Unmatched atoms stay as
   whole-item add/remove.

3. **Review CSS.** `app/globals.css` styles `.editorial-prose .e-faq__*` so the
   widget reads as a clean Q/A list, and neutralizes block strike-through for
   item-level `del`/`ins`.

### Why not segment prose vs FAQ and diff separately?

Aligning two independent HTML strings into matching regions is itself a diff
problem (whole widgets added/removed, prose around them changing). Letting the
existing global `diffArrays` handle alignment — and only refining the FAQ
item runs — is far more robust and reuses all downstream machinery.

## Round-trip / reconstruction

`buildWorking`/`buildCommitted` join the chrome-free atom tokens, so the stored
baseline/working become chrome-free FAQ; `normalizeEditorHtml` and the
`FaqAccordion` node re-canonicalize the chrome on the next load. Verified:
`tokenizeHtml(buildWorking(parts)) ≡ tokenizeHtml(working)` and the committed
analogue, for edit / add / remove-first / remove-second / no-change.

## Out of scope

- Per-item blame attribution: the whole FAQ is a single Yjs atom node, so
  collab attributes all FAQ changes to one author (pre-existing limitation).
- Item reordering: there is no reorder UI; a reorder would show as remove+add.

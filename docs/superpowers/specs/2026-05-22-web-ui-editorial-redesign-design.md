# Web UI Editorial Redesign — Design Spec

**Date:** 2026-05-22
**Audience:** Bowtie content editors and SEO team (internal tool)
**Locale:** zh-Hant default; mixed Chinese + English UI strings and content
**Status:** Approved by user through brainstorming; awaiting written-spec sign-off

---

## 1. Goals

Replace the current generic shadcn-defaults look across `web/app/**` with a single, cohesive **Modern Newsroom CMS** identity. Every page feels like part of an editorial publication. The redesign covers all five page templates, the global layout shell, and the shared component primitives.

### What success looks like
- Identity: anyone using the tool remembers the masthead/folio header and the editorial typography.
- Consistency: a single 1180px content rail across all pages (kills the current 2xl/4xl/5xl/6xl/7xl drift).
- Density: dense pages (library) breathe; review pages (HITL) feel like reading a galley proof.
- Discipline: characterful without being precious — the operational pages still work fast.

### Non-goals
- Dark theme. Light/paper only.
- Brand-matching Bowtie's public marketing site. This is an internal tool with its own identity.
- Backend / API changes. Pure web-layer work.
- New features. Behavior parity with the existing pages.

---

## 2. Foundations

### 2.1 Typography

Loaded via `next/font/google` in `app/layout.tsx` and exposed as CSS variables.

| Use | Family | Weights / axes |
|---|---|---|
| Display headings | **Fraunces** | Variable; `opsz` 14–144, `SOFT` 50–100, weights 400/500/700 |
| UI / body (Latin) | **IBM Plex Sans** | 300, 400, 500, 600 |
| Mono accents | **IBM Plex Mono** | 400, 500 |
| zh-Hant body | **Noto Sans TC** | 400, 500, 600 |
| zh-Hant display fallback | **Noto Serif TC** | 500, 700 |

Stacks:
```
--font-display: "Fraunces", "Noto Serif TC", ui-serif, Georgia, serif;
--font-sans:    "IBM Plex Sans", "Noto Sans TC", system-ui, sans-serif;
--font-mono:    "IBM Plex Mono", ui-monospace, "SFMono-Regular", monospace;
```

Body text on review/draft pages uses Fraunces at `opsz: 14` to read as a true body serif. All other body and UI text uses IBM Plex Sans. Plex Mono is reserved for IDs, timestamps, costs, route names, and the masthead dateline.

### 2.2 Color tokens (light theme only)

```css
--paper:        #F8F5EE;  /* page bg, slightly warm cream */
--paper-deep:   #EFE9DC;  /* raised surface — cards, hover */
--ink:          #1A1714;  /* primary text */
--ink-soft:    #4A453E;  /* secondary text */
--ink-faint:   #8B8275;  /* tertiary / meta */
--rule:         #D8D0BF;  /* hairline rules */
--accent:       #B0331E;  /* editorial red — primary actions, alerts */
--accent-deep:  #872416;  /* hover/pressed */
--ok:           #2F6B3A;  /* success — sparing use */
--warn:         #B27A0A;  /* warn — refresh-needed */
--info:         #3A5A8C;  /* info — sparing use */
```

The existing OKLCH neutral tokens in `app/globals.css` are replaced. Existing shadcn semantic tokens (`--background`, `--foreground`, `--primary`, `--card`, `--border`, etc.) re-map to the new palette so unmodified shadcn components inherit the theme.

### 2.3 Spacing, radius, rules

- Spacing scale: `4 / 8 / 12 / 16 / 24 / 32 / 48 / 72 / 112` px (musical, not strict 8-grid).
- Radius: `--r-tight: 2px` (inputs/buttons), `--r-soft: 6px` (cards), `--r-pill: 999px` (badges only).
- Card chrome: `1px solid var(--rule)` hairline; no shadows except a single subtle drop on overlays.
- Container: `max-w-[1180px]` content rail used by every page; horizontal padding `px-10` desktop, `px-5` mobile.

### 2.4 Motion

- Page enter: 12-line staggered fade+rise (~24ms per line, 240ms ease-out cubic). CSS-only via `animation-delay`.
- Row/card hover: 120ms `--ink-soft` → `--ink` text crossfade plus a 1px `--accent` left-border reveal.
- Status badge: subtle 2-step opacity pulse on `running` / `in_progress` runs only.
- Active filter chip: 80ms scale 0.97 → 1 on toggle.
- No scroll-jacking, parallax, or springy physics.

### 2.5 Visual atmosphere

- 1% SVG turbulence grain overlay on `--paper`, applied as a `background-image` data URL on `body`. Adds newsprint texture without being kitsch.
- Masthead "folio": a 2px ink rule with a 1px rule 12px below it — applied at the top of the page chrome and (optionally lighter) below section heds.

---

## 3. Layout shell

### 3.1 Masthead (replaces current `<header>` in `app/layout.tsx`)

Structure:
```
══════════════════════════════════════════════════════════
 BOWTIE · CONTENT DESK         VOL. 21  ·  THU 22 MAY 2026
 ────────────────────────────────────────────────────────
 Runs    Library    Drafts    Settings        [+ New run]
══════════════════════════════════════════════════════════
```

- Top edge: 2px `--ink` rule, 12px gap, 1px `--rule` line.
- Wordmark left: `BOWTIE · CONTENT DESK` in Fraunces small-caps, tracking +40, weight 500. Links to `/`.
- Dateline right: `VOL. <ISO-week-number> · <DAY DD MMM YYYY>` in Plex Mono 12px, `--ink-faint`. Computed client-side from `new Date()`.
- Nav: horizontal links, no underline. Active route gets a `▪` glyph prefix in `--accent`. No background pills.
- Primary action: `+ New run` sharp-rect button, ink-on-cream by default, inverts to accent-on-ink on hover. Always visible.
- Sticky on scroll with a tiny `backdrop-filter: blur(8px)` on `--paper/85` so content visibly scrolls beneath the rules.

### 3.2 Page shell

- Single column, `max-w-[1180px]`, `mx-auto`, `px-10` / `px-5`.
- Section headers use kicker / hed / dek:
  - **Kicker:** 11px Plex Mono ALL CAPS, letter-spacing 0.15em, `--ink-faint`. Example: `RUN · 8f3a2c`.
  - **Hed:** Fraunces, `opsz: 144`, weight 500, 40–48px, leading 1.05, `--ink`.
  - **Dek:** 16px Plex Sans, `--ink-soft`, optional italic, `max-w: 65ch`.
- Page-level content sits directly on `--paper` divided by hairline rules. Card surfaces only return for grouped sub-units (a form, a single review panel).

### 3.3 Footer

A single line in Plex Mono 11px ALL CAPS centered below a `--rule`:
```
BOWTIE CONTENT DESK · INTERNAL · COMMIT 81cdc5c · BUILT 2026-05-22
```
Commit SHA and build date injected at build time via `next.config.mjs` env (`NEXT_PUBLIC_BUILD_SHA`, `NEXT_PUBLIC_BUILD_DATE` from a small build script).

---

## 4. Per-page treatments

### 4.1 `/` — Runs list ("The Front Page")

- Header: kicker `RUNS · LIVE`, hed `Front Page`, dek `Articles currently in motion through the desk.`
- Replaces the card-list with a ledger table:
  - **Left rail (96px):** timestamp in Plex Mono — day-of-week (`THU`) above `HH:MM`.
  - **Center:** Fraunces 22px topic headline → 1px hairline → 13px Plex Sans `article_url` truncated, `--ink-faint`.
  - **Right rail (220px):** status stamp + route + iteration count, right-aligned, mono.
- Rows separated by `--rule`. Hover lightens row to `--paper-deep` and turns left-rail timestamp `--accent`.
- Status badges become **paper stamps**: Plex Mono 10px ALL CAPS, `1px solid currentColor`, tight padding, status-driven ink colors (`hitl_*` → `--accent`, `done` → `--ok`, `failed` → `--accent-deep`, `running` → `--info` + pulse).
- Empty state: a single Fraunces italic line, `No stories on the wire.`

### 4.2 `/library` — Article library ("The Archive")

- Header: kicker `ARCHIVE`, hed `Article Library`, dek about scan cadence.
- Filter bar: a horizontal toolbar above the table, with each filter rendered as a labeled chip `STATUS · needs refresh ▾`. Inputs are flat bottom-rule only; active filters show a `×` to clear.
- `Run scan now` becomes a secondary outline button right of the toolbar.
- Table:
  - Column headers: 11px Plex Mono ALL CAPS, tracked, `--ink-faint`.
  - Body cells: Plex Sans 14px for prose, Plex Mono 13px for dates/IDs/counts.
  - Row hover: full row crossfades ink-soft → ink + `--accent` 1px left border slides in.
  - Staleness glyph in the leftmost column: `▪` (mild), `▪▪` (severe).
- Pagination: Plex Mono indices `01 · 02 · 03 · …` with thin rule between.

### 4.3 `/runs/new` — New run ("The Assignment Sheet")

- Header: kicker `NEW RUN`, hed `Article Assignment`, dek `Brief the desk on the next refresh.`
- Form lives in one ruled `--paper-deep` panel.
- Fields: bottom-rule only inputs; floating labels in 11px Plex Mono ALL CAPS above each field.
- Two-column layout for short fields (mode/persona, ACF IDs); single column for textareas.
- Prefilled refresh-context block becomes an **editor's brief** — blockquote with a vertical accent rule on the left, kicker `BRIEF FROM ARCHIVE`, findings as a numbered editorial list.
- Submit: sharp-rect Plex Sans 14px, full-width on mobile, right-aligned with `Cancel ↩` link on desktop.

### 4.4 `/runs/[runId]` — Run detail ("The Story Page")

- Header: kicker `RUN · <short_id>`, hed = run topic in Fraunces 44px, dek = `article_url` truncated with `↗`.
- Status replaced with a **byline strip**: `STATUS · running   ·   ROUTE · full_rewrite   ·   ITER · 2   ·   COST · HK$ 4.23` — all Plex Mono, separated by `·`. No badge soup.
- Asymmetric two-column body, 62% / 38% desktop, stacked on mobile.
  - **Left 62%:** Live progress as a vertical ruled timeline. Each event row: time (Plex Mono left rail) → event glyph (`▪` info, `▴` human, `✕` error) → event text in Plex Sans + optional dek beneath. Active row gets `--accent` and a pulse.
  - **Right 38%:** Editor's actions, sticky on scroll. Large primary buttons stack vertically with a kicker above each. Idle copy: italic Fraunces `Nothing required of the desk.`
- `CostMeter` collapses to a single mono inline pill displayed in the byline strip (no bars).

### 4.5 `/runs/[runId]/hitl1` and `/hitl2` — Review screens ("The Galley Proof")

These pages get the most editorial treatment.

- Header: kicker `GALLEY PROOF · STAGE 1` / `STAGE 2`, hed `Editor's review`.
- Article preview / draft set in **Fraunces 18px body** (`opsz: 14`, leading 1.6) on a paper column `max-w: 65ch`. Feels like reading a magazine proof.
- Diff view (Stage 2): Plex Sans 14px; deletions get `--paper-deep` bg, insertions get `--accent`-tinted bg (no garish red/green); `+` / `−` Plex Mono glyphs in the left rail.
- Comments / outline items become **margin notes** in a 200px right gutter on wide screens; collapse to inline blockquotes on narrow.
- Sticky footer action bar with two sharp buttons:
  - `APPROVE & PUBLISH ↪` — filled accent-on-ink.
  - `REJECT & ITERATE ↺` — outline.
  - Plex Mono 12px ALL CAPS labels.

---

## 5. Shared component refresh

| Component | Change |
|---|---|
| `Button` | Drop rounded shadcn default. New variants: `primary` (filled, sharp 2px radius, ink → accent on hover 120ms), `secondary` (outline ink), `ghost` (link-style with bottom-rule on hover), `destructive` (outline accent-deep). |
| `RunStatusBadge` | Paper-stamp treatment: Plex Mono 10px ALL CAPS, `1px solid currentColor`, tight padding. Status → ink color mapping above. |
| `Input` / `Textarea` | Bottom-rule only. Focus grows the rule to 2px in `--accent`. No surrounding box. |
| `Select` (Radix) | Popover with `--paper-deep` bg, hairline rule, no shadow except a 1px ink-faint drop. Items hover to `--paper`. |
| `Card` | Default loses bg — `border` token only. New `Card.Editorial` variant accepts a `kicker` prop and renders the kicker/hed/dek pattern. |
| `CostMeter` | Collapses to a single mono inline pill: `HK$ 4.23 · 12.3k tok`. No bars. |
| `EventTimeline` | Rewritten per §4.4. |
| `LibraryTable` | Rewritten per §4.2. |
| `RefreshFindingsPanel` | Rendered as the editor's-brief blockquote per §4.3. |

---

## 6. File-level impact

Files that will change (no behavior changes, only presentational):

```
web/app/layout.tsx                  # masthead, footer, font loading
web/app/globals.css                 # token replacement, fonts, base styles
web/app/page.tsx                    # runs list re-render
web/app/library/page.tsx            # archive page
web/app/runs/new/page.tsx           # assignment sheet
web/app/runs/[runId]/page.tsx       # story page
web/app/runs/[runId]/hitl1/page.tsx # galley proof stage 1
web/app/runs/[runId]/hitl2/page.tsx # galley proof stage 2
web/components/ui/button.tsx        # variant overhaul
web/components/ui/card.tsx          # add Editorial variant + drop bg default
web/components/ui/input.tsx         # bottom-rule treatment
web/components/ui/textarea.tsx      # bottom-rule treatment
web/components/ui/select.tsx        # popover restyle
web/components/RunStatusBadge.tsx   # paper stamp
web/components/CostMeter.tsx        # inline mono pill
web/components/EventTimeline.tsx    # ruled timeline
web/components/LibraryTable.tsx     # ledger table treatment
web/components/RefreshFindingsPanel.tsx # editor's brief
web/next.config.mjs                 # inject NEXT_PUBLIC_BUILD_SHA / DATE
```

New files:
```
web/components/Masthead.tsx                  # global header
web/components/Folio.tsx                     # 2px+1px rule pair
web/components/SectionHead.tsx               # kicker/hed/dek primitive
web/components/PaperStamp.tsx                # base for badge/stamps
web/lib/build-info.ts                        # exposes SHA/date
```

---

## 7. Testing

- Playwright: existing tests (library page, runs/new refresh context) updated for new structure but assert same user-visible behavior. No new flows.
- Type-check: must pass.
- Manual verification per `verify` skill: walk through runs list → library → new run → run detail → HITL on dev server before claiming complete.
- Visual regression: out of scope (no infra for it).

---

## 8. Out of scope

- Mobile-specific designs beyond responsive breakpoints (this is a desktop-first tool).
- Accessibility audit beyond preserving current Radix primitives. Color contrast is verified manually on the new tokens.
- Internationalization beyond preserving the existing `zh-Hant` `<html lang>` and font fallbacks.
- Dark theme.
- Brand alignment with Bowtie's public marketing site.

---

## 9. Open risks

- **Font payload weight:** loading Fraunces variable + IBM Plex Sans + Plex Mono + Noto Sans TC + Noto Serif TC. Mitigation: subset to Latin + zh-Hant CJK ranges, `display: swap`, preload only the display + UI base. Noto Serif TC loaded lazily for review pages only.
- **Reading Fraunces as body on HITL pages:** indulgent. If it hurts scanability when reviewing long drafts, fall back to Plex Sans for body and keep Fraunces for the topic only. To be evaluated during implementation.
- **Accent red on regulated insurer content:** `#B0331E` could read as "error" in some contexts. Mitigation: never use accent for status semantics — status colors live in their own scale (`--ok` / `--warn` / `--accent-deep` for failed). Accent is reserved for actions and the active-route glyph.

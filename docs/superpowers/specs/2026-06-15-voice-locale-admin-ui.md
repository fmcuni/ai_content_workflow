# Voice Management — Locale & Brand Admin UI — Spec

**Date:** 2026-06-15
**Status:** Proposed
**Builds on:** `docs/superpowers/specs/2026-06-15-voice-locale-brand-portability.md`
(the backend `VoiceLocale` foundation — SHIPPED to `feat/voice-locale-portability`)
**Branch:** `feat/voice-locale-portability` (continue here) — dev Workers first, then prod

## 1. Goal

Let an admin **set a voice's locale & brand from the `/voices` UI** instead of
hand-writing SQL against `content_tool.personas.locale`. The data layer and
prompt threading already exist and are dev-verified; today the six locale fields
are only settable via DB. This closes the one gap the portability spec listed as
an explicit follow-up ("Admin UI to edit `personas.locale` (seed via DB for now)").

Each voice already carries its **own** locale (per-voice `personas.locale` JSONB);
this spec makes that per-voice value **editable and previewable** in the existing
voice editor.

## 2. Decisions (locked with the user, 2026-06-15)

| # | Decision | Choice |
|---|---|---|
| Scope | How far the upgrade goes | **Wire locale into the existing `ComposeDrawer` editor** (no redesign) |
| Input | How the 6 fields are entered | **Free-form fields**; `ui_lang` is a dropdown (`zh-Hant`/`en`), the rest are text |
| Preview | See the effect before saving | **Yes — full live preview** via the existing `PromptInspector` |
| Validation | Strictness | **Guided + non-blocking coherence warnings** (warn, never hard-block) |

## 3. The six locale fields (unchanged shape)

From `content_tool/models/persona.py` `VoiceLocale` (TS mirror
`deploy/cloudflare-workers/src/agents/persona.ts`). HK-ZH defaults; empty `{}` = no-op.

| Field | PY / wire | TS internal | Default | UI control |
|---|---|---|---|---|
| Output language | `output_language` | `outputLanguage` | `香港繁體中文` | text |
| Brand name | `brand_name` | `brandName` | `Bowtie` | text |
| Market | `market` | `market` | `Google 香港繁中` | text |
| Sources heading | `sources_heading` | `sourcesHeading` | `null` (= auto-detect script) | text (empty → auto) |
| FAQ heading | `faq_heading` | `faqHeading` | `常見問題` | text |
| UI language | `ui_lang` | `uiLang` | `zh-Hant` | **select**: `zh-Hant` \| `en` |

Each field's placeholder shows its HK-ZH default so an admin sees what "leave
blank" yields. `sources_heading` blank ⇒ stored as `null` ⇒ today's
Traditional↔Simplified auto-detection (safe for zh voices).

## 4. UX

### 4.1 Editor section
A new **"Locale & Brand"** section inside `ComposeDrawer` (the admin-only,
edit-only drawer reached from the `/voices` Rolodex). Five text inputs + one
`ui_lang` `<select>`. Section sits below the existing voice-rules/tone fields.
The field set is purely additive — all current fields and the save flow are
unchanged.

### 4.2 Coherence warnings (non-blocking)
A client-side advisory banner inside the section — **never blocks save**:
- `ui_lang = en` but CJK characters detected in `output_language`, `faq_heading`,
  or a non-empty `sources_heading` → *"This voice renders English scaffolding but
  a heading/language still looks Chinese — intended?"*
- `ui_lang = zh-Hant` but `output_language`/`faq_heading` are pure-ASCII →
  symmetric warning.
- Detection is a simple CJK-range regex; advisory only, no server enforcement.

### 4.3 Live preview
The drawer's in-progress (unsaved) locale is fed to the existing
`PromptInspector` preview. As the admin edits a field, the assembled system
prompt + the resolved sources/FAQ headings update (debounced). This reuses
`POST /templates/:id/preview`, extended with an optional `locale` override (§5.2)
so the preview reflects unsaved edits rather than the DB-stored locale.

## 5. Backend changes (both backends — TS is prod, PY for evals/local; keep in sync)

### 5.1 Accept `locale` on persona write
- Add optional `locale` to `PersonaPatch` (and `PersonaIn` for create/duplicate
  parity) — Python (`models`) + TS (route input zod/type).
- `PUT /personas/{slug}` already does `model_dump(exclude_unset=True)` →
  `update_persona`; when `locale` is present it **replaces the whole JSONB**
  (the form always submits the full object). When omitted, the column is
  untouched. TS `update` handler mirrors this.
- Validate on the server: `ui_lang ∈ {zh-Hant, en}`; the rest are free strings;
  `sources_heading` nullable. Coherence is **not** enforced server-side (§2).
- Confirm `PersonaOut` serializes `locale` (wire casing matches what
  `GET /personas` already emits for the persona block — keep one casing across
  list/get/update responses).

### 5.2 Locale override on preview
- `POST /templates/:id/preview` accepts an optional `locale` in the body.
- Thread it into `substitutePreview(...)` as a `localeOverride`; when present,
  token substitution (`{brand_name}`/`{output_language}`/`{market}`) and heading
  resolution use the override instead of `loadPersona(...).locale`. When absent,
  behaviour is exactly as today.
- PY mirror in `content_tool/api/routes/prompts.py` preview path.

## 6. Frontend changes (`web/`)

- `lib/types.ts` — `VoiceLocale` type; add `locale` to `Persona`, `PersonaPatch`,
  `PersonaIn` (matching the personas endpoint's wire casing).
- `lib/api.ts` — `promptsApi` preview gains an optional `locale` arg passed in the
  POST body.
- `components/voices/ComposeDrawer.tsx` — "Locale & Brand" section: form state for
  the 6 fields, `ui_lang` select, placeholders = defaults, coherence-warning
  banner, included in the PUT patch on save.
- `components/voices/PromptInspector.tsx` — accept the drawer's live locale and
  pass it to the preview call (debounced).
- Gating unchanged: section only renders when `can("manage_personas")`.

## 7. Out of scope (follow-ups)

- Locale **presets/templates** (HK-ZH/MY-EN/MY-ZH one-click). Deferred — user
  chose free-form fields. Easy to layer on later as a "prefill" button.
- Setting locale **at duplicate time** in `DuplicateVoiceDialog` — not needed:
  duplicate already deep-copies the source persona row (incl. its `locale`), and
  the new voice's locale is then editable in `ComposeDrawer`.
- Surfacing locale read-only on the `StyleCard`/Rolodex glance view.
- Translating operator-facing strings (carried from the parent spec).

## 8. Acceptance

| Check | Expected |
|---|---|
| Edit a voice's `output_language`/`brand_name`/`market`/`faq_heading` in the drawer, save | persisted to `personas.locale`; reload shows new values |
| `ui_lang` dropdown set to `en`, save | persona block renders English labels on the next run/preview |
| `sources_heading` left blank | stored `null`; zh voice keeps auto-detected heading |
| Live preview while editing locale (unsaved) | assembled prompt + headings reflect the in-progress values |
| Coherence warning (e.g. `ui_lang=en` + Chinese FAQ heading) | advisory banner shows; save still allowed |
| HK-ZH voice (`bowtie-editor`) opened + saved with no locale change | byte-identical locale; no behaviour change |
| Server: `ui_lang` outside `{zh-Hant,en}` | 422/400 rejected |
| Parity gate | green (preview endpoint symmetric across backends) |

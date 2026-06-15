# Voice Management — Locale & Brand Admin UI — Plan

**Date:** 2026-06-15
**Spec:** `docs/design/specs/2026-06-15-voice-locale-admin-ui.md`
**Branch:** `feat/voice-locale-portability` (continue on the branch the backend
foundation already landed on; dev Workers first, then prod)

**Status (2026-06-15):** Proposed — backend `VoiceLocale` foundation already
SHIPPED to this branch + dev-verified. This plan adds the admin UI + the two
small API extensions that expose it.

## Shape of the work

Small, low-risk, mostly additive. Two backend extensions (persona write accepts
`locale`; preview accepts a `locale` override) unblock a self-contained frontend
section + live preview. Both backends change together (TS is prod, PY for
evals/local) and ship with tests. No migration, no flow change.

### Dependency DAG

```
A: API — accept `locale` on persona write (PersonaPatch/In + PUT, both backends)
B: API — `locale` override on POST /templates/:id/preview (both backends)
        │  (A and B are file-disjoint; can run in parallel)
        ▼
C: FE types + api client (locale on Persona/Patch/In; preview locale arg)
        ▼
        ├─ D: ComposeDrawer "Locale & Brand" section + coherence warnings
        └─ E: PromptInspector live preview wired to unsaved locale
        ▼
F: tests (PY + TS unit + web vitest .tsx + parity) → dev deploy + self-verify → prod
```

## Phase A — Persona write accepts `locale` *(both backends)*

**Owns:** `content_tool/models/persona.py` (PersonaPatch/PersonaIn),
`content_tool/api/routes/personas.py`, `content_tool/db/persona_model.py`
(`update_persona`), TS `deploy/cloudflare-workers/src/routes/personas.ts` (input
type/zod + update handler) + its DB writer.

**Do:**
1. Add optional `locale` (VoiceLocale shape) to `PersonaPatch` and `PersonaIn`.
2. On `PUT /personas/{slug}`: when `locale` present, write the whole JSONB;
   when omitted (`exclude_unset`), leave the column untouched.
3. Server-validate `ui_lang ∈ {zh-Hant,en}`; `sources_heading` nullable; rest
   free strings. No coherence enforcement.
4. Ensure `PersonaOut` (both backends) serializes `locale` with one consistent
   wire casing across list/get/update.

**Done when:** `PUT` with a `locale` body round-trips on reload; `PUT` without
`locale` is unchanged; bad `ui_lang` → 4xx; pyright/tsc clean.

## Phase B — `locale` override on preview *(both backends)*

**Owns:** TS `deploy/cloudflare-workers/src/routes/prompts.ts` (`POST
/templates/:id/preview`) + `substitutePreview` in the agents layer; PY mirror in
`content_tool/api/routes/prompts.py` preview path.

**Do:**
1. Accept optional `locale` in the preview request body.
2. Thread it as a `localeOverride` into `substitutePreview`; when present, use it
   for `{brand_name}`/`{output_language}`/`{market}` substitution + sources/FAQ
   heading resolution instead of the persona's stored locale. Absent ⇒ today's
   behaviour byte-for-byte.

**Done when:** preview with no `locale` is byte-identical to today; preview with
a `locale` override reflects the overridden tokens/headings; parity green.

## Phase C — Frontend types + API client

**Owns:** `web/lib/types.ts`, `web/lib/api.ts`.

**Do:** add `VoiceLocale` type; add `locale` to `Persona`/`PersonaPatch`/
`PersonaIn`; `promptsApi` preview gains an optional `locale` arg (POST body).
Match the wire casing the personas endpoint emits.

**Done when:** tsc/eslint clean; existing persona/preview calls unaffected.

## Phase D — ComposeDrawer "Locale & Brand" section

**Owns:** `web/components/voices/ComposeDrawer.tsx` (+ a small
`locale-warnings.ts` helper for the CJK coherence heuristic).

**Do:**
1. Form state for the 6 fields; 5 text inputs + `ui_lang` `<select>`
   (`zh-Hant`/`en`); placeholders = HK-ZH defaults; blank `sources_heading` →
   `null` on submit.
2. Include `locale` in the PUT patch on save.
3. Non-blocking coherence-warning banner (CJK-range heuristic, §4.2 of spec).
4. Render only when `can("manage_personas")`.

**Done when:** edit + save persists locale; warnings advisory only; HK-ZH voice
saved with no change is a no-op.

## Phase E — PromptInspector live preview

**Owns:** `web/components/voices/PromptInspector.tsx` + the wiring from
`ComposeDrawer`/`/voices` page that passes the in-progress locale down.

**Do:** pass the drawer's live (unsaved) locale into the preview call (Phase C
arg), debounced, so the assembled prompt + headings update as the admin edits.

**Done when:** editing a locale field visibly changes the preview without saving.

## Phase F — Tests, dev verify, prod

1. **Backend tests:** PY — PersonaPatch accepts/round-trips `locale`; preview
   honors `locale` override; bad `ui_lang` rejected. TS — same via vitest;
   persona update + preview override.
2. **Web tests:** `ComposeDrawer.test.tsx` (renders the 6 controls, submits
   `locale`, blank sources_heading → null); `locale-warnings` unit
   (coherence heuristic both directions). Component tests MUST be `.tsx`.
3. **Parity:** `node deploy/cloudflare-workers/parity/check-parity.mjs` green
   (preview endpoint symmetric).
4. **Dev deploy + self-verify:** `npm run deploy:dev` (backend) +
   `cd web && NEXT_PUBLIC_*=<dev> npm run cf:deploy:dev` (web). Verify the
   drawer + live preview headlessly via `scripts/claude-debug`
   (screenshot → Read). DEV-ONLY; never approve/publish (WordPress shared w/ prod).
5. **Prod:** deploy the same commit to prod; smoke (health 200 / personas
   auth-gated / web 307). No migration to apply (locale column already exists in
   both DBs).
6. **Docs/memory:** mark spec + this plan SHIPPED; one-line note in project
   CLAUDE.md that locale is now editable in `/voices`.

## Test matrix

| Check | No-locale baseline | Locale edited |
|---|---|---|
| `PUT /personas/{slug}` | column untouched | JSONB replaced, round-trips |
| `POST .../preview` | byte-identical | tokens/headings reflect override |
| ComposeDrawer save | HK-ZH no-op | locale persisted |
| Live preview | n/a | updates on edit, unsaved |
| Coherence warning | none | advisory only, save allowed |
| Parity gate | green | green |

## Risks / notes

- **Casing skew** — PY snake_case (`ui_lang`) vs TS internal camelCase
  (`uiLang`). Pick the wire casing from what `GET /personas` already emits and
  keep request/response symmetric; the persona block already crosses this
  boundary, so follow its convention.
- **Whole-object replace** for `locale` is intentional (form always sends all 6).
  No partial-merge semantics — documented in the spec.
- **No preset picker** (user chose free-form). A "prefill HK-ZH/MY-EN" button is
  a trivial later add if onboarding gets repetitive.
- Keep dev↔prod in sync per the standing dev-first workflow; no DB migration here.

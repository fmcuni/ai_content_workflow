# Plan — editable source-policy prose + per-user editor identity (2026-06-08)

Spec: `docs/design/specs/2026-06-08-editable-source-policy-prose-and-per-user-editor-identity.md`

## Status: IMPLEMENTED (uncommitted) — local checks green; live parity + deploy pending

## Changes

### Editable prose (template + tokens, NO migration — lives in `body` JSON)
- `content_tool/policy/source_policy.py` — `SourcePolicy` reads optional
  `prompt_block`; `to_prompt_block()` branches to `_render_template()` (token
  substitution) when set, else the unchanged default.
- `content_tool/source_policy_store.py` — `clean()` keeps a non-empty trimmed
  `prompt_block` as the LAST key (default rows byte-identical).
- `content_tool/api/routes/source_policy.py` — `_validate_policy` accepts a
  string `prompt_block`.
- `deploy/cloudflare-workers/src/config/source_policy.ts` — mirror: `CleanPolicy.prompt_block`,
  `cleanPolicy`, `SourcePolicy.promptBlock` + `renderTemplate()` (uses
  `replaceAll`, identical token order + `{denied_tlds_line}` newline consumption).
- `deploy/cloudflare-workers/src/routes/source_policy.ts` — `validatePolicy` accepts `prompt_block`.
- `web/lib/types.ts` — `SourcePolicyDoc.prompt_block?: string`.
- `web/components/SourcePolicyEditor.tsx` — template `Textarea`, token legend,
  "Load default" / "Clear" buttons; live preview + save already carry the full doc.

### Per-user editor identity (web only)
- `web/lib/api.ts` — `resolveEditorEmail()` reads the better-auth session email
  (cached), forwards it as `X-Editor-Email` on prompt/source-policy **writes**;
  static `NEXT_PUBLIC_PROMPT_EDITOR_EMAIL` kept as a dev fallback.

### Tests
- `tests/unit/test_source_policy.py` (+5), `tests/unit/test_source_policy_store_voice.py` (+2),
  `deploy/cloudflare-workers/src/config/source_policy.test.ts` (+7). Token-substitution,
  `{denied_tlds_line}` empty/set, default-override, whitespace-as-unset, and
  byte-identical canonical-JSON parity on both sides.

## Verification
- PY: `pytest tests/unit -k "source_policy or policy or prompt"` → 66 passed.
- TS: `vitest run src/config/source_policy.test.ts` → 13 passed; Workers `tsc` clean.
- Web: `tsc` clean, `eslint` clean, `vitest` → 229 passed.
- ruff (new code) + pyright clean. (One pre-existing E501 on unchanged CJK prose
  in `source_policy.py` left untouched — present on HEAD, changing it would alter
  the prompt sha.)
- Parity gate (`check-parity.mjs`) NOT run — needs a live local backend on :8000.
  Covered logically by the cross-backend byte-parity unit tests.

## Deploy (no DB migration)
1. Deploy Workers backend + web together (sha parity for any saved template).
   - `cd deploy/cloudflare-workers && npx wrangler deploy`
   - `cd web && NEXT_PUBLIC_API_BASE=https://bowtie-content-tool-poc.fmc.workers.dev npm run cf:deploy`
     (the web rebuild also activates the per-user identity fix).
2. Smoke: open `/prompts → Source Policy`, "Load default", tweak a line, Save →
   history row shows your email (not `dev@local`); rendered block reflects edits.

## Known limitation
Client-set `X-Editor-Email` is spoofable by a logged-in editor. RBAC permission
is enforced Workers-side independently. A server-trustworthy header (Next route
handler validating the session) is deferred.

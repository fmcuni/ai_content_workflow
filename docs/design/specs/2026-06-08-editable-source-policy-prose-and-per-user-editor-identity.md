# Editable source-policy prose + per-user editor identity — 2026-06-08

## Problem

Two operator complaints from the `/prompts` screen:

1. **Save history shows `dev@local`, not the signed-in account.** Prompt /
   source-policy version rows are stamped from the `X-Editor-Email` request
   header. The header is only sent when the web build defines the static
   `NEXT_PUBLIC_PROMPT_EDITOR_EMAIL` env var; prod was built without it, so the
   backend falls back to `dev@local`. The app already has per-user login
   (better-auth), so the stamp should reflect the logged-in editor.

2. **Only the structured lists are editable.** The `{source_policy_block}` text
   injected into the writer prompts is rendered by `SourcePolicy.to_prompt_block()`
   / `SourcePolicy.toPromptBlock()`. The `/prompts → Source Policy` tab edits the
   structured lists (denied/preferred domains & TLDs, community categories), but
   the **prose** (authority principles, hard-prohibition lines, grounding rules)
   is hard-coded and not editable without a code change.

## Decision

### 1. Per-user identity (web only)

Read the logged-in better-auth session email client-side in `web/lib/api.ts` and
forward it as `X-Editor-Email` on `/api/prompts/*` and `/api/source-policy*`
write calls, replacing the static `NEXT_PUBLIC_PROMPT_EDITOR_EMAIL` env as the
primary source (env kept as a dev fallback).

- The web→backend bridge is a pure Next.js rewrite (`next.config.mjs`), which
  cannot run server-side logic, so the header is set client-side.
- Trust model unchanged: the backend already trusts this header, and RBAC
  permission is enforced Workers-side independently of the stamped identity. A
  logged-in editor could spoof the header, but that is no weaker than today and
  acceptable for an internal editorial tool. Documented as a known limitation.

### 2. Editable prose — template + tokens (both backends, NO migration)

Add an optional `prompt_block` string to the policy object. When non-empty, the
render functions return that template with these tokens substituted (computed
identically PY↔TS so the prompt sha stays in parity); when empty/absent, the
existing hard-coded default renders unchanged (existing rows keep byte-identical
bodies & shas).

| Token | Renders to |
|---|---|
| `{prefer_tlds}` | `prefer.tlds` joined ` / `, else `（未設定）` |
| `{prefer_domains}` | sorted `prefer.domains` joined `、`, else `（未設定）` |
| `{community_categories}` | sorted categories joined `、`, else `（未設定）` |
| `{community_domains}` | sorted community domains joined `、`, else `（未設定）` |
| `{denied_tlds}` | `deny.tlds` joined ` / ` (empty string if none) |
| `{denied_tlds_line}` | the full `- 額外硬性禁止…` line when denied TLDs exist, else empty — the empty case also consumes one trailing newline so no blank line is left |

**Storage:** `prompt_block` lives inside the existing `source_policy.body` JSON
(appended as the last key, only when non-empty). No schema change — version
history, revert, optimistic-concurrency sha, and the 64 KiB cap all cover it for
free. Default rows (no `prompt_block` key) serialize to the exact same bytes as
today.

**Coupling preserved:** the structured lists still drive `evaluate()` (the real
citation gate) AND feed the template tokens, so prose can't silently diverge
from what is actually blocked — the reason we chose template+tokens over a fully
free-text block.

## Parity invariants (must hold or the prompt sha drifts)

- `clean()` / `cleanPolicy()` include `prompt_block` only when it is a non-empty
  string after trim, always as the **last** key.
- Token substitution uses `str.replace` (PY, replaces all) / `String.replaceAll`
  (TS) with identical token order and identical list-formatting (sort, joins,
  `（未設定）` fallbacks) already used by the default renderer.
- `prompt_block` is trimmed (`str.strip()` / `String.trim()`) on clean.

## Out of scope

- Server-trustworthy (non-spoofable) editor identity via a Next route handler /
  middleware that validates the session before injecting the header — larger
  change, deferred.
- Per-token validation of unknown placeholders (unknown `{tokens}` pass through
  literally).

## Test plan

- PY `tests/unit/test_source_policy.py`: template substitution; `{denied_tlds_line}`
  empty-case newline consumption; absent `prompt_block` ⇒ default unchanged;
  `clean()` keeps non-empty / drops empty `prompt_block`, last-key order.
- TS `src/config/source_policy.test.ts`: mirror each, plus a byte-for-byte
  `canonicalPolicyJson` parity assertion against the Python `canonical_json`
  expected string for a representative template.
- Integration: `/source-policy` preview + save round-trip with a template.
- `node deploy/cloudflare-workers/parity/check-parity.mjs` stays green (default
  read-only routes unchanged).

## Deploy

- No DB migration.
- Backend (Workers) + web both redeploy. Web redeploy also fixes (1) — rebuild
  carries the new `api.ts`. Both backends must deploy together for sha parity on
  any `prompt_block` that gets saved.

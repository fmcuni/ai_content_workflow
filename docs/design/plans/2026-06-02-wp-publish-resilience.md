# Plan: Resilient WordPress publish

Implements [spec](../specs/2026-06-02-wp-publish-resilience.md). TDD throughout:
write failing tests first, then the minimal implementation, then refactor.

## Branch

`fix/wp-publish-resilience` off `main`.

## Work breakdown

Two independent file sets (Python vs TS) → implemented by two parallel
sub-agents, each owning its backend end-to-end (tests + impl). A third pass
(orchestrator) verifies parity, runs both suites, lints/typechecks, and reviews.

### Stream A — Python (`content_tool/wordpress/client.py`)

1. **RED:** create `tests/unit/test_wp_client_resilience.py` with spec cases
   1–14 using `respx`. Construct `WordPressClient(..., max_attempts=3,
   backoff_base=0.0)`. Run → must fail.
2. **GREEN:** in `client.py`:
   - Add `max_attempts`, `backoff_base`, and an injectable `sleep` to `__init__`
     (defaults: `3`, `0.5`, `asyncio.sleep`).
   - Extract a private `_classify(resp) -> Outcome` and a `_parse_publish_result`
     that applies the content-type guard + `try/except json.JSONDecodeError`
     (reuse the exact guard wording from `fetch_post_by_url`).
   - Wrap the request in the attempt loop; PUT retries directly, POST goes
     through the read-back gate.
   - Add `find_post_by_slug(slug)` returning the discriminated read-back result
     (`status=any`, `_fields=id,link,status,slug,modified_gmt`); non-JSON →
     `unknown` (never raises out).
   - Keep `upsert()`'s external signature and return type unchanged.
3. **REFACTOR:** keep functions <50 lines; no mutation; precise type hints
   (pyright strict — don't add new errors in this file).
4. Add one integration case to `tests/integration/test_publish_node.py`:
   transient infra block then success → `run.status == "published"`.

### Stream B — TypeScript (`deploy/cloudflare-workers/src/wordpress/client.ts`)

1. **RED:** create `src/wordpress/client_resilience.test.ts` mirroring spec cases
   1–14 with `vi.stubGlobal("fetch", ...)`. Construct the client with zero
   backoff + injected `sleep`. Run `npx vitest run` → must fail.
2. **GREEN:** in `client.ts`:
   - Add resilience options (`maxAttempts = 3`, `backoffBaseMs = 500`, injectable
     `sleep`) to the constructor/`Env` wiring without breaking existing `new
     WordPressClient(env)` callers.
   - Factor `classifyResponse` + `parsePublishResult` (wrap `JSON.parse` in
     try/catch → `WordPressError`); reuse `assertJsonContentType` semantics but
     return a classification rather than throwing for the retry path.
   - Attempt loop: PUT retries directly; POST goes through `findPostBySlug` gate.
   - Add `findPostBySlug(slug)` (`status=any`, same `_fields`); non-JSON →
     `{ kind: "unknown" }`.
   - Preserve `upsert()` signature and `PublishResult` shape.
3. **REFACTOR:** no `any`; `unknown` + narrowing for response data; immutable
   request body building.
4. `npm run typecheck` (tsc --noEmit) clean.

### Stream C — Orchestrator verification (after A & B)

1. `pytest tests/unit/test_wp_client_resilience.py tests/unit/test_wp_client.py
   tests/integration/test_publish_node.py` green.
2. `ruff check content_tool/wordpress tests` and `pyright content_tool/wordpress`
   add no new errors.
3. `cd deploy/cloudflare-workers && npx vitest run && npm run typecheck` green.
4. `node deploy/cloudflare-workers/parity/check-parity.mjs` green.
5. Diff Python vs TS for behavioral parity (attempt counts, classification,
   read-back semantics).
6. `code-reviewer` + `security-reviewer` pass on the diff.

## Guardrails for sub-agents

- **Do NOT touch, stash, reset, or restore** any pre-existing unstaged files
  (`config/pricing.yaml`, `content_tool/api/routes/costs.py`,
  `deploy/cloudflare-workers/src/config/pricing.ts`, `.../db/costs*.ts`,
  `.../routes/costs.ts`, `tests/unit/test_cost.py`). Edit only the files named in
  your stream.
- GateGuard will block the first Edit/Write per file: first list importers / read
  the file / restate the user instruction, then proceed.
- No secrets, no real WP credentials, no PII in tests — use `wp.example.com` and
  fake auth, matching existing fixtures.

## Definition of done

- All spec test cases pass in both backends; existing WP tests still pass.
- Lint + typecheck clean (no new pyright/tsc errors); parity gate green.
- Spec test 12/13 prove no duplicate POST on create under infra failure.
- PR opened with summary + test plan; both Workers deploy on merge.

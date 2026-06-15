# Spec: Resilient WordPress publish (guard + retry + read-back)

- **Date:** 2026-06-02
- **Status:** Approved for implementation
- **Scope:** `content_tool/wordpress/client.py` (Python reference) and
  `deploy/cloudflare-workers/src/wordpress/client.ts` (production TS port).
- **Out of scope:** Gemini JSON parsing, render control-char stripping, meta
  double-encoding (these are separate hardening items, not the publish symptom).

## Problem

Operators intermittently see a "broken JSON" error when publishing to WordPress,
on **both** create (POST) and update (PUT) flows. The publish node itself does
no JSON parsing — the only JSON parsed at publish time is **WordPress's HTTP
response** inside `WordPressClient.upsert()`.

The infra team **blocks/strips all WordPress error responses**. So when WP (or
the edge/WAF/CloudFront in front of it) errors, our backend does not receive
WP's JSON error body — it receives an HTML challenge page, an empty body, or a
truncated payload. The client then parses that as JSON and crashes.

Confirmed gaps in the current code:

- **Python `upsert()` (`client.py:158`)** calls `resp.json()` with **no**
  content-type / non-empty guard — unlike `fetch_post_by_url`, `_list_paginated`,
  and `_get_single`, which all guard. A `2xx`-with-non-JSON infra block crashes
  here with a raw `json.JSONDecodeError`.
- **TS `upsert()` (`client.ts:200-212`)** has the `2xx`-non-JSON guard, but
  `JSON.parse(rawText)` still throws raw `SyntaxError` when the body *claims*
  `application/json` but is truncated/malformed.
- **Neither backend retries.** A single transient infra blip fails the whole
  publish, even though a retry would almost always succeed.

Because infra strips the body, snippeting the response body is useless. We must
**classify on transport outcome + status + content-type/headers**, not on body
content.

## Goals

1. **No raw decode error ever escapes `upsert()`** — every failure is a typed
   `WordPressError`/`WordPressConflictError` with a diagnosable message built
   from status, content-type, byte length, and `x-cache`.
2. **Transient infra failures are retried** with bounded backoff, so the
   "few times" failures stop surfacing to operators.
3. **A create (POST) retry NEVER produces a duplicate post.** Retrying POST is
   only allowed after a slug read-back proves the post does not already exist.
4. **Byte-for-byte behavioral parity** between the Python and TS clients, locked
   in by mirrored tests.

## Non-goals

- Changing the publish node (`publish.py`) or the TS workflow/route call sites.
  Both already catch `WordPressError` and persist `wp_push_error`; the new logic
  lives entirely inside `upsert()` and a new read-back helper.
- Changing the request payload, meta encoding, or SEO detection.

## Outcome classification

After each HTTP attempt, classify the result into exactly one of:

| Outcome | Trigger | Action |
|---|---|---|
| **SUCCESS** | `2xx` + `content-type: application/json` + body parses to JSON | return `PublishResult` |
| **CONFLICT** | HTTP `412` | raise `WordPressConflictError` immediately — **no retry** (genuine optimistic-lock conflict) |
| **WP_REJECT** | `4xx` (not 412) **and** body parses as JSON | raise `WordPressError("<status>: <message>")` — **no retry** (deterministic WP rejection: bad slug, bad author, validation) |
| **RETRIABLE** | transport error, timeout/abort, `5xx`, **or any non-JSON / unparseable body regardless of status** | retry per policy below |

Rationale for "non-JSON body ⇒ RETRIABLE regardless of status": WP REST always
answers with JSON, even for its own errors. A non-JSON body therefore means the
response did not come from WP itself — it is an infra block/edge failure, which
is transient. Retrying a genuinely-persistent infra `403` simply exhausts the
attempts and then surfaces a clear `WordPressError`; the only real cost is a few
extra calls. This trade-off is deliberate and documented.

## Retry policy

- `max_attempts = 3` total (1 initial + 2 retries). Configurable on the client
  constructor for tests.
- Backoff before retry: `backoff_base * 2**(attempt-1)` seconds
  (default `backoff_base = 0.5` → 0.5s, 1.0s). Tests construct the client with
  `backoff_base = 0` so they never actually sleep. The sleeper is injectable
  (Python: `asyncio.sleep`; TS: a `sleep` function defaulting to `setTimeout`).
- `CONFLICT` and `WP_REJECT` never retry.
- On the final attempt, a `RETRIABLE` outcome raises a `WordPressError`
  describing the last observed failure.

## Idempotency: read-back gate (the critical safety rule)

Retries differ by HTTP method:

### Update (PUT, `post_id` is set) — idempotent
PUT to the same post id is idempotent, so a `RETRIABLE` outcome may retry the
PUT directly. (Optional short-circuit: a read-back by `post_id` that confirms
the post was already modified can return success, but the simple, safe behavior
is "just retry the PUT".) Implementation: **retry the PUT directly.**

### Create (POST, `post_id` is null) — NOT idempotent
A blind POST retry can double-publish. Before **each** retry of a create, run a
**slug read-back**:

1. If `payload.slug` is `None`/empty → **do not retry**; raise the classified
   `WordPressError` (we cannot prove absence of a duplicate, so failing loudly
   is safer than risking a duplicate). Message must say read-back was impossible
   because no slug was supplied.
2. Else call the new read-back helper `find_post_by_slug(slug)` /
   `findPostBySlug(slug)` which queries
   `GET /wp/v2/posts?slug=<slug>&status=any&_fields=id,link,status,slug,modified_gmt`
   (authenticated, so non-published statuses are visible). It returns one of:
   - **FOUND(post)** → the create already landed (response was blocked).
     Return a `PublishResult` built from the found post. **Success, no retry.**
   - **NOT_FOUND** → no such post exists yet → safe to retry the POST.
   - **UNKNOWN** → the read-back itself failed/was blocked (non-JSON, transport
     error). We cannot prove absence of a duplicate → **do not retry**; raise the
     classified `WordPressError` noting the read-back was inconclusive.

The read-back helper reuses the existing content-type guard pattern; a non-JSON
read-back response maps to **UNKNOWN** (it does not throw out of the gate).

> WP `status=any` requires authentication; the client always sends Basic auth, so
> draft create posts are visible to the read-back. Verify against the live target
> during implementation (see Verification).

## Public API changes

- `upsert()` signature is unchanged for existing callers (`publish.py`,
  `production.ts:738`, `routes/runs.ts:1748`). New behavior is internal.
- Client constructors gain optional, defaulted resilience params:
  - Python: `WordPressClient(..., max_attempts: int = 3, backoff_base: float = 0.5, sleep=asyncio.sleep)`
  - TS: a small options object or extra constructor fields; default
    `maxAttempts = 3`, `backoffBaseMs = 500`, injectable `sleep`.
- New method: `find_post_by_slug(slug: str) -> ReadbackResult` /
  `findPostBySlug(slug: string): Promise<ReadbackResult>` returning a small
  discriminated result `{ kind: "found"; post } | { kind: "not_found" } | { kind: "unknown" }`.

## Test plan (TDD — write first, must fail, then implement)

Mirror these cases in **both** `tests/unit/test_wp_client_resilience.py` (respx)
and `deploy/cloudflare-workers/src/wordpress/client_resilience.test.ts`
(`vi.stubGlobal("fetch", ...)`), constructing clients with zero backoff:

1. **Update success unchanged** — 200 + JSON → returns result, exactly one call.
2. **Update: 2xx + HTML body (infra block), then 200 JSON** → retries PUT,
   succeeds, two calls, no raw decode error.
3. **Update: 200 + `content-type: application/json` but truncated body, then 200
   JSON** → retries, succeeds. (Guards the `JSON.parse`/`resp.json()` crash.)
4. **Update: 5xx then 200** → retries, succeeds.
5. **Update: transport error then 200** → retries, succeeds.
6. **Update: persistent non-JSON for all attempts** → raises `WordPressError`
   (not a decode error) after exactly `max_attempts` calls; message includes
   status + content-type + x-cache.
7. **412 on update** → raises `WordPressConflictError`, exactly one call (no retry).
8. **4xx + JSON error body on update** → raises `WordPressError`, one call (no retry).
9. **Create success unchanged** — POST 201 + JSON → returns result, one call.
10. **Create: infra block on POST, read-back FINDS the post** → no second POST;
    returns `PublishResult` from the read-back; asserts only one POST was issued.
11. **Create: infra block on POST, read-back NOT_FOUND** → second POST issued,
    succeeds.
12. **Create: infra block on POST, read-back itself blocked (UNKNOWN)** → raises
    `WordPressError`; asserts only one POST issued (no duplicate).
13. **Create with `slug=None`, infra block** → raises `WordPressError`; no second
    POST; message states read-back impossible without slug.
14. **`find_post_by_slug` query shape** — asserts it requests `status=any` and the
    expected `_fields`.

Integration (Python, respx; existing `tests/integration/test_publish_node.py`
style): one test that a transient infra block followed by success still results
in `run.status == "published"` and the correct `wp_pushed_post_id`.

## Real-world verification target

Run `dda47065-7a64-4d67-8845-3e6f5e10537c`
(`https://bowtie-content-tool-web.fmc.workers.dev/runs/dda47065-...`) is the
operator-reported repro. After deploy, re-trigger its publish and confirm: (a)
no "broken JSON" error, (b) on a forced infra blip it retries and either succeeds
or fails with a clear classified message, (c) no duplicate post is created.

## Parity & rollout

- Identical classification, retry counts, backoff schedule, and read-back
  semantics in both backends.
- `node deploy/cloudflare-workers/parity/check-parity.mjs` stays green (read-only
  routes unaffected).
- Ship Python + TS together in one PR; both Workers deploy via CI on merge.

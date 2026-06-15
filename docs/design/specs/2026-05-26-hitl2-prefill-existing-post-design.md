# hitl2 prefill from existing WP post + WP post id display

**Status:** Design approved
**Date:** 2026-05-26
**Surface:** `web/app/runs/[runId]/hitl2/page.tsx` — header kicker + right-rail WP metadata form prefill

## Problem

The HITL-2 reviewer form on a refresh run starts with the WP-side fields blank: Author, Category, Tags, Featured media id, Post date, Slug. Publish status defaults to "draft". The reviewer has no in-app indication of which WordPress post is being updated — to find that out today they'd have to read the run row in the DB or open the article URL from the runs page.

Two consequences:

1. **Wrong-post anxiety.** No header shows "WP #98785"; reviewers approve changes that *go somewhere*, trusting the run was set up correctly. There's no quick "open the existing post in WP" link from the review screen.
2. **Empty fields imply "clear this on publish".** A reviewer who doesn't touch Author/Category/Slug submits `null`s, and the publish agent sends those nulls to WP REST — silently re-attributing or re-slugging the post.

## Goals

1. Show the existing WP post id in the page header, as a link to the post's front-end URL.
2. Prefill **Author**, **Category** (single), and **Slug** from the existing WP post so an unmodified submit preserves the live values.
3. Give the reviewer a "Re-read from WP" button to refresh those three fields against the live post, with a confirmation dialog when their edits would be overwritten.

## Non-goals

- Prefilling **Tags**, **Featured media**, or **Post date**. Tags and featured media are typically intentional reviewer choices; post date is the new scheduling primitive (default = WP's own clock).
- Prefilling **SEO title / meta description / Excerpt**. Those already come from the AI render on purpose — those are the *new* proposed values; the existing post's title is in the diff view if the reviewer wants to compare.
- A wp-admin direct edit link (`/wp-admin/post.php?post=<id>`). Using the public `link` (the post's canonical front-end URL) instead — any reviewer can read it without WP admin permissions.
- Showing existing post `status` / `modified_gmt` / categories with names in the header.

## Verified context

The existing fetch_article agent (`content_tool/agents/fetch_article.py`) already calls `wp_client.fetch_post_by_url(article_url)` at run start, which returns a `FetchedPost` dataclass with `id`, `slug`, `link`, `author`, and `categories`. Today, only `id` (`wp_post_id`) and the resolved category list (with name+slug, via a second WP call) are persisted on the `FetchedArticle` row. The `author`, `slug`, and `link` come back from WP but are dropped on the floor.

So the prefill data is essentially already in our hands at fetch time; we just don't persist it.

## Architecture

```
runs/[runId]/hitl2/page.tsx
  │
  ├─ useQuery(["run", runId])                 ── existing
  ├─ useQuery(["render", runId])              ── existing (AI-generated title/desc/excerpt)
  └─ useQuery(["existing-post", runId])       ── NEW
       │
       └─ GET /runs/:run_id/existing-post
            │
            └─ reads cached row from FetchedArticle
                 (wp_post_id, wp_link, wp_author_id, wp_categories[0], wp_slug)

"Re-read from WP ↻" button
  │
  └─ POST /runs/:run_id/existing-post/refresh
       │
       └─ wp_client.fetch_post_by_url(run.article_url)
            │
            └─ UPDATE FetchedArticle SET wp_author_id, wp_slug, wp_link, wp_categories = ...
            └─ returns fresh shape
```

## Schema

**Alembic migration `0008_fetched_article_existing_post_fields.py`** adds three nullable columns to `content_tool.fetched_articles`:

| Column | Type | Notes |
|---|---|---|
| `wp_author_id` | `INTEGER NULL` | WP user id of the existing post's author. |
| `wp_slug` | `TEXT NULL` | WP slug of the existing post (e.g. `"cancer-screening"`). |
| `wp_link` | `TEXT NULL` | Canonical front-end URL returned by WP REST `link`. |

Existing rows backfill as `NULL`. Reversible (`op.drop_column` for each in `downgrade`).

`content_tool/db/models.py`'s `FetchedArticle` adds the three matching mapped columns.

## Backend changes

### `content_tool/agents/fetch_article.py`

Already fetches `FetchedPost` via `wp_client.fetch_post_by_url(article_url)`. Persist three more fields on the row:

```python
session.add(
    FetchedArticle(
        run_id=run_id,
        wp_post_id=post.id,
        wp_categories=cats,
        wp_author_id=post.author,      # NEW
        wp_slug=post.slug,             # NEW
        wp_link=post.link,             # NEW
        raw_html=html,
        markdown=markdown,
    )
)
```

The return dict picks up the same three keys (existing callers don't read them today; adding is forward-safe).

### `content_tool/api/routes/runs.py` — two new endpoints

**`GET /runs/{run_id}/existing-post`** — read cached row.

Response shape:

```python
class ExistingPostOut(BaseModel):
    wp_post_id: int
    link: str | None              # may be null on legacy rows that pre-date this feature
    wp_author_id: int | None
    wp_category_id: int | None    # first element of wp_categories[] or null
    wp_slug: str | None
```

- 200 if a `FetchedArticle` row exists with non-null `wp_post_id`.
- 404 if no row, or if `wp_post_id` is null (new-post path).
- Endpoint is read-only; no auth changes.

**`POST /runs/{run_id}/existing-post/refresh`** — live-fetch from WP.

- Calls `wp_client.fetch_post_by_url(run.article_url)`.
- If WP returns None (post was deleted / slug changed): 404, body `{"detail": "Existing post not found on WordPress"}`.
- If WP raises `WordPressError`: 502, body `{"detail": "WordPress upstream error"}` (raw error logged server-side — same pattern as `/wp-options`).
- On success: `UPDATE FetchedArticle SET wp_author_id = ?, wp_slug = ?, wp_link = ?, wp_categories = ? WHERE run_id = ?` (refreshes only the fields tied to the existing post; leaves `raw_html`, `markdown`, `wp_post_id` alone — those drove the writer and shouldn't shift retroactively).
- The `wp_categories` refresh re-resolves names by hitting `/wp/v2/categories?include=...` the same way fetch_article does today.
- Returns the same `ExistingPostOut` shape as the GET.

Both endpoints surface as `/api/runs/:id/existing-post*` through the existing Next.js rewrite (`/api/runs/:path*`). No new rewrite required.

## Frontend changes

### `web/lib/types.ts`

```ts
export interface ExistingPost {
  wp_post_id: number;
  link: string | null;
  wp_author_id: number | null;
  wp_category_id: number | null;
  wp_slug: string | null;
}
```

### `web/lib/api.ts`

```ts
getExistingPost: (runId: string) =>
  http<ExistingPost>(`${BASE}/${runId}/existing-post`),
refreshExistingPost: (runId: string) =>
  http<ExistingPost>(`${BASE}/${runId}/existing-post/refresh`, { method: "POST" }),
```

### `web/app/runs/[runId]/hitl2/page.tsx`

**State additions:**

- New query: `existingPost = useQuery({ queryKey: ["existing-post", runId], queryFn: () => api.getExistingPost(runId), retry: false })`. The `retry: false` keeps the React Query default of 3 retries from spamming 404s on the new-post path.
- `prefilledRef = useRef<ExistingPost | null>(null)` — snapshot of what was last applied to the form, used for dirty detection.

**Prefill effect** (new sibling effect — same component owns both render-prefill and existing-post-prefill):

```tsx
useEffect(() => {
  if (!existingPost.data) return;
  if (prefilledRef.current !== null) return; // already prefilled; refresh path uses its own setter
  prefilledRef.current = existingPost.data;
  setForm(f => ({
    ...f,
    wp_author_id: existingPost.data!.wp_author_id,
    wp_category_ids: existingPost.data!.wp_category_id != null
      ? [existingPost.data!.wp_category_id]
      : null,
    wp_slug: existingPost.data!.wp_slug,
  }));
}, [existingPost.data]);
```

The `prefilledRef.current !== null` gate ensures the effect runs exactly once per page load. Without it, a slow `existing-post` query that resolves *after* the reviewer has cleared a field to `null` would race-clobber the cleared state. After the first prefill, only the explicit `refresh.onSuccess` path mutates `prefilledRef` and the form together — the effect becomes a no-op.

**Header kicker** — extend the existing `<SectionHead kicker={...}>`:

```tsx
<SectionHead
  kicker={
    <>
      Galley Proof · Stage 2 · <span className="text-accent">{shortId}</span>
      {existingPost.data?.wp_post_id != null && (
        <>
          {" · "}
          <a
            href={existingPost.data.link ?? "#"}
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent hover:underline"
          >
            WP #{existingPost.data.wp_post_id} ↗
          </a>
          {" "}
          <button
            type="button"
            onClick={handleRereadClick}
            disabled={refresh.isPending}
            className="ml-2 font-mono text-[11px] text-ink-faint hover:text-ink uppercase tracking-wider"
          >
            {refresh.isPending ? "↻ Reading…" : "↻ Re-read from WP"}
          </button>
        </>
      )}
    </>
  }
  ...
/>
```

**Re-read mutation:**

```tsx
const refresh = useMutation({
  mutationFn: () => api.refreshExistingPost(runId),
  onSuccess: (fresh) => {
    prefilledRef.current = fresh;
    setForm(f => ({
      ...f,
      wp_author_id: fresh.wp_author_id,
      wp_category_ids: fresh.wp_category_id != null ? [fresh.wp_category_id] : null,
      wp_slug: fresh.wp_slug,
    }));
    qc.setQueryData(["existing-post", runId], fresh);
  },
  onError: () => toast.error("Couldn't re-read from WordPress"),
});
```

**Dirty check + confirm dialog:**

`handleRereadClick` compares current form values to `prefilledRef.current`. If any of the three fields differ, opens a `Dialog` ("This will overwrite your edits to: Author, Category, Slug. Continue?") with Cancel + Confirm. On Confirm — or if there are no dirty fields — fires `refresh.mutate()`. The dirty-field list in the dialog is dynamic; only mention the fields actually dirty.

Reuses `web/components/ui/dialog.tsx` (already present, used by `DismissDialog`).

### Initial form state — small refinement

The current `useState<Hitl2Request>({ decision: "approve", wp_publish_status: "draft" })` means `wp_author_id`, `wp_category_ids`, `wp_slug` are `undefined`. The `??` chain in the prefill effect treats `undefined` as "not yet set" and applies the prefill. After prefill, those keys exist (with whatever value) and won't be re-set on subsequent existing-post fetches. Good.

## Failure modes

| Scenario | Behavior |
|---|---|
| `FetchedArticle.wp_post_id` is null | `/existing-post` → 404; React Query treats as no data; header kicker omits WP segment; form doesn't prefill. No error UI. |
| `/existing-post` returns 500 | React Query keeps `existingPost.data == undefined`; nothing prefilled; header omits WP segment. (Indistinguishable from "no existing post" — acceptable since reviewers can fall back to manual entry.) |
| Refresh button: WP returns no post (slug changed) | 404 from backend; `onError` toasts "Couldn't re-read from WordPress"; form unchanged. |
| Refresh button: WP times out / 5xx | 502 from backend; same toast; form unchanged. |
| Reviewer types in Author, then clicks ↻, then Cancel | Dialog closes; no refetch fires; form preserved. |
| Reviewer clicks ↻ with no edits | No dialog; refresh fires immediately. |
| Reviewer is mid-typing in Slug and the refresh succeeds (race) | Form's Slug gets overwritten with WP's slug. Acceptable — they confirmed the dialog. (Avoiding this race would require disabling the input during the mutation; not worth the complexity.) |

## Testing

### Backend unit tests

- `tests/unit/test_existing_post_route.py` (new):
  - `GET /runs/:id/existing-post` returns 200 + correct shape from seeded `FetchedArticle`.
  - Returns 404 when no `FetchedArticle` row exists.
  - Returns 404 when `wp_post_id` is null.
  - `wp_category_id` is `wp_categories[0]["id"]` or null when the list is empty.
- `tests/unit/test_existing_post_refresh.py` (new):
  - Refresh path: mocks `fetch_post_by_url`, asserts the FetchedArticle row gets updated with new author/slug/link/categories.
  - WP returns None → 404.
  - `WordPressError` → 502 with sanitized detail.

### Backend integration

- `tests/integration/test_fetch_article.py` (extend, if it exists, otherwise skip): seed a WP mock returning a `FetchedPost` with author/slug/link; assert the new columns are persisted.

### Migration

- Add `tests/unit/test_migrations.py` case (if the project has migration tests) — otherwise just verify `alembic upgrade head && alembic downgrade -1` round-trips cleanly in the plan's manual verification step.

### Frontend

No new automated tests (project doesn't have a frontend test runner). Manual verification:

1. Open a hitl2 run with a known existing WP post id — header shows `WP #<id> ↗` link; clicking opens the post in a new tab.
2. WP metadata form shows the existing author / category / slug prefilled.
3. Edit slug; click ↻ → confirm dialog lists "Slug"; Confirm → slug snaps back to the WP value.
4. Edit slug; click ↻ → Cancel → slug unchanged.
5. Click ↻ with no edits → no dialog, mutation fires immediately, form unchanged (WP didn't change).
6. Open a hitl2 run without `wp_post_id` (or stub the endpoint to 404) — kicker omits the WP segment; form prefill is skipped silently.

## Out of scope / future work

- Polish for the "wp-admin edit" workflow (a separate icon link to `/wp-admin/post.php?post=<id>`).
- Showing the existing post's `modified_gmt` near the WP # so reviewers can see how fresh the cached fetch is.
- Auto-refreshing the existing-post snapshot on a timer.
- Carrying tags / featured media / scheduled date through from the existing post (deliberately deferred per current decisions).

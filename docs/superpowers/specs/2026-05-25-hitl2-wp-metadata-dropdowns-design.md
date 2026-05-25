# hitl2 WP metadata: searchable author/category dropdowns + post date

**Status:** Design approved
**Date:** 2026-05-25
**Surface:** `web/app/runs/[runId]/hitl2/page.tsx` → right-rail "WP metadata" form

## Problem

The editor's HITL-2 review form (`WordPressMetaForm.tsx`) asks for:

- **Author** as a raw WP user id (numeric input).
- **Categories** as a comma-separated string of WP category ids.
- No way to set a **post date**, even though `wp_publish_at` exists in the schema (DB column + Pydantic field + TS type) but is never sent to WordPress on publish.

Editors don't know WP ids by heart. There are 266 author accounts and 107 categories in production WP, several of which share names across English/Chinese locales. Manually copying ids from `/wp-admin` is friction at best and a data-quality risk (wrong author / wrong category, no validation).

## Goals

1. Replace the author and category numeric inputs with **searchable single-select dropdowns** populated live from WordPress.
2. Add an **optional post date picker** that flows through to WP REST as `date_gmt` on publish.

## Non-goals

- Multi-select categories. (Reviewers will pick one. WP supports many, but we ship single-select first.)
- "Primary category" marker for Yoast/Rank Math.
- Tag dropdown — tags remain comma-separated ids for now.
- Featured media picker.
- Webhook-driven cache invalidation. TTL-only is fine.

## Verification of WP REST contract (2026-05-25)

Tested against `https://www.bowtie.com.hk/blog/wp-json/wp/v2/` via the existing app-password account, from inside a browser session (CloudFront WAF blocks non-browser clients from this dev IP):

| Endpoint | Status | `X-WP-Total` | `X-WP-TotalPages` |
|---|---|---|---|
| `categories?per_page=100&hide_empty=false&_fields=id,name,slug` | 200 | 107 | 2 |
| `users?per_page=100&_fields=id,name,slug` | 200 | 266 | 3 |
| `users?per_page=100&context=edit&_fields=id,name,slug` | 200 | 266 | 3 |

Observations that shape the design:

- **Pagination required** — `per_page=100` is WP's max, so the backend must walk pages until `X-WP-TotalPages`.
- **`context=edit` is unnecessary** — the default returns all 266 users, so we avoid the extra `list_users` capability requirement.
- **Duplicate display names** are real (e.g. "Bowtie Story" appears for id=1719 and id=4311 — EN vs zh variants). The UI must let editors disambiguate by `slug`.

## Architecture

```
   web/                              content_tool/
   ─────────────────────────────     ───────────────────────────────────
   hitl2/page.tsx                    api/routes/wp_options.py    NEW
     └─ WordPressMetaForm.tsx          GET /wp-options/users
         ├─ SearchableSelect    NEW    GET /wp-options/categories
         └─ DateTimeField       NEW         │
   lib/api.ts                              ▼
     ├─ listWpUsers()           NEW    wordpress/client.py
     └─ listWpCategories()      NEW      ├─ list_users()        NEW
                                         └─ list_categories()   NEW
   next.config.mjs                            │
     /api/wp-options/* rewrite                ▼
                                       wp_options_cache.py     NEW
                                       (in-process TTL cache)
                                              │
                                              ▼
                                     https://.../wp-json/wp/v2/...

   On publish:
   agents/publish.py → PublishPayload(date_gmt=...) → WordPressClient.upsert
```

## Backend

### `WordPressClient` additions (`content_tool/wordpress/client.py`)

```python
@dataclass
class WpUser:
    id: int
    name: str
    slug: str

@dataclass
class WpCategory:
    id: int
    name: str
    slug: str

async def list_users(self) -> list[WpUser]: ...
async def list_categories(self) -> list[WpCategory]: ...
```

Both methods:

- `GET /wp-json/wp/v2/{users|categories}?per_page=100&_fields=id,name,slug` (+ `hide_empty=false` for categories).
- Read `X-WP-TotalPages` from page 1 response; loop `page=2..N` if needed.
- Surface non-2xx and non-JSON responses as `WordPressError` (same handling as `fetch_post_by_url` for CloudFront edge errors).
- Return concatenated typed list.

### `wp_options.py` router (`content_tool/api/routes/wp_options.py`)

```python
router = APIRouter(prefix="/wp-options", tags=["wp-options"])

@router.get("/users")
async def list_users(request: Request) -> list[dict]:
    return await _cached(request.app.state.wp_client, "users")

@router.get("/categories")
async def list_categories(request: Request) -> list[dict]:
    return await _cached(request.app.state.wp_client, "categories")
```

Wired in `content_tool/api/main.py` alongside the other routers.

### Cache (`content_tool/api/wp_options_cache.py`)

Tiny in-process TTL cache (no external deps). Keyed by `(base_url, kind)`. TTL = 10 minutes. `asyncio.Lock` per key so concurrent requests during a cold cache coalesce into one WP fetch.

```python
class TtlCache:
    def __init__(self, ttl_seconds: int) -> None: ...
    async def get_or_set(self, key: str, loader: Callable[[], Awaitable[T]]) -> T: ...
```

Not module-level singletons — instantiated on app startup and stashed on `app.state.wp_options_cache`, so tests can inject a fresh one.

### Wiring `wp_publish_at` into publish

In `content_tool/wordpress/client.py`:

```python
@dataclass
class PublishPayload:
    ...
    date_gmt: str | None   # NEW — ISO 8601 UTC, no trailing Z (e.g. "2026-05-25T14:30:00")
```

In `WordPressClient.upsert`, add `if p.date_gmt is not None: body["date_gmt"] = p.date_gmt`.

In `content_tool/agents/publish.py`:

```python
date_gmt = None
if run.wp_publish_at is not None:
    date_gmt = run.wp_publish_at.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")
```

Pass `date_gmt=date_gmt` into the payload.

### Next.js rewrite (`web/next.config.mjs`)

Add: `{ source: "/api/wp-options/:path*", destination: `${apiBase}/wp-options/:path*` }`.

## Frontend

### `SearchableSelect.tsx` (new component)

Single-purpose searchable single-select. Built on `@base-ui/react`'s `Combobox` primitive (already in `package.json` — gives keyboard nav, focus management, and accessible popover for free).

**Props:**

```ts
type Option = { id: number; name: string; slug: string };

interface Props {
  value: number | null;
  onChange: (v: number | null) => void;
  options: Option[];
  placeholder?: string;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  disabled?: boolean;
}
```

**Behavior:**

- Trigger renders the selected option's `name` (or placeholder).
- Popover contains a `<input>` for filtering plus a scrollable list (max-height ~280px, no virtualization needed at 107 / 266 rows).
- Filter is case-insensitive substring match against `name` AND `slug`.
- When two visible options share the same `name`, render them as `name · slug` to disambiguate.
- A clear button (`✕`) sets `value` back to `null`.
- Loading state: trigger text shows "Loading…" and the popover is disabled.
- Error state: trigger shows "Failed — retry"; clicking calls `onRetry`.

Styled to match existing form inputs (border, padding, focus ring on `--accent`).

### `DateTimeField.tsx` (new component)

```ts
interface Props {
  value: string | null;             // UTC ISO, e.g. "2026-05-25T06:30:00Z"
  onChange: (v: string | null) => void;
  label?: string;
}
```

- Two side-by-side controls:
  - **Date** — `react-day-picker` (already a dep, already wrapped in `components/ui/calendar.tsx`) inside a popover button. Button shows the selected date in HKT (e.g. "25 May 2026").
  - **Time** — native `<input type="time">` for `HH:mm` (24-hour).
- Internal state is held as `{ hkDate: 'YYYY-MM-DD', hkTime: 'HH:mm' }`, both interpreted as Asia/Hong_Kong wall clock. On change, the component builds an offset-aware UTC ISO string by treating the chosen wall clock as `+08:00` (HK has no DST), then converting to UTC. This avoids depending on the browser's locale — a traveling editor still picks "HK time".
- Helper text below: "Hong Kong time. Leave blank to use WP default."
- Clear button (`✕`) sets value to `null`.

### `WordPressMetaForm.tsx` changes

Replaces:

```tsx
<Label>Author (WP user id)</Label>
<Input type="number" value={form.wp_author_id ?? ""} ... />

<Label>Category IDs (comma)</Label>
<Input value={form.wp_category_ids?.join(",") ?? ""} ... />
```

With:

```tsx
<Label>Author</Label>
<SearchableSelect
  value={form.wp_author_id ?? null}
  onChange={(v) => onChange({ ...form, wp_author_id: v })}
  options={users.data ?? []}
  loading={users.isPending}
  error={users.isError ? (users.error as Error).message : null}
  onRetry={() => users.refetch()}
  placeholder="Search author…"
/>

<Label>Category</Label>
<SearchableSelect
  value={form.wp_category_ids?.[0] ?? null}
  onChange={(v) => onChange({ ...form, wp_category_ids: v == null ? null : [v] })}
  options={categories.data ?? []}
  loading={categories.isPending}
  error={categories.isError ? (categories.error as Error).message : null}
  onRetry={() => categories.refetch()}
  placeholder="Search category…"
/>
```

And appends a new field after "Featured media id" (last in the form):

```tsx
<Label>Post date (optional, HKT)</Label>
<DateTimeField
  value={form.wp_publish_at ?? null}
  onChange={(v) => onChange({ ...form, wp_publish_at: v })}
/>
```

React Query setup (in `WordPressMetaForm` or a tiny `useWpOptions` hook):

```ts
const users = useQuery({
  queryKey: ["wp-users"],
  queryFn: api.listWpUsers,
  staleTime: 10 * 60_000,
  gcTime: 30 * 60_000,
});
const categories = useQuery({ queryKey: ["wp-categories"], queryFn: api.listWpCategories, ... });
```

### `lib/api.ts` additions

```ts
listWpUsers: () => http<{ id: number; name: string; slug: string }[]>("/api/wp-options/users"),
listWpCategories: () => http<{ id: number; name: string; slug: string }[]>("/api/wp-options/categories"),
```

### `lib/types.ts` — no change

`wp_publish_at` and `wp_category_ids` are already there. We're just starting to populate them.

## Submit payload semantics

- `wp_author_id`: number or null. Unchanged on the wire.
- `wp_category_ids`: `[id]` when set, `null` when cleared. (Server already accepts list-of-int.)
- `wp_publish_at`: UTC ISO string (with `Z`). Already accepted by Pydantic as `datetime`.

No `Hitl2Request` schema changes.

## Failure modes

| Scenario | Behavior |
|---|---|
| WP returns 5xx on `list_users` | Backend returns 502 → frontend shows "Failed — retry" in dropdown trigger. Editor can still type submit but author field stays empty. |
| WAF challenge / CloudFront empty body | Same path as `fetch_post_by_url` — `WordPressError` with diagnostic; 502. |
| WP user account loses `read` capability | Same as above; the form is reviewer-driven so we don't fall back. Reviewer reports to ops. |
| Editor picks `wp_publish_at` in the past, `wp_publish_status = "future"` | WP rejects with 400. Surfaced via existing publish error path (`wp_push_error` JSON on run row + toast). No client-side pre-validation. |
| Editor picks `wp_publish_at` in the past, `wp_publish_status = "publish"` | WP accepts and backdates the post — current WP default behavior. We do not warn. |

## Testing

### Backend unit tests

- `tests/unit/test_wp_options.py`:
  - Mocks httpx; verifies pagination loop stops at `X-WP-TotalPages` and returns concatenated list.
  - Verifies cache: second call within TTL does **not** hit httpx.
  - Verifies cache expiry: second call after TTL DOES hit httpx.
  - Verifies non-JSON / WAF-challenge response surfaces as `WordPressError` (mirrors `fetch_post_by_url` behavior).
- `tests/unit/test_wp_client_publish.py` (extend the existing publish test):
  - Asserts `date_gmt` lands in the request body when `wp_publish_at` is set.
  - Asserts `date_gmt` is **absent** from the body when `wp_publish_at` is None.

### Manual UI verification

Run dev server, open the existing hitl2 page, confirm:

1. Author dropdown loads and filters.
2. Category dropdown loads, disambiguates "Bowtie Story" by slug.
3. Date picker accepts a date+time, displays HKT, submits UTC.
4. Approving and pushing produces a WP post with the chosen author/category/date.

## Out of scope / future work

- Multi-select categories with primary marker.
- Tag dropdown (same code path as category).
- Featured media picker (would need a separate Media library browser).
- Cache invalidation hook from WP (e.g. cache-bust webhook).
- Pre-flight validation of `wp_publish_at` vs `wp_publish_status`.

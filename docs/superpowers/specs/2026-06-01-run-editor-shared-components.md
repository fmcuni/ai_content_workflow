# Spec — Shared run-editor components for /hitl2, /edit, /regenerate

**Date:** 2026-06-01
**Status:** Draft → implementing
**Scope:** `web/` frontend only. No backend, API, or behavior changes.

## Problem

The three run-editor pages duplicate large amounts of layout and logic:

- `web/app/runs/[runId]/hitl2/page.tsx` (815 lines) — the HITL_2 review gate.
- `web/app/runs/[runId]/edit/page.tsx` (525 lines) — filed-run edit + re-push.
- `web/app/runs/[runId]/regenerate/page.tsx` (150 lines) — minimal AI regenerate.

`/hitl2` and `/edit` are near-identical in chrome (back link, `SectionHead`,
`RunTaskDetails`, `1fr_360px` grid, sticky action bar), in the WP-metadata ↔
Comments right rail, in the "Notes to AI" block, in the Raw HTML / WP payload
tabs, and in the snapshot/dry-publish/article DTO shaping. `/regenerate` is a
deliberately stripped-down variant.

## Decisions (locked)

1. **/regenerate = share shell only.** It adopts the shared page shell and the
   "Notes to AI" block, but keeps its reduced feature set: comments-only aside,
   no WP-metadata tab, no Raw/Payload tabs, no version history, no apply-edits.
   **No behavior change** to /regenerate.
2. **Tests = Vitest + React Testing Library**, added to `web/`. TDD the extracted
   pure logic and presentational components in isolation. No backend needed.

## Goals

- Extract shared, unit-tested pure logic into `web/lib/run-editor/`.
- Extract shared presentational components into `web/components/run-editor/`.
- Rewire all three pages onto the shared modules with **zero behavior change**.
- The complex, page-specific behavior stays in each page: HITL_2 autosave +
  hydration + decision gate; /edit manual-save + outline + re-push; /regenerate
  regenerate mutation.

## Non-goals

- No change to backend routes, the Workers TS port, or any DTO wire shape.
- No new features on /regenerate (per decision 1).
- No change to `useArticleComments` / `useApplyEdits` (already shared, fine).

---

## Module contracts

### A. `web/lib/run-editor/form.ts` — pure logic (Vitest)

Canonical home for the form-shaping helpers currently inlined/duplicated. All
pure, immutable (return new objects, never mutate args). Import DTO types from
`@/lib/types`.

```ts
// The editor's working form is the existing Hitl2Request shape (already used by
// both hitl2 and edit pages as their `form` state). No new type introduced.
import type {
  ArticleEditRequest, DryPublishRequest, Hitl2Request,
  Hitl2Snapshot, Hitl2SnapshotIn, Hitl2SnapshotTrigger,
} from "@/lib/types";

export type WpPublishStatus = "draft" | "future" | "publish";

/** Narrow an arbitrary stored status string to the form union; else undefined. */
export function asPublishStatus(value: string | null | undefined): WpPublishStatus | undefined;

/** True when the HTML body carries no real content (TipTap teardown emits ""/"<p></p>"). */
export function isBlankBody(html: string | null | undefined): boolean;

/** Build a snapshot DTO from the live editor state. */
export function buildSnapshotIn(
  html: string, form: Hitl2Request, comments: Hitl2Comment[], trigger: Hitl2SnapshotTrigger,
): Hitl2SnapshotIn;

/** Build the dry-publish request DTO from the live editor state. */
export function buildDryRequest(html: string, form: Hitl2Request): DryPublishRequest;

/** Build the article-save DTO (seo_title/meta_description default to ""). */
export function buildArticlePayload(html: string, form: Hitl2Request): ArticleEditRequest;

/** Stable comparison key for dirty-tracking; ignores the (non-content) trigger. */
export function snapshotKey(s: Hitl2SnapshotIn): string;

/** Shape a saved snapshot into the same form `buildSnapshotIn` produces, so a
 *  freshly-restored page reads as clean (key matches the live one). */
export function snapshotInFromSaved(s: Hitl2Snapshot): Hitl2SnapshotIn;

/** Immutable mapper: overlay a restored snapshot onto an existing form. */
export function applySnapshotToForm(form: Hitl2Request, s: Hitl2Snapshot): Hitl2Request;
```

**Behavior to preserve exactly** (these are characterization invariants — see the
current implementations in `hitl2/page.tsx` lines 47-98, 280-298 and
`edit/page.tsx` lines 53-58, 161-210, 267-289):

- `snapshotKey` serializes the SAME field order as hitl2's current `snapshotKey`
  (html_body, seo_title, meta_description, notes, comments, wp_publish_status,
  wp_author_id, wp_category_ids, wp_tag_ids, wp_featured_media_id, wp_slug,
  wp_excerpt, wp_publish_at), each `?? null` (comments `?? []`).
- `isBlankBody`: strip tags `/<[^>]*>/g`, strip `&nbsp;`, trim → length 0.
- `buildSnapshotIn` maps `form.edited_seo_title → seo_title`,
  `form.edited_meta_description → meta_description`, passes `comments` through,
  `wp_publish_status` from form, and `?? null` for all wp_* / notes.
- `snapshotInFromSaved` forces `trigger: "manual"`, `wp_publish_status ?? "draft"`.
- `buildArticlePayload`: `seo_title`/`meta_description` fall back to `""`.
- `asPublishStatus`: only "draft"|"future"|"publish" pass; else `undefined`.

### B. `web/lib/run-editor/useWpPayloadPreview.ts` — shared hook

```ts
/** The lazy WP-payload dry-publish preview shared by hitl2 + edit.
 *  `buildReq` is called fresh on each build so it reads current edits. */
export function useWpPayloadPreview(runId: string, buildReq: () => DryPublishRequest): {
  payload: DryPublishResponse | null;
  isPending: boolean;
  isError: boolean;
  error: Error | null;
  build: () => void;            // trigger a build (Refresh button)
  onTabOpen: (canBuild: boolean) => void; // lazy build first time the tab opens
};
```

Wraps the existing `useMutation(() => api.dryPublish(runId, buildReq()))` +
`dryPayload` state pattern. `onTabOpen` builds only if `canBuild && !isPending`.

### C. `web/components/run-editor/RunEditorShell.tsx` — page chrome (RTL)

```ts
interface RunEditorShellProps {
  runId: string;
  run: RunSummary | undefined;
  kicker: ReactNode;
  hed: ReactNode;
  dek: ReactNode;
  headerActions?: ReactNode;  // right side of the back-link row (hitl2 save controls)
  children: ReactNode;        // the two columns (main <section> + rail <aside>)
  actionBar: ReactNode;       // contents of the sticky bottom bar
}
```

Renders exactly the current shared chrome:
- `<div className="mx-auto max-w-[1180px] px-5 md:px-10 py-10 pb-32">`
- back-link row: `← Run · {runId.slice(0,8)}`; when `headerActions` present the row
  is `flex items-center justify-between gap-3` with actions on the right (hitl2
  layout); otherwise just the link (edit/regenerate layout).
- `<SectionHead kicker hed dek />`
- `{run && <RunTaskDetails run={run} />}`
- `<div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-8">{children}</div>`
- sticky bar: `<div className="fixed bottom-0 inset-x-0 bg-paper/95 backdrop-blur border-t border-ink z-40"><div className="mx-auto max-w-[1180px] px-5 md:px-10 py-3 flex items-center justify-end gap-3">{actionBar}</div></div>`

### D. `web/components/run-editor/EditorRail.tsx` — WP ↔ Comments rail (RTL)

Used by hitl2 + edit (NOT regenerate). Wraps the `<aside>` + Tabs(wp/comments) +
`Card>WordPressMetaForm` + `CommentsSidebar`. Props:

```ts
interface EditorRailProps {
  tab: "wp" | "comments";
  onTabChange: (t: "wp" | "comments") => void;
  form: Hitl2Request;
  onFormChange: Dispatch<SetStateAction<Hitl2Request>>;
  existingAuthorName: string | null;
  existingCategoryName: string | null;
  comments: Hitl2Comment[];
  focusedCommentId: string | null;
  onCommentChange: (id: string, body: string) => void;
  onCommentDelete: (id: string) => void;
  onCommentFocus: (id: string) => void;
  onCommentApply: (id: string) => void;
  applyingCommentId: string | null;
}
```

Renders the existing `<aside className="lg:sticky lg:top-[6.25rem] ...">` exactly.
The Comments tab trigger shows the `({count})` badge.

### E. `web/components/run-editor/NotesToAi.tsx` — notes block (RTL)

Used by all three. The "Apply to article" button is omitted when `onApply` is
undefined (regenerate case).

```ts
interface NotesToAiProps {
  value: string;
  onChange: (value: string) => void;
  onApply?: () => void;      // undefined → no Apply button (regenerate)
  applying?: boolean;        // shows "Applying…" + disables
}
```

Renders the existing `kicker "Notes to AI"` + optional Apply button + `<textarea>`
markup verbatim.

---

## Test plan (TDD — RED first)

### Vitest harness (`web/`)

- Dev deps: `vitest`, `@testing-library/react`, `@testing-library/jest-dom`,
  `@testing-library/user-event`, `jsdom`, `@vitejs/plugin-react`.
- `web/vitest.config.ts`: `plugins: [react()]`, `test.environment: "jsdom"`,
  `test.globals: true`, `test.setupFiles: ["./vitest.setup.ts"]`, and resolve
  alias `@` → project root (mirror tsconfig `paths`). `test.include` limited to
  `lib/**/*.test.ts` + `components/**/*.test.tsx` so it never picks up the
  Playwright `tests/e2e/**` specs.
- `web/vitest.setup.ts`: `import "@testing-library/jest-dom/vitest"`.
- `package.json` scripts: `"test": "vitest run"`, `"test:watch": "vitest"`.
- Keep Playwright separate — its specs live under `tests/e2e/` and run via
  `npx playwright test` (unchanged).

### Unit tests — `web/lib/run-editor/form.test.ts`

- `asPublishStatus`: "draft"/"future"/"publish" pass; "", null, "garbage" → undefined.
- `isBlankBody`: "", "<p></p>", "<p>&nbsp;</p>", "   " → true; "<p>Hi</p>" → false.
- `buildSnapshotIn`: maps edited_seo_title→seo_title etc.; comments passed through;
  nulls for absent wp_* fields; trigger echoed.
- `buildDryRequest` / `buildArticlePayload`: correct field mapping; article
  seo/meta fall back to "".
- `snapshotKey`: stable & order-independent of object key insertion; differs when
  any content field changes; identical for two equal snapshots.
- `snapshotInFromSaved`: trigger forced "manual"; wp_publish_status default "draft";
  round-trips so `snapshotKey(snapshotInFromSaved(s))` equals the key of an
  equivalent live snapshot.
- `applySnapshotToForm`: returns a NEW object (immutability); overlays all fields;
  unknown wp_publish_status falls back to prior form value.

### Component tests

- `RunEditorShell.test.tsx`: renders hed/dek/kicker; back link href; RunTaskDetails
  shown only when `run` provided; `headerActions` / `actionBar` slots rendered.
- `EditorRail.test.tsx`: tab switch calls `onTabChange`; comment count badge;
  apply button wires `onCommentApply` with the right id.
- `NotesToAi.test.tsx`: typing calls `onChange`; Apply button absent when no
  `onApply`; present + "Applying…" + disabled when `applying`.

### Regression gates (VERIFY phase)

- `npx tsc --noEmit` (or `next build` typecheck) clean on touched files — no NEW
  pyright/tsc errors.
- `npm run lint` (eslint) clean.
- `npm test` (vitest) all green.
- Manual/Playwright smoke: each page still renders its shell + editor against the
  live :3000 server (data permitting).

## Done when

All three pages import the shared modules, duplicated blocks are deleted, Vitest
suite is green, tsc + eslint clean, and a visual pass on /hitl2, /edit,
/regenerate shows no UI regression.

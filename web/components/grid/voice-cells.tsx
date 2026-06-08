"use client";

import { useState } from "react";

import { CmsTaxonomyPicker } from "@/components/cms/CmsTaxonomyPicker";
import {
  type CmsPublishStatus,
  CmsPostDateField,
  CmsPublishStatusSelect,
  CmsSlugInput,
} from "@/components/cms/fields";
import type { RowView } from "@/components/grid/RunRow";
import { decodeSlug, isLivePublish, ledgerDate, publishLabel } from "@/lib/runs-grid/display";
import { authorDisplay, categoryDisplay, nameFromOptions } from "@/lib/runs-grid/wp-names";
import { useWpCategoriesForPersona, useWpUsersForPersona } from "@/lib/use-wp-options";
import type { RunSummary } from "@/lib/types";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Per-voice board cells. Each WordPress-metadata cell on the /runs board reads
// the option list + display names for *its run's voice* (persona) so a non-Bowtie
// run shows that instance's authors/categories — not the global Bowtie snapshot.
// The voice-scoped hooks dedupe by slug, so N rows of one voice share a single
// option fetch. Edit widgets reuse the shared CMS field components (the same
// inputs the HITL_2 form renders); commits flow up through the optimistic PATCH.
// ---------------------------------------------------------------------------

const EMPTY = "—";

interface BoardCellProps {
  run: RunSummary;
  view: RowView;
}

/** Wrapper that dims the cell while its run's PATCH is in flight. */
function PendingWrap({
  pending,
  className,
  children,
}: {
  pending: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div aria-busy={pending} className={cn(className, pending && "opacity-60")}>
      {children}
    </div>
  );
}

/** Author cell — searchable per-voice combobox (editor) or resolved name (viewer). */
export function BoardAuthorCell({ run, view }: BoardCellProps) {
  const users = useWpUsersForPersona(run.persona || undefined);
  const id = run.wp_author_id ?? null;

  if (!view.canEdit) {
    return <>{authorDisplay(users.data, id)}</>;
  }
  return (
    <PendingWrap pending={view.pendingRunId === run.run_id} className="max-w-[200px]">
      <CmsTaxonomyPicker
        options={users.data ?? []}
        isPending={users.isPending}
        isError={users.isError}
        value={id}
        // PATCH can't clear to null (mirrors the prior board author cell); a
        // cleared combobox is a no-op, an explicit pick commits the new id.
        onChange={(v) => {
          if (v != null) view.onPatchRun(run.run_id, { wp_author_id: v });
        }}
        fallbackName={id != null ? nameFromOptions(users.data, id) : null}
        placeholder="Search author…"
        fallbackIdPlaceholder="User ID"
      />
    </PendingWrap>
  );
}

/**
 * Category cell — single-select per-voice combobox (editor) or resolved name
 * (viewer). The board stores `wp_category_ids` as an array; the editor commits a
 * one-element array (or `[]` when cleared). The viewer display marks `+N` when a
 * run carries extra categories so multi-category runs aren't shown as single.
 */
export function BoardCategoryCell({ run, view }: BoardCellProps) {
  const cats = useWpCategoriesForPersona(run.persona || undefined);
  const ids = run.wp_category_ids ?? [];
  const firstId = ids.length > 0 ? ids[0] : null;

  if (!view.canEdit) {
    return <>{categoryDisplay(cats.data, ids)}</>;
  }
  return (
    <PendingWrap pending={view.pendingRunId === run.run_id} className="max-w-[200px]">
      <CmsTaxonomyPicker
        options={cats.data ?? []}
        isPending={cats.isPending}
        isError={cats.isError}
        value={firstId}
        onChange={(v) =>
          view.onPatchRun(run.run_id, { wp_category_ids: v == null ? [] : [v] })
        }
        fallbackName={firstId != null ? nameFromOptions(cats.data, firstId) : null}
        placeholder="Search category…"
        fallbackIdPlaceholder="Cat ID"
      />
    </PendingWrap>
  );
}

/**
 * Slug cell. Shows the decoded slug; commits the raw draft on blur / Enter (the
 * server canonicalizes), reusing {@link CmsSlugInput}. Keyed by the stored slug
 * so an external update (optimistic / refetch) resets the draft.
 */
export function BoardSlugCell({ run, view }: BoardCellProps) {
  if (!view.canEdit) {
    return <>{decodeSlug(run.wp_slug) || EMPTY}</>;
  }
  return <SlugEditor key={run.wp_slug ?? ""} run={run} view={view} />;
}

function SlugEditor({ run, view }: BoardCellProps) {
  const committed = decodeSlug(run.wp_slug);
  const [draft, setDraft] = useState(committed);

  function commit() {
    if (draft !== committed) view.onPatchRun(run.run_id, { wp_slug: draft });
  }

  return (
    <PendingWrap
      pending={view.pendingRunId === run.run_id}
      className="max-w-[170px]"
    >
      <div
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter" && e.target instanceof HTMLInputElement) e.target.blur();
        }}
      >
        <CmsSlugInput value={draft} onChange={(v) => setDraft(v ?? "")} placeholder="—" />
      </div>
    </PendingWrap>
  );
}

/** Publish-status cell — shared select (editor) or live-aware label (viewer). */
export function BoardPublishCell({ run, view }: BoardCellProps) {
  if (!view.canEdit) {
    const live = isLivePublish(run.wp_publish_status);
    return (
      <span className={cn(live && "text-accent-deep font-medium")}>
        {publishLabel(run.wp_publish_status)}
      </span>
    );
  }
  return (
    <PendingWrap pending={view.pendingRunId === run.run_id} className="max-w-[150px]">
      <CmsPublishStatusSelect
        value={(run.wp_publish_status ?? "draft") as CmsPublishStatus}
        onChange={(v) => view.onPatchRun(run.run_id, { wp_publish_status: v })}
      />
    </PendingWrap>
  );
}

/** Post-date cell — shared HKT date/time field (editor) or ledger date (viewer). */
export function BoardPostDateCell({ run, view }: BoardCellProps) {
  if (!view.canEdit) {
    return <>{run.wp_publish_at ? ledgerDate(run.wp_publish_at) : EMPTY}</>;
  }
  return (
    <PendingWrap pending={view.pendingRunId === run.run_id} className="max-w-[260px]">
      <CmsPostDateField
        value={run.wp_publish_at ?? null}
        onChange={(iso) => view.onPatchRun(run.run_id, { wp_publish_at: iso })}
      />
    </PendingWrap>
  );
}

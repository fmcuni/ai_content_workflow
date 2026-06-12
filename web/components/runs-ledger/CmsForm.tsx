"use client";

import { cn } from "@/lib/utils";

import { CmsCombobox, type CmsOption } from "./CmsCombobox";
import type { CmsAutosave } from "./useCmsAutosave";

interface CmsFormProps {
  autosave: CmsAutosave;
  tag: string;
  users: CmsOption[];
  usersLoading: boolean;
  usersError: string | null;
  onRetryUsers: () => void;
  categories: CmsOption[];
  categoriesLoading: boolean;
  categoriesError: string | null;
  onRetryCategories: () => void;
  canEditMeta: boolean;
  canPatch: boolean;
}

const FIELD_LABEL = "text-[10.5px] font-semibold uppercase tracking-wide text-ink-faint";
const INPUT =
  "w-full rounded-md border border-rule bg-paper px-2 py-1.5 text-[12.5px] text-ink focus:border-accent focus:outline-2 focus:outline-accent/25 disabled:opacity-50";

/** Default-mode CMS-destination form (spec §4.5). Presentational; the parent
 * drawer owns the autosave state so the action buttons read the live values. */
export function CmsForm({
  autosave,
  tag,
  users,
  usersLoading,
  usersError,
  onRetryUsers,
  categories,
  categoriesLoading,
  categoriesError,
  onRetryCategories,
  canEditMeta,
  canPatch,
}: CmsFormProps) {
  const { values, dirty, setField } = autosave;
  const dirtyRing = (k: keyof typeof values) => (dirty.has(k) ? "border-warn bg-warn/[0.06]" : "");

  return (
    <div className="grid grid-cols-2 gap-x-3 gap-y-2.5">
      <div className="col-span-2 flex flex-col gap-1">
        <label htmlFor="f-seotitle" className={FIELD_LABEL}>SEO title</label>
        <input
          id="f-seotitle"
          type="text"
          value={values.seoTitle}
          disabled={!canEditMeta}
          onChange={(e) => setField("seoTitle", e.target.value)}
          placeholder="from latest draft"
          className={cn(INPUT, dirtyRing("seoTitle"))}
        />
      </div>

      <div className="col-span-2 flex flex-col gap-1">
        <label htmlFor="f-metadesc" className={FIELD_LABEL}>Meta description</label>
        <textarea
          id="f-metadesc"
          rows={2}
          value={values.metaDesc}
          disabled={!canEditMeta}
          onChange={(e) => setField("metaDesc", e.target.value)}
          placeholder="from latest draft"
          className={cn(INPUT, "resize-y", dirtyRing("metaDesc"))}
        />
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="f-author" className={FIELD_LABEL}>Author</label>
        <CmsCombobox
          inputId="f-author"
          value={values.authorId}
          onChange={(v) => setField("authorId", v)}
          options={users}
          tag={tag}
          loading={usersLoading}
          error={usersError}
          onRetry={onRetryUsers}
          disabled={!canPatch}
          placeholder="Search author…"
          className={cn(dirty.has("authorId") && "rounded-md ring-1 ring-warn")}
        />
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="f-category" className={FIELD_LABEL}>Category</label>
        <CmsCombobox
          inputId="f-category"
          value={values.categoryId}
          onChange={(v) => setField("categoryId", v)}
          options={categories}
          tag={tag}
          loading={categoriesLoading}
          error={categoriesError}
          onRetry={onRetryCategories}
          disabled={!canPatch}
          placeholder="Search category…"
          className={cn(dirty.has("categoryId") && "rounded-md ring-1 ring-warn")}
        />
      </div>

      <div className="col-span-2 flex flex-col gap-1">
        <label htmlFor="f-slug" className={FIELD_LABEL}>Slug</label>
        <input
          id="f-slug"
          type="text"
          value={values.slug}
          disabled={!canPatch}
          onChange={(e) => setField("slug", e.target.value)}
          placeholder="auto from title"
          className={cn(INPUT, dirtyRing("slug"))}
        />
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="f-pubstatus" className={FIELD_LABEL}>Publish status</label>
        <select
          id="f-pubstatus"
          value={values.pubStatus}
          disabled={!canPatch}
          onChange={(e) => setField("pubStatus", e.target.value as typeof values.pubStatus)}
          className={cn(INPUT, dirtyRing("pubStatus"))}
        >
          <option value="">— unset (defaults to draft)</option>
          <option value="draft">draft</option>
          <option value="publish">publish</option>
          <option value="future">future (scheduled)</option>
        </select>
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="f-pubdate" className={FIELD_LABEL}>Publish date</label>
        <input
          id="f-pubdate"
          type="date"
          value={values.pubDate}
          disabled={!canPatch}
          onChange={(e) => setField("pubDate", e.target.value)}
          className={cn(INPUT, dirtyRing("pubDate"))}
        />
      </div>
    </div>
  );
}

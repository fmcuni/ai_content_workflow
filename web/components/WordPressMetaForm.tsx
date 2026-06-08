"use client";
import { useQuery } from "@tanstack/react-query";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { DateTimeField } from "@/components/DateTimeField";
import { SearchableSelect } from "@/components/SearchableSelect";
import { api } from "@/lib/api";

import type { Hitl2Request, WpCategoryOption, WpUserOption } from "@/lib/types";

const TEN_MIN = 10 * 60_000;
const THIRTY_MIN = 30 * 60_000;

/** Fallback for when the wp_users / wp_categories cache table is empty
 * (first run after migration, before scripts/sync_wp_taxonomy.py has been
 * invoked). Shows the prefilled name from the existing post and lets the
 * reviewer type an ID directly. */
function IdChip({
  name, id, onChange, placeholder,
}: {
  name: string | null | undefined;
  id: number | null | undefined;
  onChange: (v: number | null) => void;
  placeholder: string;
}) {
  const display = name && name.trim() ? name : (id != null ? `#${id}` : "—");
  return (
    <div className="flex items-center gap-2">
      <span className="inline-flex items-center px-2 py-1 rounded border border-rule bg-paper-soft text-[13px] font-mono tabular-nums">
        {display}
        {name && id != null && (
          <span className="ml-2 text-ink-faint">#{id}</span>
        )}
      </span>
      <Input
        type="number"
        inputMode="numeric"
        value={id ?? ""}
        onChange={(e) => {
          const v = e.target.value.trim();
          onChange(v === "" ? null : parseInt(v, 10));
        }}
        placeholder={placeholder}
        className="w-28"
      />
    </div>
  );
}

/** If the DB cache has options, render SearchableSelect (full list, with
 * client-side fuzzy filter by name *or* slug). If the cache is empty or
 * the request errored, fall back to IdChip so the reviewer can still
 * proceed using the prefilled value or a hand-typed ID. */
function WpPicker({
  options, isPending, isError,
  value, onChange,
  fallbackName, placeholder, fallbackIdPlaceholder,
}: {
  options: { id: number; name: string; slug: string }[];
  isPending: boolean;
  isError: boolean;
  value: number | null;
  onChange: (v: number | null) => void;
  fallbackName: string | null | undefined;
  placeholder: string;
  fallbackIdPlaceholder: string;
}) {
  // Empty-DB or upstream-error → fallback. Loading should still show a chip
  // so the reviewer sees the prefilled name immediately.
  if ((!isPending && options.length === 0) || isError) {
    return (
      <IdChip
        name={fallbackName}
        id={value}
        onChange={onChange}
        placeholder={fallbackIdPlaceholder}
      />
    );
  }
  return (
    <SearchableSelect
      value={value}
      onChange={onChange}
      options={options}
      loading={isPending}
      placeholder={placeholder}
    />
  );
}

export function WordPressMetaForm({
  form, onChange, existingAuthorName, existingCategoryName, runId,
}: {
  form: Hitl2Request;
  onChange: (f: Hitl2Request) => void;
  existingAuthorName?: string | null;
  existingCategoryName?: string | null;
  /** Scopes author/category options to this run's CMS target (per-voice). */
  runId?: string;
}) {
  // Keyed by runId so switching runs (which may target different CMS instances)
  // refetches the correct instance's author/category lists.
  const users = useQuery<WpUserOption[]>({
    queryKey: ["wp-users", runId ?? null],
    queryFn: () => api.listWpUsers(runId),
    staleTime: TEN_MIN,
    gcTime: THIRTY_MIN,
  });
  const categories = useQuery<WpCategoryOption[]>({
    queryKey: ["wp-categories", runId ?? null],
    queryFn: () => api.listWpCategories(runId),
    staleTime: TEN_MIN,
    gcTime: THIRTY_MIN,
  });

  return (
    <div className="space-y-3 text-sm">
      <div>
        <Label>SEO title</Label>
        <Input value={form.edited_seo_title ?? ""} onChange={(e) => onChange({ ...form, edited_seo_title: e.target.value })} />
      </div>
      <div>
        <Label>Meta description</Label>
        <Textarea value={form.edited_meta_description ?? ""} rows={2}
                  onChange={(e) => onChange({ ...form, edited_meta_description: e.target.value })} />
      </div>
      <div>
        <Label>Slug (leave blank to preserve)</Label>
        <Input value={form.wp_slug ?? ""} onChange={(e) => onChange({ ...form, wp_slug: e.target.value || null })} />
      </div>
      <div>
        <Label>Excerpt</Label>
        <Textarea value={form.wp_excerpt ?? ""} rows={2}
                  onChange={(e) => onChange({ ...form, wp_excerpt: e.target.value || null })} />
      </div>
      <div>
        <Label>Publish status</Label>
        <Select value={form.wp_publish_status} onValueChange={(v) => onChange({ ...form, wp_publish_status: v as Hitl2Request["wp_publish_status"] })}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="draft">Draft (recommended)</SelectItem>
            <SelectItem value="future">Schedule</SelectItem>
            <SelectItem value="publish">Publish now</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div>
        <Label>Author</Label>
        <WpPicker
          options={users.data ?? []}
          isPending={users.isPending}
          isError={users.isError}
          value={form.wp_author_id ?? null}
          onChange={(v) => onChange({ ...form, wp_author_id: v })}
          fallbackName={existingAuthorName}
          placeholder="Search author by name, slug, or ID…"
          fallbackIdPlaceholder="User ID"
        />
      </div>
      <div>
        <Label>Category</Label>
        <WpPicker
          options={categories.data ?? []}
          isPending={categories.isPending}
          isError={categories.isError}
          value={form.wp_category_ids?.[0] ?? null}
          onChange={(v) => onChange({ ...form, wp_category_ids: v == null ? null : [v] })}
          fallbackName={existingCategoryName}
          placeholder="Search category by name, slug, or ID…"
          fallbackIdPlaceholder="Cat ID"
        />
      </div>
      <div>
        <Label>Tag IDs (comma)</Label>
        <Input value={form.wp_tag_ids?.join(",") ?? ""}
               onChange={(e) => onChange({ ...form, wp_tag_ids: e.target.value ? e.target.value.split(",").map(s => parseInt(s.trim(), 10)) : null })} />
      </div>
      <div>
        <Label>Featured media id</Label>
        <Input type="number" value={form.wp_featured_media_id ?? ""}
               onChange={(e) => onChange({ ...form, wp_featured_media_id: e.target.value ? parseInt(e.target.value, 10) : null })} />
      </div>
      <div>
        <Label>Post date (optional)</Label>
        <DateTimeField
          value={form.wp_publish_at ?? null}
          onChange={(v) => onChange({ ...form, wp_publish_at: v })}
        />
      </div>
    </div>
  );
}

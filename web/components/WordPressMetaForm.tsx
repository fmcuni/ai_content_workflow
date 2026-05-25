"use client";
import { useQuery } from "@tanstack/react-query";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { DateTimeField } from "@/components/DateTimeField";
import { SearchableSelect } from "@/components/SearchableSelect";
import { api } from "@/lib/api";

import type { Hitl2Request } from "@/lib/types";

const TEN_MIN = 10 * 60_000;
const THIRTY_MIN = 30 * 60_000;

export function WordPressMetaForm({
  form, onChange,
}: { form: Hitl2Request; onChange: (f: Hitl2Request) => void }) {
  const users = useQuery({
    queryKey: ["wp-users"],
    queryFn: api.listWpUsers,
    staleTime: TEN_MIN,
    gcTime: THIRTY_MIN,
  });
  const categories = useQuery({
    queryKey: ["wp-categories"],
    queryFn: api.listWpCategories,
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
        <SearchableSelect
          value={form.wp_author_id ?? null}
          onChange={(v) => onChange({ ...form, wp_author_id: v })}
          options={users.data ?? []}
          loading={users.isPending}
          error={users.isError ? (users.error as Error).message : null}
          onRetry={() => { void users.refetch(); }}
          placeholder="Search author…"
        />
      </div>
      <div>
        <Label>Category</Label>
        <SearchableSelect
          value={form.wp_category_ids?.[0] ?? null}
          onChange={(v) => onChange({ ...form, wp_category_ids: v == null ? null : [v] })}
          options={categories.data ?? []}
          loading={categories.isPending}
          error={categories.isError ? (categories.error as Error).message : null}
          onRetry={() => { void categories.refetch(); }}
          placeholder="Search category…"
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

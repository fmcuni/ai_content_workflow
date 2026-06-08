"use client";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  CmsAuthorSelect,
  CmsCategorySelect,
  CmsPostDateField,
  CmsPublishStatusSelect,
  CmsSlugInput,
  type CmsPublishStatus,
} from "@/components/cms/fields";

import type { Hitl2Request } from "@/lib/types";

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
        <CmsSlugInput value={form.wp_slug ?? null} onChange={(v) => onChange({ ...form, wp_slug: v })} />
      </div>
      <div>
        <Label>Excerpt</Label>
        <Textarea value={form.wp_excerpt ?? ""} rows={2}
                  onChange={(e) => onChange({ ...form, wp_excerpt: e.target.value || null })} />
      </div>
      <div>
        <Label>Publish status</Label>
        <CmsPublishStatusSelect
          value={form.wp_publish_status as CmsPublishStatus}
          onChange={(v) => onChange({ ...form, wp_publish_status: v })}
        />
      </div>
      <div>
        <Label>Author</Label>
        <CmsAuthorSelect
          runId={runId}
          value={form.wp_author_id ?? null}
          onChange={(v) => onChange({ ...form, wp_author_id: v })}
          fallbackName={existingAuthorName}
        />
      </div>
      <div>
        <Label>Category</Label>
        <CmsCategorySelect
          runId={runId}
          value={form.wp_category_ids?.[0] ?? null}
          onChange={(v) => onChange({ ...form, wp_category_ids: v == null ? null : [v] })}
          fallbackName={existingCategoryName}
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
        <CmsPostDateField
          value={form.wp_publish_at ?? null}
          onChange={(v) => onChange({ ...form, wp_publish_at: v })}
        />
      </div>
    </div>
  );
}

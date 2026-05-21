"use client";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

import type { Hitl2Request } from "@/lib/types";

export function WordPressMetaForm({
  form, onChange,
}: { form: Hitl2Request; onChange: (f: Hitl2Request) => void }) {
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
        <Label>Author (WP user id)</Label>
        <Input type="number" value={form.wp_author_id ?? ""} onChange={(e) => onChange({ ...form, wp_author_id: e.target.value ? parseInt(e.target.value, 10) : null })} />
      </div>
      <div>
        <Label>Category IDs (comma)</Label>
        <Input value={form.wp_category_ids?.join(",") ?? ""}
               onChange={(e) => onChange({ ...form, wp_category_ids: e.target.value ? e.target.value.split(",").map(s => parseInt(s.trim(), 10)) : null })} />
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
    </div>
  );
}

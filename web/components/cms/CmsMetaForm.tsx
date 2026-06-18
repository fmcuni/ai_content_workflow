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
import {
  CmsFeatureImageField,
  CmsGhostAuthorSelect,
  CmsGhostTagPicker,
} from "@/components/cms/ghost-fields";
import type { Hitl2Request, PublishTargetKind } from "@/lib/types";

interface CmsMetaFormProps {
  form: Hitl2Request;
  onChange: (f: Hitl2Request) => void;
  /** Resolved CMS kind for the run; selects which fields render. */
  kind: PublishTargetKind;
  /** Scopes author/category/tag options to this run's CMS target (per-voice). */
  runId?: string;
  existingAuthorName?: string | null;
  existingCategoryName?: string | null;
}

/**
 * Shared, kind-aware CMS metadata form for HITL_2. WordPress and Ghost share
 * the SEO title / meta description / slug / excerpt / status / publish-date /
 * feature-image fields; the author, taxonomy, and status vocabulary adapt to
 * the run's CMS. Category is WordPress-only (Ghost has no categories).
 */
export function CmsMetaForm({
  form,
  onChange,
  kind,
  runId,
  existingAuthorName,
  existingCategoryName,
}: CmsMetaFormProps) {
  const isGhost = kind === "ghost";
  const patch = (p: Partial<Hitl2Request>) => onChange({ ...form, ...p });

  return (
    <div className="space-y-3 text-sm">
      <div>
        <Label>SEO title</Label>
        <Input
          value={form.edited_seo_title ?? ""}
          onChange={(e) => patch({ edited_seo_title: e.target.value })}
        />
      </div>
      <div>
        <Label>Meta description</Label>
        <Textarea
          value={form.edited_meta_description ?? ""}
          rows={2}
          onChange={(e) => patch({ edited_meta_description: e.target.value })}
        />
      </div>
      <div>
        <Label>Slug (leave blank to preserve)</Label>
        <CmsSlugInput value={form.wp_slug ?? null} onChange={(v) => patch({ wp_slug: v })} />
      </div>
      <div>
        <Label>Excerpt</Label>
        <Textarea
          value={form.wp_excerpt ?? ""}
          rows={2}
          onChange={(e) => patch({ wp_excerpt: e.target.value || null })}
        />
      </div>

      <div>
        <Label>Publish status</Label>
        <CmsPublishStatusSelect
          value={form.wp_publish_status as CmsPublishStatus}
          onChange={(v) => patch({ wp_publish_status: v })}
        />
      </div>

      <div>
        <Label>Author</Label>
        {isGhost ? (
          <CmsGhostAuthorSelect
            runId={runId}
            value={form.ghost_author_ids ?? null}
            onChange={(v) => patch({ ghost_author_ids: v })}
          />
        ) : (
          <CmsAuthorSelect
            runId={runId}
            value={form.wp_author_id ?? null}
            onChange={(v) => patch({ wp_author_id: v })}
            fallbackName={existingAuthorName}
          />
        )}
      </div>

      {/* Category is WordPress-only — Ghost has no category taxonomy. */}
      {!isGhost ? (
        <div>
          <Label>Category</Label>
          <CmsCategorySelect
            runId={runId}
            value={form.wp_category_ids?.[0] ?? null}
            onChange={(v) => patch({ wp_category_ids: v == null ? null : [v] })}
            fallbackName={existingCategoryName}
          />
        </div>
      ) : null}

      <div>
        <Label>Tags</Label>
        {isGhost ? (
          <CmsGhostTagPicker
            runId={runId}
            value={form.ghost_tags ?? null}
            onChange={(v) => patch({ ghost_tags: v })}
          />
        ) : (
          <Input
            value={form.wp_tag_ids?.join(",") ?? ""}
            placeholder="Tag IDs (comma)"
            onChange={(e) =>
              patch({
                wp_tag_ids: e.target.value
                  ? e.target.value.split(",").map((s) => parseInt(s.trim(), 10))
                  : null,
              })
            }
          />
        )}
      </div>

      <div>
        <Label>{isGhost ? "Feature image" : "Featured image"}</Label>
        <CmsFeatureImageField
          runId={runId}
          kind={kind}
          valueUrl={form.feature_image_url ?? null}
          valueMediaId={form.wp_featured_media_id ?? null}
          onChange={patch}
        />
      </div>

      <div>
        <Label>{isGhost ? "Publish date (when scheduled)" : "Post date (optional)"}</Label>
        <CmsPostDateField
          value={form.wp_publish_at ?? null}
          onChange={(v) => patch({ wp_publish_at: v })}
        />
      </div>
    </div>
  );
}

"use client";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { DateTimeField } from "@/components/DateTimeField";
import { CmsTaxonomyPicker } from "@/components/cms/CmsTaxonomyPicker";
import { useWpCategories, useWpUsers } from "@/lib/use-wp-options";

// ---------------------------------------------------------------------------
// Shared CMS field components. Anything that edits a WordPress-specific field
// lives here so the HITL_2 metadata form and the /runs board render identical
// inputs (and resolve the same per-voice option lists). Add a CMS field once,
// reuse everywhere.
// ---------------------------------------------------------------------------

export type CmsPublishStatus = "draft" | "future" | "publish";

const CMS_PUBLISH_STATUSES: ReadonlyArray<{ value: CmsPublishStatus; label: string }> = [
  { value: "draft", label: "Draft (recommended)" },
  { value: "future", label: "Schedule" },
  { value: "publish", label: "Publish now" },
];

/** Author picker — searchable combobox over the run's CMS-target authors. */
export function CmsAuthorSelect({
  runId, value, onChange, fallbackName,
}: {
  runId?: string;
  value: number | null;
  onChange: (v: number | null) => void;
  fallbackName?: string | null;
}) {
  const users = useWpUsers(runId);
  return (
    <CmsTaxonomyPicker
      options={users.data ?? []}
      isPending={users.isPending}
      isError={users.isError}
      value={value}
      onChange={onChange}
      fallbackName={fallbackName}
      placeholder="Search author by name, slug, or ID…"
      fallbackIdPlaceholder="User ID"
    />
  );
}

/** Single-category picker — searchable combobox over the run's CMS-target categories. */
export function CmsCategorySelect({
  runId, value, onChange, fallbackName,
}: {
  runId?: string;
  value: number | null;
  onChange: (v: number | null) => void;
  fallbackName?: string | null;
}) {
  const categories = useWpCategories(runId);
  return (
    <CmsTaxonomyPicker
      options={categories.data ?? []}
      isPending={categories.isPending}
      isError={categories.isError}
      value={value}
      onChange={onChange}
      fallbackName={fallbackName}
      placeholder="Search category by name, slug, or ID…"
      fallbackIdPlaceholder="Cat ID"
    />
  );
}

/** Slug input — null when blank (preserve the existing slug on publish). */
export function CmsSlugInput({
  value, onChange, placeholder,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
  placeholder?: string;
}) {
  return (
    <Input
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value || null)}
      placeholder={placeholder}
    />
  );
}

/** Publish-status select (draft / future / publish). */
export function CmsPublishStatusSelect({
  value, onChange,
}: {
  value: CmsPublishStatus;
  onChange: (v: CmsPublishStatus) => void;
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as CmsPublishStatus)}>
      <SelectTrigger><SelectValue /></SelectTrigger>
      <SelectContent>
        {CMS_PUBLISH_STATUSES.map((o) => (
          <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Post-date field (ISO string or null). */
export function CmsPostDateField({
  value, onChange,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  return <DateTimeField value={value} onChange={onChange} />;
}

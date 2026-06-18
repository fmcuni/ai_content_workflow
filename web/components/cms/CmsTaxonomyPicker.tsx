"use client";
import { Input } from "@/components/ui/input";
import { SearchableSelect } from "@/components/SearchableSelect";

export interface WpOption {
  id: number;
  name: string;
  slug: string;
}

/** Fallback for when the wp_users / wp_categories cache is empty for this target
 * (e.g. before scripts/sync_wp_taxonomy.py has run for it). Shows the prefilled
 * name and lets the reviewer type an id directly so they can still proceed. */
function IdChip({
  name, id, onChange, placeholder,
}: {
  name: string | null | undefined;
  id: number | null | undefined;
  onChange: (v: number | null) => void;
  placeholder: string;
}) {
  const display = name && name.trim() ? name : id != null ? `#${id}` : "—";
  return (
    <div className="flex items-center gap-2">
      <span className="inline-flex items-center px-2 py-1 rounded border border-rule bg-paper-soft text-[13px] font-mono tabular-nums">
        {display}
        {name && id != null && <span className="ml-2 text-ink-faint">#{id}</span>}
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

/**
 * Canonical WordPress taxonomy picker (author / category) shared by the HITL_2
 * metadata form and the /runs board. When the per-target cache has options it
 * renders a searchable combobox (client-side filter by name *or* slug); when the
 * cache is empty or the request errored it falls back to {@link IdChip} so a
 * reviewer can still proceed via the prefilled value or a hand-typed id.
 *
 * Data is passed in (the caller owns the per-voice query) so the same component
 * works whether options come from one form-level fetch or a board grouped by
 * target.
 */
export function CmsTaxonomyPicker({
  options, isPending, isError,
  value, onChange,
  fallbackName, placeholder, fallbackIdPlaceholder,
}: {
  options: WpOption[];
  isPending: boolean;
  isError: boolean;
  value: number | null;
  onChange: (v: number | null) => void;
  fallbackName?: string | null;
  placeholder: string;
  fallbackIdPlaceholder: string;
}) {
  if ((!isPending && options.length === 0) || isError) {
    return (
      <IdChip name={fallbackName} id={value} onChange={onChange} placeholder={fallbackIdPlaceholder} />
    );
  }
  return (
    <SearchableSelect
      value={value}
      // SearchableSelect is id-type-agnostic (string | number) so Ghost can reuse
      // it; WordPress ids are always numeric, so narrow back here.
      onChange={(v) => onChange(typeof v === "number" ? v : null)}
      options={options}
      loading={isPending}
      placeholder={placeholder}
    />
  );
}

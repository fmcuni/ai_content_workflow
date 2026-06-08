import type { WpOption } from "@/components/cms/CmsTaxonomyPicker";

// Per-voice WordPress id→name resolution for the /runs board. Options come from
// the voice-scoped wp-options lookups (useWp*ForPersona), so an id resolves
// against the run's own CMS instance — a VHIS101 author id reads the VHIS101
// snapshot, not Bowtie's. An id absent from the snapshot falls back to `#id`.

const EMPTY = "—";

/** Display name for a WP entity id within a voice's option list, or null. */
export function nameFromOptions(
  options: readonly WpOption[] | undefined,
  id: number,
): string | null {
  return options?.find((o) => o.id === id)?.name ?? null;
}

/** Author cell display: the resolved name, `#id` when off-snapshot, or "—". */
export function authorDisplay(
  options: readonly WpOption[] | undefined,
  id: number | null | undefined,
): string {
  if (id == null) return EMPTY;
  return nameFromOptions(options, id) ?? `#${id}`;
}

/**
 * Category cell display. The board stores `wp_category_ids` as an array; the
 * cell shows the first category's name (the editor is single-select) plus a
 * `+N` marker when a run carries extra categories, so a multi-category run is
 * never silently shown as single.
 */
export function categoryDisplay(
  options: readonly WpOption[] | undefined,
  ids: readonly number[] | null | undefined,
): string {
  if (!ids || ids.length === 0) return EMPTY;
  const first = nameFromOptions(options, ids[0]) ?? `#${ids[0]}`;
  return ids.length > 1 ? `${first} +${ids.length - 1}` : first;
}

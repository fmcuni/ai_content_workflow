import type { PublishTargetKind } from "@/lib/types";

/** Full product name for a CMS kind. */
export function cmsKindName(kind: PublishTargetKind): string {
  return kind === "ghost" ? "Ghost" : "WordPress";
}

/** Short abbreviation used in dense UI (tabs, compact buttons). */
export function cmsKindAbbrev(kind: PublishTargetKind): string {
  return kind === "ghost" ? "Ghost" : "WP";
}

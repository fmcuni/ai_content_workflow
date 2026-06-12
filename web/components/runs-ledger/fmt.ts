// ── Runs-ledger formatting + CMS-target resolution ──────────────────────────
// Pure helpers (no React) shared by the ledger table, drawer and bulk modal.
// Mirror the redesign demo's `fmtDate`/`fmtDateTime`/`decodeSlug`/`targetForRun`
// (design/runs-redesign/runs-redesign.html) so the production board reads the
// same. Kept side-effect-free + exported so they can be unit-tested directly.

import type { Persona, PublishTarget, RunSummary } from "@/lib/types";

/** `2026-06-12T09:30:00Z` → `2026-06-12` (date only). Empty/nullish → `—`. */
export function fmtDate(iso?: string | null): string {
  return iso ? iso.slice(0, 10) : "—";
}

/** `2026-06-12T09:30:00Z` → `2026-06-12 09:30` (minute precision). Nullish → `—`. */
export function fmtDateTime(iso?: string | null): string {
  return iso ? iso.slice(0, 16).replace("T", " ") : "—";
}

/**
 * Human-readable slug for the mono id line + SERP preview. Prefers an explicit
 * `wp_slug`; otherwise the last path segment of the source `article_url`.
 * Percent-decodes (CJK slugs arrive URL-encoded) and always leads with `/`.
 * Returns `null` when nothing usable is present.
 */
export function decodeSlug(run: Pick<RunSummary, "wp_slug" | "article_url">): string | null {
  let raw = run.wp_slug?.trim() ?? "";
  if (!raw && run.article_url) {
    try {
      const path = new URL(run.article_url).pathname;
      raw = path.split("/").filter(Boolean).pop() ?? "";
    } catch {
      raw = "";
    }
  }
  if (!raw) return null;
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // Malformed %-escape — fall back to the raw slug rather than throwing.
  }
  return "/" + decoded.replace(/^\/+/, "");
}

/** CMS short tag for a publish target's `kind`: WordPress → `WP`, Ghost → `GT`. */
export function cmsTag(kind?: string | null): string {
  switch ((kind ?? "wordpress").toLowerCase()) {
    case "ghost":
      return "GT";
    case "wordpress":
    default:
      return "WP";
  }
}

export interface ResolvedTarget {
  name: string;
  /** CMS short tag (`WP` / `GT`) used in `name · TAG#id` + the `WP#post` ref. */
  tag: string;
}

const DEFAULT_TARGET: ResolvedTarget = { name: "Bowtie (default)", tag: "WP" };

/**
 * Resolve a run's CMS destination from its persona's `publish_target_id`
 * (spec §6 — null persona/target ⇒ the default Bowtie WordPress). Built from the
 * `GET /personas` + `GET /publish-targets` lists so every row/cell resolves
 * client-side without an extra per-run fetch.
 */
export function resolveTarget(
  run: Pick<RunSummary, "persona">,
  personaBySlug: Map<string, Persona>,
  targetById: Map<string, PublishTarget>,
): ResolvedTarget {
  const persona = run.persona ? personaBySlug.get(run.persona) : undefined;
  const targetId = persona?.publish_target_id ?? null;
  const target = targetId ? targetById.get(targetId) : undefined;
  if (!target) return DEFAULT_TARGET;
  return { name: target.name, tag: cmsTag(target.kind) };
}

/** Voice display name for a run's persona slug; falls back to the raw slug. */
export function voiceName(
  run: Pick<RunSummary, "persona">,
  personaBySlug: Map<string, Persona>,
): string | null {
  if (!run.persona) return null;
  return personaBySlug.get(run.persona)?.name ?? run.persona;
}

/** `name · TAG#id` label for a CMS author/category option (spec §2.1). */
export function cmsOptionLabel(name: string, tag: string, id: number): string {
  return `${name} · ${tag}#${id}`;
}

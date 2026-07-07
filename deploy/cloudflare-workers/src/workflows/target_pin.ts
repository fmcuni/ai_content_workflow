/**
 * Publish-target pin comparison (bowtie-ins issue #15).
 *
 * Pure decision logic for the publish-step assertion, extracted so the exact
 * pin semantics are unit-testable in the node pool (production.ts itself only
 * loads under workerd). The pin is the CMS target the reviewer confirmed at
 * HITL_2 approve; `actual` is what the publish step resolved just before
 * writing. A missing pin (kind NULL — e.g. an approval that predates the pin
 * columns) never matches: fail closed.
 */

/** The pin columns persisted on the run row at HITL_2 approve. */
export interface PersistedTargetPin {
  approved_target_kind: string | null;
  approved_post_id: string | null;
  approved_target_label: string | null;
}

/** The target a publish step resolved. postId null = "creates a new post". */
export interface ResolvedPublishTarget {
  kind: string;
  postId: string | null;
  label: string;
}

export function pinnedTargetMatches(
  pin: PersistedTargetPin,
  actual: ResolvedPublishTarget,
): boolean {
  return (
    pin.approved_target_kind === actual.kind &&
    pin.approved_post_id === actual.postId &&
    pin.approved_target_label === actual.label
  );
}

/**
 * Human-readable mismatch description for the publish-failure error. The
 * "publish target mismatch" prefix is load-bearing: POST /runs/:id/restart
 * matches on it to restart from the HITL_2 gate instead of replaying the
 * cached approve event into the same failure.
 */
export function pinMismatchMessage(
  pin: PersistedTargetPin,
  actual: ResolvedPublishTarget,
): string {
  const pinDesc =
    pin.approved_target_kind === null
      ? "no pinned target on this approval"
      : `approved ${pin.approved_target_kind} post ${pin.approved_post_id ?? "<new>"} on ${pin.approved_target_label ?? ""}`;
  return (
    `publish target mismatch: ${pinDesc}, but this publish resolved ${actual.kind} post ` +
    `${actual.postId ?? "<new>"} on ${actual.label} — approval voided; re-run the publish ` +
    `preview and approve again`
  );
}

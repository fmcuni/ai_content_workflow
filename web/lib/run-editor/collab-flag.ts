/** Realtime-collab feature flag. Default OFF; only "true" enables it. */
export function isCollabEnabled(): boolean {
  return process.env.NEXT_PUBLIC_COLLAB_ENABLED === "true";
}

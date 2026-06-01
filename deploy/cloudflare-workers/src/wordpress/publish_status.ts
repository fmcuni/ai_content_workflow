/**
 * Resolve the WordPress post `status` to send on a publish / re-push.
 *
 * The operator chooses the status in HITL_2 (and on the edit form); we honor
 * that choice for BOTH create and refresh runs, defaulting to "draft" only when
 * nothing was selected.
 *
 * History: create-mode runs used to be force-drafted (`isRefresh ? … : "draft"`),
 * which silently demoted a "publish" selection to a draft — the dry-publish
 * preview showed "publish" while the real push wrote "draft". Honoring the
 * selection here keeps the preview and the actual push in agreement.
 */
export function resolvePublishStatus(
  wpPublishStatus: string | null | undefined,
): string {
  return wpPublishStatus ?? "draft";
}

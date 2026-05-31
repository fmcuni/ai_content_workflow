/**
 * Article-table schedule-advancement math — Workers-native port of the schedule
 * helpers in `content_tool/refresh/inventory.py`.
 *
 * The caller (scanner) issues the `UPDATE content_tool.articles` itself; these
 * functions only compute the next `next_scan_due_at` timestamp.
 */

import { getRefreshConfig } from "../config/refresh";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function addDays(now: Date, days: number): Date {
  return new Date(now.getTime() + days * MS_PER_DAY);
}

/**
 * Return the new `next_scan_due_at`. `null` means "leave it untouched" — the
 * caller must NOT update the column. Mirrors Python `advance_schedule`:
 *   refresh → null (stays overdue, shows in queue)
 *   monitor → now + monitor_interval_days (default 14)
 *   ok      → now + ok_interval_days (default 30)
 * Any other action throws (matches the Python `ValueError`).
 */
export function advanceSchedule(action: string, now: Date = new Date()): Date | null {
  const cfg = getRefreshConfig().scheduling;
  if (action === "refresh") {
    return null;
  }
  if (action === "monitor") {
    return addDays(now, cfg.monitor_interval_days);
  }
  if (action === "ok") {
    return addDays(now, cfg.ok_interval_days);
  }
  throw new Error(`unknown action: ${action}`);
}

/** now + retry_interval_days (default 1) — used after a transient scan failure. */
export function scheduleAfterRetry(now: Date = new Date()): Date {
  const cfg = getRefreshConfig().scheduling;
  return addDays(now, cfg.retry_interval_days);
}

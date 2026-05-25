"use client"

import * as React from "react"
import { Popover } from "@base-ui/react/popover"

import { Calendar } from "@/components/ui/calendar"
import { cn } from "@/lib/utils"

interface Props {
  value: string | null
  onChange: (v: string | null) => void
  label?: string
}

const HK_OFFSET_MINUTES = 8 * 60

/**
 * Convert a UTC ISO string to the HKT wall-clock `{ date, time }` parts.
 *
 * We add 8 hours to the underlying timestamp and then read the *UTC* fields of
 * the shifted Date. That gives us the HKT calendar fields no matter what the
 * browser's local timezone happens to be — a traveling editor in PST won't see
 * a different date than one in HKT.
 */
function utcIsoToHkParts(iso: string | null): { date: string; time: string } {
  if (!iso) return { date: "", time: "" }
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return { date: "", time: "" }
  const shifted = new Date(d.getTime() + HK_OFFSET_MINUTES * 60_000)
  const y = shifted.getUTCFullYear()
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0")
  const day = String(shifted.getUTCDate()).padStart(2, "0")
  const hh = String(shifted.getUTCHours()).padStart(2, "0")
  const mm = String(shifted.getUTCMinutes()).padStart(2, "0")
  return { date: `${y}-${m}-${day}`, time: `${hh}:${mm}` }
}

/**
 * Convert HKT wall-clock `{ date, time }` parts to a UTC ISO string with no
 * milliseconds, e.g. `2026-06-01T03:00:00Z`. Returns `null` if either part is
 * empty or the input does not parse.
 */
function hkPartsToUtcIso(date: string, time: string): string | null {
  if (!date || !time) return null
  const d = new Date(`${date}T${time}:00+08:00`)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString().replace(/\.\d{3}Z$/, "Z")
}

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
]

/** Format an HKT `YYYY-MM-DD` as `25 May 2026` for the trigger button label. */
function formatHkDate(hkDate: string): string {
  const [y, m, d] = hkDate.split("-")
  if (!y || !m || !d) return hkDate
  const monthIdx = parseInt(m, 10) - 1
  const month = MONTH_NAMES[monthIdx] ?? m
  // Strip any leading zero from the day for nicer display.
  const dayNum = parseInt(d, 10)
  return `${dayNum} ${month} ${y}`
}

/**
 * Build a Date object representing the HKT date at midnight *local* time, so
 * react-day-picker highlights the right cell regardless of the browser's
 * timezone. We only use this for the calendar's `selected` prop — never for
 * timezone math.
 */
function hkDateToLocalMidnight(hkDate: string): Date | undefined {
  if (!hkDate) return undefined
  const [y, m, d] = hkDate.split("-").map((s) => parseInt(s, 10))
  if (!y || !m || !d) return undefined
  return new Date(y, m - 1, d, 0, 0, 0, 0)
}

/** Read the HKT `YYYY-MM-DD` of "now" so we can default when time is set first. */
function todayHkDate(): string {
  const now = new Date()
  const shifted = new Date(now.getTime() + HK_OFFSET_MINUTES * 60_000)
  const y = shifted.getUTCFullYear()
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0")
  const day = String(shifted.getUTCDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

const TRIGGER_CLASSES =
  "flex h-9 flex-1 items-center border-b border-rule bg-transparent px-0 py-1.5 text-left text-[13px] text-ink"

const TIME_INPUT_CLASSES =
  "h-9 w-[110px] border-b border-rule bg-transparent px-0 py-1.5 text-[13px] text-ink"

export function DateTimeField({ value, onChange, label }: Props) {
  const parts = React.useMemo(() => utcIsoToHkParts(value), [value])

  const handleDateSelect = (next: Date | undefined) => {
    if (!next) {
      // Calendar deselected -> clear the field entirely.
      onChange(null)
      return
    }
    const y = next.getFullYear()
    const m = String(next.getMonth() + 1).padStart(2, "0")
    const d = String(next.getDate()).padStart(2, "0")
    const hkDate = `${y}-${m}-${d}`
    // If no time has been set yet, default to 09:00 HKT so the wire string is valid.
    const hkTime = parts.time || "09:00"
    onChange(hkPartsToUtcIso(hkDate, hkTime))
  }

  const handleTimeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const next = e.target.value // "HH:mm" or ""
    if (!next) {
      // Time cleared. Drop the whole value — date-only isn't a meaningful
      // publish moment in HKT for our wire format.
      onChange(null)
      return
    }
    const hkDate = parts.date || todayHkDate()
    onChange(hkPartsToUtcIso(hkDate, next))
  }

  const handleClear = () => onChange(null)

  const calendarSelected = parts.date ? hkDateToLocalMidnight(parts.date) : undefined

  return (
    <div className="space-y-1">
      {label ? (
        <div className="text-[11px] uppercase tracking-[0.1em] text-ink-faint">
          {label}
        </div>
      ) : null}
      <div className="flex items-center gap-2">
        <Popover.Root>
          <Popover.Trigger
            className={cn(
              TRIGGER_CLASSES,
              parts.date ? "" : "text-ink-faint",
            )}
          >
            {parts.date ? formatHkDate(parts.date) : "Pick a date"}
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Positioner sideOffset={4} className="z-50">
              <Popover.Popup
                className={cn(
                  "z-50 border border-rule bg-paper p-2 shadow-md",
                )}
              >
                <Calendar
                  mode="single"
                  selected={calendarSelected}
                  onSelect={handleDateSelect}
                />
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </Popover.Root>

        <input
          type="time"
          value={parts.time}
          onChange={handleTimeChange}
          className={TIME_INPUT_CLASSES}
          aria-label="Time (HKT)"
        />

        {value !== null && (
          <button
            type="button"
            onClick={handleClear}
            aria-label="Clear date and time"
            className="px-1 text-[13px] text-ink-faint hover:text-ink"
          >
            {"✕"}
          </button>
        )}
      </div>
      <div className="text-[11px] text-ink-faint">
        Hong Kong time. Leave blank to use WP default.
      </div>
    </div>
  )
}

export default DateTimeField

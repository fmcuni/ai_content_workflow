"use client"

import * as React from "react"
import { Combobox } from "@base-ui/react/combobox"

import { cn } from "@/lib/utils"

export interface SearchableSelectOption {
  id: number
  name: string
  slug: string
}

interface Props {
  value: number | null
  onChange: (v: number | null) => void
  options: SearchableSelectOption[]
  placeholder?: string
  loading?: boolean
  error?: string | null
  onRetry?: () => void
  disabled?: boolean
  className?: string
}

const TRIGGER_CLASSES =
  "flex h-9 w-full items-center justify-between gap-2 border-0 border-b border-rule rounded-none bg-transparent px-0 py-1.5 text-[13px] text-ink outline-none transition-colors focus-visible:border-b-2 focus-visible:border-accent disabled:opacity-50"

export function SearchableSelect({
  value,
  onChange,
  options,
  placeholder = "Select…",
  loading = false,
  error = null,
  onRetry,
  disabled = false,
  className,
}: Props) {
  // Pre-compute disambiguated labels: when two visible options share the same
  // `name`, show "name · slug" to help editors pick the right one.
  const labelById = React.useMemo(() => {
    const nameCounts = new Map<string, number>()
    for (const opt of options) {
      nameCounts.set(opt.name, (nameCounts.get(opt.name) ?? 0) + 1)
    }
    const map = new Map<number, string>()
    for (const opt of options) {
      const needsDisambiguation = (nameCounts.get(opt.name) ?? 0) > 1
      map.set(opt.id, needsDisambiguation ? `${opt.name} · ${opt.slug}` : opt.name)
    }
    return map
  }, [options])

  const selectedOption = React.useMemo(
    () => options.find((o) => o.id === value) ?? null,
    [options, value],
  )

  // ---- Loading state ----------------------------------------------------
  if (loading) {
    return (
      <button
        type="button"
        disabled
        aria-busy="true"
        className={cn(TRIGGER_CLASSES, "text-left text-ink-faint", className)}
      >
        <span className="flex-1 truncate">Loading…</span>
      </button>
    )
  }

  // ---- Error state ------------------------------------------------------
  if (error) {
    return (
      <button
        type="button"
        onClick={onRetry}
        className={cn(
          TRIGGER_CLASSES,
          "text-left text-accent-deep hover:text-accent-deep/80",
          className,
        )}
      >
        <span className="flex-1 truncate">Failed — retry</span>
      </button>
    )
  }

  // ---- Active combobox --------------------------------------------------
  return (
    <Combobox.Root<SearchableSelectOption, false>
      items={options}
      value={selectedOption}
      onValueChange={(next) => onChange(next?.id ?? null)}
      itemToStringLabel={(item) => labelById.get(item.id) ?? item.name}
      itemToStringValue={(item) => String(item.id)}
      isItemEqualToValue={(a, b) => a.id === b.id}
      filter={(item, query) => {
        if (!query) return true
        const q = query.toLowerCase()
        return (
          item.name.toLowerCase().includes(q) ||
          item.slug.toLowerCase().includes(q)
        )
      }}
      disabled={disabled}
    >
      <Combobox.InputGroup className={cn("relative w-full", className)}>
        <Combobox.Input
          placeholder={placeholder}
          disabled={disabled}
          className={cn(
            TRIGGER_CLASSES,
            "w-full pr-12 placeholder:text-ink-faint",
          )}
        />
        {value !== null && (
          <Combobox.Clear
            onClick={() => onChange(null)}
            className="absolute right-0 top-1/2 -translate-y-1/2 px-2 py-1 text-[11px] uppercase tracking-[0.1em] text-ink-faint hover:text-ink"
            aria-label="Clear selection"
          >
            Clear
          </Combobox.Clear>
        )}
      </Combobox.InputGroup>

      <Combobox.Portal>
        <Combobox.Positioner sideOffset={4} className="isolate z-50">
          <Combobox.Popup
            className={cn(
              "z-50 max-h-[280px] min-w-[var(--anchor-width)] overflow-auto border border-rule bg-paper p-1 text-[13px] text-ink shadow-md",
            )}
          >
            <Combobox.Empty className="px-3 py-1.5 text-ink-faint">
              No match
            </Combobox.Empty>
            <Combobox.List>
              {(item: SearchableSelectOption) => (
                <Combobox.Item
                  key={item.id}
                  value={item}
                  className={cn(
                    "relative flex w-full cursor-default select-none items-center gap-2 px-3 py-1.5 text-[13px] outline-none",
                    "data-[highlighted]:bg-rule/40",
                    "data-[disabled]:opacity-50",
                  )}
                >
                  <span className="flex-1 truncate">
                    {labelById.get(item.id) ?? item.name}
                  </span>
                  <span className="font-mono tabular-nums text-[11px] text-ink-faint">
                    #{item.id}
                  </span>
                </Combobox.Item>
              )}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  )
}

export default SearchableSelect

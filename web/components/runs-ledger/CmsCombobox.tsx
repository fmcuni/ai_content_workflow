"use client";

import * as React from "react";
import { Combobox } from "@base-ui/react/combobox";

import { cn } from "@/lib/utils";
import { cmsOptionLabel } from "./fmt";

export interface CmsOption {
  id: number;
  name: string;
  slug: string;
}

interface CmsComboboxProps {
  value: number | null;
  onChange: (value: number | null) => void;
  options: CmsOption[];
  /** CMS short tag (`WP` / `GT`) — rendered in `name · TAG#id` (spec §2.1). */
  tag: string;
  placeholder?: string;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  disabled?: boolean;
  className?: string;
  /** Forwarded to the input for label association / a11y. */
  inputId?: string;
}

const INPUT_CLASSES =
  "w-full rounded-md border border-rule bg-paper px-2 py-1.5 text-[12.5px] text-ink " +
  "placeholder:text-ink-faint focus:border-accent focus:outline-2 focus:outline-accent/25 disabled:opacity-50";

/**
 * Searchable single-select for a CMS author/category (spec §2.1). Both the
 * selected value shown in the input AND each option render as `name · TAG#id`
 * so the operator always sees which CMS id they're picking — author/category
 * ids are target-specific and easy to confuse. Built on the same Base UI
 * Combobox as `SearchableSelect` for consistent keyboard a11y (↑/↓/Enter/Esc),
 * filtering by name, slug or id.
 */
export function CmsCombobox({
  value,
  onChange,
  options,
  tag,
  placeholder = "Search…",
  loading = false,
  error = null,
  onRetry,
  disabled = false,
  className,
  inputId,
}: CmsComboboxProps) {
  const label = React.useCallback(
    (item: CmsOption) => cmsOptionLabel(item.name, tag, item.id),
    [tag],
  );

  const selectedOption = React.useMemo(
    () => options.find((o) => o.id === value) ?? null,
    [options, value],
  );

  if (loading) {
    return (
      <input
        id={inputId}
        disabled
        aria-busy="true"
        readOnly
        value=""
        placeholder="Loading…"
        className={cn(INPUT_CLASSES, className)}
      />
    );
  }

  if (error) {
    return (
      <button
        type="button"
        id={inputId}
        onClick={onRetry}
        className={cn(INPUT_CLASSES, "text-left text-accent-deep", className)}
      >
        Failed — retry
      </button>
    );
  }

  return (
    <Combobox.Root<CmsOption, false>
      items={options}
      value={selectedOption}
      onValueChange={(next) => onChange(next?.id ?? null)}
      itemToStringLabel={label}
      itemToStringValue={(item) => String(item.id)}
      isItemEqualToValue={(a, b) => a.id === b.id}
      filter={(item, query) => {
        if (!query) return true;
        const q = query.toLowerCase();
        return (
          item.name.toLowerCase().includes(q) ||
          item.slug.toLowerCase().includes(q) ||
          String(item.id).includes(q)
        );
      }}
      disabled={disabled}
    >
      <Combobox.InputGroup className={cn("relative w-full", className)}>
        <Combobox.Input id={inputId} placeholder={placeholder} disabled={disabled} className={INPUT_CLASSES} />
        {value !== null && (
          <Combobox.Clear
            onClick={() => onChange(null)}
            aria-label="Clear selection"
            className="absolute right-1 top-1/2 -translate-y-1/2 px-1.5 py-1 text-[11px] uppercase tracking-wide text-ink-faint hover:text-ink"
          >
            Clear
          </Combobox.Clear>
        )}
      </Combobox.InputGroup>

      <Combobox.Portal>
        <Combobox.Positioner sideOffset={4} className="isolate z-[85]">
          <Combobox.Popup className="z-[85] max-h-[200px] min-w-[var(--anchor-width)] overflow-auto rounded-md border border-rule bg-paper p-1 text-[12.5px] text-ink shadow-lg">
            <Combobox.Empty className="px-2.5 py-1.5 italic text-ink-faint">No match</Combobox.Empty>
            <Combobox.List>
              {(item: CmsOption) => (
                <Combobox.Item
                  key={item.id}
                  value={item}
                  className="flex w-full cursor-default select-none items-center px-2.5 py-1.5 outline-none data-[highlighted]:bg-accent/[0.08]"
                >
                  <span className="truncate">{label(item)}</span>
                </Combobox.Item>
              )}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}

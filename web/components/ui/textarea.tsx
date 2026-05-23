import * as React from "react"

import { cn } from "@/lib/utils"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-16 w-full bg-transparent text-[13px] text-ink",
        "border-0 border-b border-rule rounded-none px-0 py-1.5",
        "outline-none transition-colors resize-none",
        "placeholder:text-ink-faint",
        "focus-visible:border-b-2 focus-visible:border-accent focus-visible:pb-[5px]",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        "aria-invalid:border-accent-deep aria-invalid:focus-visible:border-accent-deep",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }

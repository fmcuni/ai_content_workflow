import * as React from "react"
import { Input as InputPrimitive } from "@base-ui/react/input"

import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        "h-9 w-full min-w-0 bg-transparent text-[13px] text-ink",
        "border-0 border-b border-rule rounded-none px-0 py-1.5",
        "outline-none transition-colors",
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

export { Input }

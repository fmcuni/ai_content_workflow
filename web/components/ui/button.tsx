import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center border whitespace-nowrap transition-colors outline-none select-none focus-visible:ring-1 focus-visible:ring-accent disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 rounded-[2px] font-sans font-medium tracking-tight",
  {
    variants: {
      variant: {
        primary:
          "bg-ink text-paper border-ink hover:bg-accent hover:border-accent",
        secondary:
          "bg-transparent text-ink border-ink hover:bg-ink hover:text-paper",
        ghost:
          "bg-transparent text-ink border-transparent hover:border-b-ink rounded-none",
        destructive:
          "bg-transparent text-accent-deep border-accent-deep hover:bg-accent-deep hover:text-paper",
        // Legacy fallback so unmigrated callers don't break visually.
        default:
          "bg-ink text-paper border-ink hover:bg-accent hover:border-accent",
        outline:
          "bg-transparent text-ink border-ink hover:bg-ink hover:text-paper",
        link:
          "bg-transparent text-accent border-transparent hover:underline underline-offset-4",
      },
      size: {
        default: "h-9 px-3 text-[13px] gap-1.5",
        xs: "h-6 px-2 text-[11px] gap-1",
        sm: "h-7 px-2.5 text-[12px] gap-1",
        lg: "h-10 px-4 text-[14px] gap-2",
        icon: "size-9",
        "icon-xs": "size-6",
        "icon-sm": "size-7",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "primary",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }

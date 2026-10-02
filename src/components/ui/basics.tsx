import * as React from "react";
import { Separator as SeparatorPrimitive } from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/** Small shadcn/ui primitives: Badge, Input, Separator, Kbd, Avatar (initials). */

const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-md border px-2 py-0.5 text-xs font-medium [&>svg]:pointer-events-none [&>svg]:size-3",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        destructive: "border-transparent bg-destructive/60 text-white",
        outline: "text-foreground",
      },
    },
    defaultVariants: { variant: "default" },
  },
);
function Badge({ className, variant, ...props }: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />;
}

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "flex h-9 w-full min-w-0 rounded-md border border-input bg-input/30 px-3 py-1 text-base shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 md:text-sm",
        className,
      )}
      {...props}
    />
  );
}

function Separator({ className, orientation = "horizontal", decorative = true, ...props }: React.ComponentProps<typeof SeparatorPrimitive.Root>) {
  return <SeparatorPrimitive.Root data-slot="separator" decorative={decorative} orientation={orientation} className={cn("shrink-0 bg-border data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-px", className)} {...props} />;
}

function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return <kbd data-slot="kbd" className={cn("pointer-events-none inline-flex h-5 min-w-5 select-none items-center justify-center gap-1 rounded-sm bg-muted px-1 font-sans text-xs font-medium text-muted-foreground", className)} {...props} />;
}

function Avatar({ name, className }: { name: string; className?: string }) {
  const initials = name.split(/\s+/).map((w) => w.match(/\p{L}/u)?.[0] ?? "").join("").slice(0, 2).toUpperCase() || "?";
  return <span data-slot="avatar" className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-xs font-medium text-foreground", className)} aria-hidden>{initials}</span>;
}

export { Badge, badgeVariants, Input, Separator, Kbd, Avatar };

import * as React from "react";
import { Slot } from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/** shadcn/ui Button, themed on the owner graphite tokens (x-*). */
const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-[7px] text-[14px] font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-x-t1/60 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-x-t1 font-semibold text-x-0 hover:bg-white",
        outline: "border border-x-line-2 text-x-t1 hover:bg-x-2",
        ghost: "text-x-t2 hover:bg-x-2 hover:text-x-t1",
        link: "h-auto px-0 text-x-t2 underline-offset-4 hover:text-x-t1 hover:underline",
      },
      size: {
        default: "h-10 px-4",
        sm: "h-8 px-3 text-[13px]",
        lg: "h-11 px-5 text-[15px]",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

function Button({ className, variant, size, asChild = false, ...props }: React.ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "button";
  return <Comp data-slot="button" className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}

export { Button, buttonVariants };

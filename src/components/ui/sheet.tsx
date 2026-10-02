"use client";

import * as React from "react";
import { Dialog as SheetPrimitive } from "radix-ui";
import { XIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/** shadcn/ui Sheet. Portaled content carries `barry-app` so it keeps the shell theme outside the tree. */
function Sheet(props: React.ComponentProps<typeof SheetPrimitive.Root>) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />;
}
function SheetTrigger(props: React.ComponentProps<typeof SheetPrimitive.Trigger>) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />;
}
function SheetClose(props: React.ComponentProps<typeof SheetPrimitive.Close>) {
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />;
}

const SIDE = {
  right: "inset-y-0 right-0 h-full w-3/4 border-l sm:max-w-sm data-[state=open]:animate-[ui-from-end_250ms_ease-out]",
  left: "inset-y-0 left-0 h-full w-3/4 border-r sm:max-w-sm data-[state=open]:animate-[ui-from-start_250ms_ease-out]",
  bottom: "inset-x-0 bottom-0 max-h-[85dvh] rounded-t-xl border-t data-[state=open]:animate-[ui-up_250ms_ease-out]",
  /** Bottom sheet on phones, right-side panel from `sm` up. */
  auto: "inset-x-0 bottom-0 max-h-[85dvh] rounded-t-xl border-t data-[state=open]:animate-[ui-up_250ms_ease-out] sm:inset-x-auto sm:inset-y-0 sm:right-0 sm:h-full sm:max-h-none sm:w-full sm:max-w-md sm:rounded-none sm:border-t-0 sm:border-l sm:data-[state=open]:animate-[ui-from-end_250ms_ease-out]",
} as const;

function SheetContent({ className, children, side = "right", showClose = true, dir, lang, ...props }: React.ComponentProps<typeof SheetPrimitive.Content> & { side?: keyof typeof SIDE; showClose?: boolean; dir?: "ltr" | "rtl"; lang?: string }) {
  return (
    <SheetPrimitive.Portal>
      <SheetPrimitive.Overlay data-slot="sheet-overlay" className="barry-app fixed inset-0 z-50 bg-black/60 data-[state=open]:animate-[ui-in_200ms_ease-out]" />
      <SheetPrimitive.Content
        data-slot="sheet-content"
        dir={dir}
        lang={lang}
        className={cn("barry-app fixed z-50 flex flex-col gap-4 bg-background shadow-lg outline-none", SIDE[side], className)}
        {...props}
      >
        {children}
        {showClose && (
          <SheetPrimitive.Close className="absolute end-4 top-4 rounded-xs opacity-70 transition-opacity hover:opacity-100 focus:outline-hidden focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none">
            <XIcon className="size-4" />
            <span className="sr-only">Close</span>
          </SheetPrimitive.Close>
        )}
      </SheetPrimitive.Content>
    </SheetPrimitive.Portal>
  );
}

function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="sheet-header" className={cn("flex flex-col gap-1.5 p-4 pe-12", className)} {...props} />;
}
function SheetBody({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="sheet-body" className={cn("min-h-0 flex-1 overflow-y-auto px-4", className)} {...props} />;
}
function SheetFooter({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="sheet-footer" className={cn("mt-auto flex flex-col gap-2 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]", className)} {...props} />;
}
function SheetTitle({ className, ...props }: React.ComponentProps<typeof SheetPrimitive.Title>) {
  return <SheetPrimitive.Title data-slot="sheet-title" className={cn("font-semibold text-foreground", className)} {...props} />;
}
function SheetDescription({ className, ...props }: React.ComponentProps<typeof SheetPrimitive.Description>) {
  return <SheetPrimitive.Description data-slot="sheet-description" className={cn("text-sm text-muted-foreground", className)} {...props} />;
}

export { Sheet, SheetTrigger, SheetClose, SheetContent, SheetHeader, SheetBody, SheetFooter, SheetTitle, SheetDescription };

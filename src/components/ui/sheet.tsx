"use client";

import * as React from "react";
import { Dialog as SheetPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

/**
 * shadcn/ui Sheet (Radix Dialog). `side="auto"` is the owner default: a bottom drawer on phones, an end-side
 * panel on desktop. The content carries the owner theme scope itself because it portals out of the shell.
 */
function Sheet(props: React.ComponentProps<typeof SheetPrimitive.Root>) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />;
}
const SheetTrigger = SheetPrimitive.Trigger;
const SheetClose = SheetPrimitive.Close;

const SIDES = {
  auto: "inset-x-0 bottom-0 max-h-[88dvh] rounded-t-[14px] border-t data-[state=open]:animate-[x-sheet-up_220ms_ease-out] lg:inset-x-auto lg:inset-y-0 lg:end-0 lg:h-full lg:max-h-none lg:w-[440px] lg:rounded-none lg:border-t-0 lg:border-s lg:data-[state=open]:animate-[x-sheet-side_220ms_ease-out]",
  bottom: "inset-x-0 bottom-0 max-h-[88dvh] rounded-t-[14px] border-t data-[state=open]:animate-[x-sheet-up_220ms_ease-out]",
  end: "inset-y-0 end-0 h-full w-[min(440px,100vw)] border-s data-[state=open]:animate-[x-sheet-side_220ms_ease-out]",
} as const;

function SheetContent({ className, children, side = "auto", dir, lang, ...props }: React.ComponentProps<typeof SheetPrimitive.Content> & { side?: keyof typeof SIDES; dir?: "ltr" | "rtl"; lang?: string }) {
  return (
    <SheetPrimitive.Portal>
      <SheetPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60 data-[state=open]:animate-[x-fade_200ms_ease-out]" />
      <SheetPrimitive.Content
        data-slot="sheet-content"
        dir={dir}
        lang={lang}
        className={cn("art-ops fixed z-50 flex flex-col border-x-line-2 bg-x-1 text-x-t1 shadow-[0_-30px_60px_-30px_rgba(0,0,0,0.9)] outline-none", SIDES[side], className)}
        {...props}
      >
        <div className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-x-line-2 lg:hidden" aria-hidden />
        {children}
      </SheetPrimitive.Content>
    </SheetPrimitive.Portal>
  );
}

function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="sheet-header" className={cn("flex flex-col gap-1 px-5 pb-3 pt-3 lg:pt-5", className)} {...props} />;
}
function SheetBody({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="sheet-body" className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-5", className)} {...props} />;
}
function SheetFooter({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="sheet-footer" className={cn("flex shrink-0 gap-2 border-t border-x-line px-5 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3", className)} {...props} />;
}
function SheetTitle({ className, ...props }: React.ComponentProps<typeof SheetPrimitive.Title>) {
  return <SheetPrimitive.Title data-slot="sheet-title" className={cn("text-[17px] font-semibold leading-snug tracking-[-0.01em] text-x-t1", className)} {...props} />;
}
function SheetDescription({ className, ...props }: React.ComponentProps<typeof SheetPrimitive.Description>) {
  return <SheetPrimitive.Description data-slot="sheet-description" className={cn("text-[13px] text-x-t3", className)} {...props} />;
}

export { Sheet, SheetTrigger, SheetClose, SheetContent, SheetHeader, SheetBody, SheetFooter, SheetTitle, SheetDescription };

import * as React from "react";
import { Slot } from "radix-ui";
import { cn } from "@/lib/utils";

/**
 * List rows and empty states, after shadcn/ui's Item and Empty. A row is media · content · actions; a group is
 * a bordered list with hairline dividers. Rows are links/buttons via `asChild`.
 */

function ItemGroup({ className, ...props }: React.ComponentProps<"div">) {
  return <div role="list" data-slot="item-group" className={cn("flex flex-col divide-y overflow-hidden rounded-lg border", className)} {...props} />;
}

function Item({ className, asChild, ...props }: React.ComponentProps<"div"> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "div";
  return (
    <Comp
      role="listitem"
      data-slot="item"
      className={cn("flex min-h-14 items-center gap-3 px-4 py-3 text-sm outline-none transition-colors [a&]:hover:bg-accent/50 [button&]:hover:bg-accent/50 [button&]:w-full [button&]:text-start focus-visible:bg-accent/50", className)}
      {...props}
    />
  );
}
function ItemMedia({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="item-media" className={cn("flex shrink-0 items-center justify-center text-muted-foreground [&_svg:not([class*='size-'])]:size-4", className)} {...props} />;
}
function ItemContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="item-content" className={cn("flex min-w-0 flex-1 flex-col gap-0.5", className)} {...props} />;
}
function ItemTitle({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="item-title" className={cn("truncate font-medium leading-snug", className)} {...props} />;
}
function ItemDescription({ className, ...props }: React.ComponentProps<"p">) {
  return <p data-slot="item-description" className={cn("truncate text-sm leading-normal text-muted-foreground", className)} {...props} />;
}
function ItemActions({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="item-actions" className={cn("flex shrink-0 items-center gap-2 text-muted-foreground", className)} {...props} />;
}

function Empty({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="empty" className={cn("flex min-w-0 flex-1 flex-col items-center justify-center gap-6 rounded-lg border border-dashed p-6 text-center text-balance md:p-12", className)} {...props} />;
}
function EmptyHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="empty-header" className={cn("flex max-w-sm flex-col items-center gap-2 text-center", className)} {...props} />;
}
function EmptyMedia({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="empty-media" className={cn("mb-2 flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground [&_svg:not([class*='size-'])]:size-5", className)} {...props} />;
}
function EmptyTitle({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="empty-title" className={cn("text-lg font-medium tracking-tight", className)} {...props} />;
}
function EmptyDescription({ className, ...props }: React.ComponentProps<"p">) {
  return <p data-slot="empty-description" className={cn("text-sm/relaxed text-muted-foreground", className)} {...props} />;
}
function EmptyContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="empty-content" className={cn("flex w-full max-w-sm min-w-0 flex-col items-center gap-4 text-sm text-balance", className)} {...props} />;
}

export { ItemGroup, Item, ItemMedia, ItemContent, ItemTitle, ItemDescription, ItemActions, Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription, EmptyContent };

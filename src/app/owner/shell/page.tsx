"use client";

import * as React from "react";
import { ChevronRightIcon, CircleIcon, InboxIcon, MoreHorizontalIcon, PlusIcon } from "lucide-react";
import { AppShell, Page, PageHeader, Section } from "@/components/app-shell/AppShell";
import { Button } from "@/components/ui/button";
import { Badge, Input } from "@/components/ui/basics";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle, Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from "@/components/ui/item";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";

/**
 * SHELL PREVIEW — the new application frame with placeholder content only. Not linked from the product; nothing
 * here reads or writes business data. It exists to approve the frame before Home is rebuilt inside it.
 */

const ROWS = [
  { id: "1", title: "List row title", sub: "Secondary line with one short detail", meta: "2h", status: "Open" },
  { id: "2", title: "Another list row", sub: "Supporting text stays on one line", meta: "5h", status: "Open" },
  { id: "3", title: "A third row with a longer title that truncates on small screens", sub: "Muted secondary text", meta: "1d", status: "Waiting" },
];

export default function ShellPreview() {
  const [open, setOpen] = React.useState<(typeof ROWS)[number] | null>(null);
  const [filter, setFilter] = React.useState("all");

  return (
    <AppShell active="home" title="Home" workspace={{ name: "Rina Studio", detail: "Practice mode" }} user={{ name: "Rina Cohen", email: "owner@example.com" }} badges={{ work: 3 }}>
      <Page>
        <PageHeader
          title="Page title"
          description="One sentence of supporting description for this page."
          actions={
            <>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm">View: {filter === "all" ? "All" : filter === "open" ? "Open" : "Waiting"}</Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-40">
                  <DropdownMenuRadioGroup value={filter} onValueChange={setFilter}>
                    <DropdownMenuRadioItem value="all">All</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="open">Open</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="waiting">Waiting</DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
              <Dialog>
                <DialogTrigger asChild>
                  <Button size="sm" data-testid="open-dialog">
                    <PlusIcon />
                    New
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Dialog title</DialogTitle>
                    <DialogDescription>A short description of what this dialog does and what happens next.</DialogDescription>
                  </DialogHeader>
                  <Input placeholder="Placeholder input" />
                  <DialogFooter>
                    <DialogClose asChild>
                      <Button variant="outline">Cancel</Button>
                    </DialogClose>
                    <Button>Continue</Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </>
          }
        />

        <Section title="Section title" description="List rows open their details in a sheet." action={<Button variant="link" size="sm" className="h-auto px-0">View all</Button>}>
          <ItemGroup>
            {ROWS.map((r) => (
              <Item key={r.id} className="pe-2">
                <button type="button" className="flex min-w-0 flex-1 items-center gap-3 text-start outline-none" onClick={() => setOpen(r)} data-testid="list-row">
                  <ItemMedia>
                    <CircleIcon className="size-2.5 fill-current" />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{r.title}</ItemTitle>
                    <ItemDescription>{r.sub}</ItemDescription>
                  </ItemContent>
                </button>
                <ItemActions>
                  <Badge variant="outline" className="hidden sm:inline-flex">{r.status}</Badge>
                  <span className="w-7 text-end text-xs tabular-nums">{r.meta}</span>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon-sm" aria-label="Row actions">
                        <MoreHorizontalIcon />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-44">
                      <DropdownMenuItem onSelect={() => setOpen(r)}>Open details</DropdownMenuItem>
                      <DropdownMenuItem>Assign</DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem variant="destructive">Dismiss</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </ItemActions>
              </Item>
            ))}
          </ItemGroup>
        </Section>

        <Section title="Navigational rows">
          <ItemGroup>
            {["Row that links somewhere", "Second navigational row"].map((t) => (
              <Item key={t} asChild>
                <a href="#">
                  <ItemContent>
                    <ItemTitle>{t}</ItemTitle>
                    <ItemDescription>Optional secondary line</ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <ChevronRightIcon className="size-4 rtl:rotate-180" />
                  </ItemActions>
                </a>
              </Item>
            ))}
          </ItemGroup>
        </Section>

        <Section title="Empty state">
          <Empty>
            <EmptyHeader>
              <EmptyMedia>
                <InboxIcon />
              </EmptyMedia>
              <EmptyTitle>Nothing here yet</EmptyTitle>
              <EmptyDescription>A sentence that says what will appear here and when.</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button variant="outline" size="sm">Secondary action</Button>
            </EmptyContent>
          </Empty>
        </Section>

        <Section title="Buttons">
          <div className="flex flex-wrap items-center gap-2">
            <Button>Primary</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="outline">Outline</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="destructive">Destructive</Button>
            <Button variant="link">Link</Button>
          </div>
        </Section>
      </Page>

      <Sheet open={Boolean(open)} onOpenChange={(o) => !o && setOpen(null)}>
        <SheetContent side="auto" data-testid="detail-sheet">
          <SheetHeader>
            <SheetTitle>{open?.title}</SheetTitle>
            <SheetDescription>{open?.sub}</SheetDescription>
          </SheetHeader>
          <SheetBody>
            <dl className="grid gap-4 text-sm">
              {[
                ["Status", open?.status],
                ["Updated", open?.meta === "1d" ? "Yesterday" : `${open?.meta} ago`],
                ["Detail", "Longer detail text lives in the sheet, not on the page. It can wrap to several lines without crowding the list."],
              ].map(([k, v]) => (
                <div key={k} className="grid gap-1">
                  <dt className="text-muted-foreground">{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
          </SheetBody>
          <SheetFooter className="border-t sm:flex-row sm:justify-end">
            <Button variant="outline" onClick={() => setOpen(null)}>Close</Button>
            <Button>Primary action</Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </AppShell>
  );
}

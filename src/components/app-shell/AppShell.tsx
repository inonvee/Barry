"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ActivityIcon,
  BookOpenIcon,
  ChevronsUpDownIcon,
  HomeIcon,
  LayersIcon,
  LogOutIcon,
  MenuIcon,
  MessageSquareIcon,
  PlugIcon,
  ScaleIcon,
  SearchIcon,
  SettingsIcon,
  UsersIcon,
  WalletIcon,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Avatar, Kbd } from "@/components/ui/basics";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { TooltipProvider } from "@/components/ui/tooltip";

/**
 * THE BARRY APP SHELL — a plain, mature application frame (shadcn/ui primitives, neutral theme):
 *   desktop  fixed sidebar (workspace · primary · secondary · account) + sticky top bar (page title · ⌘K)
 *   mobile   top bar (menu · title · search) + bottom tab bar; the full navigation opens as a sheet
 * Navigation entries are placeholders until the information architecture is redesigned.
 */

export type NavItem = { id: string; label: string; href: string; icon: LucideIcon };

export const PRIMARY_NAV: NavItem[] = [
  { id: "home", label: "Home", href: "#home", icon: HomeIcon },
  { id: "ask", label: "Ask BARRY", href: "#ask", icon: MessageSquareIcon },
  { id: "work", label: "Work", href: "#work", icon: LayersIcon },
  { id: "money", label: "Money", href: "#money", icon: WalletIcon },
];
export const SECONDARY_NAV: NavItem[] = [
  { id: "customers", label: "Customers", href: "#customers", icon: UsersIcon },
  { id: "knowledge", label: "Knowledge", href: "#knowledge", icon: BookOpenIcon },
  { id: "rules", label: "Rules", href: "#rules", icon: ScaleIcon },
  { id: "activity", label: "Activity", href: "#activity", icon: ActivityIcon },
  { id: "systems", label: "Connected systems", href: "#systems", icon: PlugIcon },
];

type ShellProps = {
  active: string;
  title: string;
  workspace: { name: string; detail?: string };
  user: { name: string; email?: string };
  badges?: Partial<Record<string, number>>;
  dir?: "ltr" | "rtl";
  children: React.ReactNode;
};

export function AppShell({ active, title, workspace, user, badges, dir = "ltr", children }: ShellProps) {
  const [navOpen, setNavOpen] = React.useState(false);
  const [cmdOpen, setCmdOpen] = React.useState(false);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCmdOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <TooltipProvider>
      <div className="barry-app flex min-h-dvh w-full bg-background text-foreground" dir={dir} data-testid="app-shell">
        {/* Desktop sidebar */}
        <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col border-e bg-sidebar text-sidebar-foreground lg:flex" data-testid="app-sidebar">
          <SidebarBody active={active} workspace={workspace} user={user} badges={badges} />
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          {/* Top bar */}
          <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/80 lg:px-6" data-testid="app-topbar">
            <Button variant="ghost" size="icon-sm" className="-ms-1.5 lg:hidden" onClick={() => setNavOpen(true)} aria-label="Open navigation">
              <MenuIcon />
            </Button>
            <h1 className="truncate text-base font-medium">{title}</h1>
            <div className="ms-auto flex items-center gap-2">
              <Button variant="outline" className="hidden h-8 w-64 justify-start gap-2 px-2.5 font-normal text-muted-foreground md:flex" onClick={() => setCmdOpen(true)} data-testid="command-trigger">
                <SearchIcon className="size-4" />
                <span className="flex-1 text-start">Search or ask BARRY…</span>
                <Kbd>⌘K</Kbd>
              </Button>
              <Button variant="ghost" size="icon-sm" className="md:hidden" onClick={() => setCmdOpen(true)} aria-label="Search or ask BARRY">
                <SearchIcon />
              </Button>
            </div>
          </header>

          <main className="flex-1 pb-[calc(4rem+env(safe-area-inset-bottom))] lg:pb-0">{children}</main>
        </div>

        {/* Mobile bottom tabs */}
        <nav className="fixed inset-x-0 bottom-0 z-30 border-t bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur supports-[backdrop-filter]:bg-background/80 lg:hidden" aria-label="Primary" data-testid="app-tabbar">
          <div className="grid h-16 grid-cols-5">
            {PRIMARY_NAV.map((n) => (
              <TabLink key={n.id} item={n} active={active === n.id} badge={badges?.[n.id]} />
            ))}
            <button type="button" onClick={() => setNavOpen(true)} className="flex flex-col items-center justify-center gap-1 text-[11px] font-medium text-muted-foreground">
              <MenuIcon className="size-5" />
              More
            </button>
          </div>
        </nav>

        {/* Mobile: the full navigation as a sheet */}
        <Sheet open={navOpen} onOpenChange={setNavOpen}>
          <SheetContent side={dir === "rtl" ? "right" : "left"} dir={dir} className="w-72 gap-0 bg-sidebar p-0 text-sidebar-foreground" showClose={false}>
            <SheetHeader className="sr-only">
              <SheetTitle>Navigation</SheetTitle>
              <SheetDescription>Every section of BARRY</SheetDescription>
            </SheetHeader>
            <SidebarBody active={active} workspace={workspace} user={user} badges={badges} onNavigate={() => setNavOpen(false)} />
          </SheetContent>
        </Sheet>

        <CommandMenu open={cmdOpen} onOpenChange={setCmdOpen} />
      </div>
    </TooltipProvider>
  );
}

function SidebarBody({ active, workspace, user, badges, onNavigate }: Pick<ShellProps, "active" | "workspace" | "user" | "badges"> & { onNavigate?: () => void }) {
  return (
    <div className="flex h-full flex-col">
      {/* Workspace */}
      <div className="flex h-14 shrink-0 items-center gap-2.5 px-4">
        <span className="flex size-7 items-center justify-center rounded-md bg-sidebar-primary text-xs font-semibold text-sidebar-primary-foreground">B</span>
        <div className="grid min-w-0 flex-1 leading-tight">
          <span className="truncate text-sm font-semibold">{workspace.name}</span>
          {workspace.detail && <span className="truncate text-xs text-muted-foreground">{workspace.detail}</span>}
        </div>
      </div>

      <nav className="flex flex-1 flex-col gap-4 overflow-y-auto px-2 py-2" aria-label="Sections">
        <NavGroup items={PRIMARY_NAV} active={active} badges={badges} onNavigate={onNavigate} />
        <div className="flex flex-col gap-1">
          <p className="px-2 py-1 text-xs font-medium text-muted-foreground">Business</p>
          <NavGroup items={SECONDARY_NAV} active={active} badges={badges} onNavigate={onNavigate} />
        </div>
      </nav>

      <div className="flex flex-col gap-1 border-t p-2">
        <NavLink item={{ id: "settings", label: "Settings", href: "#settings", icon: SettingsIcon }} active={active === "settings"} onNavigate={onNavigate} />
        <UserMenu user={user} />
      </div>
    </div>
  );
}

function NavGroup({ items, active, badges, onNavigate }: { items: NavItem[]; active: string; badges?: Partial<Record<string, number>>; onNavigate?: () => void }) {
  return (
    <ul className="flex flex-col gap-0.5">
      {items.map((n) => (
        <li key={n.id}>
          <NavLink item={n} active={active === n.id} badge={badges?.[n.id]} onNavigate={onNavigate} />
        </li>
      ))}
    </ul>
  );
}

function NavLink({ item, active, badge, onNavigate }: { item: NavItem; active: boolean; badge?: number; onNavigate?: () => void }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex h-8 items-center gap-2 rounded-md px-2 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-sidebar-ring [&_svg]:size-4 [&_svg]:shrink-0",
        active ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground" : "text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
      )}
      data-testid={`nav-${item.id}`}
    >
      <Icon />
      <span className="flex-1 truncate">{item.label}</span>
      {badge ? <span className="min-w-5 rounded-md bg-sidebar-accent px-1.5 text-center text-xs font-medium tabular-nums">{badge}</span> : null}
    </Link>
  );
}

function TabLink({ item, active, badge }: { item: NavItem; active: boolean; badge?: number }) {
  const Icon = item.icon;
  return (
    <Link href={item.href} aria-current={active ? "page" : undefined} className={cn("relative flex flex-col items-center justify-center gap-1 text-[11px] font-medium", active ? "text-foreground" : "text-muted-foreground")} data-testid={`tab-${item.id}`}>
      <span className="relative">
        <Icon className="size-5" />
        {badge ? <span className="absolute -end-2.5 -top-1.5 min-w-4 rounded-full bg-foreground px-1 text-center text-[10px] font-semibold leading-4 text-background tabular-nums">{badge}</span> : null}
      </span>
      {item.label.replace("Ask BARRY", "Ask")}
    </Link>
  );
}

function UserMenu({ user }: { user: ShellProps["user"] }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="flex h-12 w-full items-center gap-2 rounded-md px-2 text-start text-sm outline-none hover:bg-sidebar-accent/60 focus-visible:ring-2 focus-visible:ring-sidebar-ring data-[state=open]:bg-sidebar-accent" data-testid="user-menu">
          <Avatar name={user.name} />
          <span className="grid min-w-0 flex-1 leading-tight">
            <span className="truncate font-medium">{user.name}</span>
            {user.email && <span className="truncate text-xs text-muted-foreground">{user.email}</span>}
          </span>
          <ChevronsUpDownIcon className="size-4 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-(--radix-dropdown-menu-trigger-width) min-w-56">
        <DropdownMenuLabel className="font-normal text-muted-foreground">{user.email ?? user.name}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem>
          <SettingsIcon />
          Account settings
        </DropdownMenuItem>
        <DropdownMenuItem>
          <WalletIcon />
          Plan & billing
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem>
          <LogOutIcon />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** ⌘K — jump anywhere, or hand BARRY a request (placeholder wiring until the IA lands). */
function CommandMenu({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const router = useRouter();
  const go = (href: string) => {
    onOpenChange(false);
    router.push(href);
  };
  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title="Search or ask BARRY" description="Jump to a section or ask BARRY">
      <CommandInput placeholder="Search or ask BARRY…" />
      <CommandList>
        <CommandEmpty>No results.</CommandEmpty>
        <CommandGroup heading="Go to">
          {[...PRIMARY_NAV, ...SECONDARY_NAV].map((n) => {
            const Icon = n.icon;
            return (
              <CommandItem key={n.id} onSelect={() => go(n.href)}>
                <Icon />
                {n.label}
              </CommandItem>
            );
          })}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}

/** Page container: one width, one gutter, one vertical rhythm. */
export function Page({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("mx-auto flex w-full max-w-5xl flex-col gap-8 px-4 py-6 lg:px-8 lg:py-8", className)} {...props} />;
}

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="flex min-w-0 flex-col gap-1">
        <h2 className="text-2xl font-semibold tracking-tight">{title}</h2>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Section({ title, description, action, children }: { title: string; description?: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-end justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h3 className="text-sm font-medium">{title}</h3>
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

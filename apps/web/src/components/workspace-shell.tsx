/**
 * Function index:
 * - WorkspaceShell: shared authenticated application chrome for every pilot route.
 * - WorkspaceNavigation: renders desktop and mobile navigation with active-route state.
 */
import Link from "next/link";
import type { ReactNode } from "react";

import {
  CalendarIcon,
  CatalogIcon,
  CustomersIcon,
  DashboardIcon,
  FinanceIcon,
  GroomingIcon,
  InventoryIcon,
  ProgramsIcon,
  ReportsIcon,
  TasksIcon,
} from "@/components/icons";
import { LogoutButton } from "@/components/logout-button";
import { OperroMark } from "@/components/operro-mark";
import { OrganizationSwitcher } from "@/components/organization-switcher";
import type { AccessibleOrganization } from "@/lib/organizations";

interface WorkspaceShellProps {
  organizations: readonly AccessibleOrganization[];
  activeOrganization: AccessibleOrganization;
  userEmail: string;
  activePath: string;
  children: ReactNode;
}

const primaryNavigation = [
  { label: "Ringkasan", href: "/dashboard", icon: DashboardIcon },
  { label: "Booking", href: "/bookings", icon: CalendarIcon },
  { label: "Pelanggan", href: "/customers", icon: CustomersIcon },
  { label: "Tugas", href: "/tasks", icon: TasksIcon },
];

const managementNavigation = [
  { label: "Operasional", href: "/operations", icon: GroomingIcon },
  { label: "Layanan & tim", href: "/catalog", icon: CatalogIcon },
  { label: "Paket", href: "/programs", icon: ProgramsIcon },
  { label: "Inventaris", href: "/inventory", icon: InventoryIcon },
  { label: "Keuangan", href: "/finance", icon: FinanceIcon },
  { label: "Laporan", href: "/reports", icon: ReportsIcon },
];

function NavigationItem({
  item,
  activePath,
  compact = false,
}: {
  item: (typeof primaryNavigation)[number];
  activePath: string;
  compact?: boolean;
}) {
  const Icon = item.icon;
  const active = activePath === item.href || activePath.startsWith(`${item.href}/`);
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={compact
        ? `flex flex-col items-center gap-1 rounded-xl px-2 py-2 text-[10px] font-semibold ${active ? "bg-emerald-50 text-emerald-800" : "text-slate-400"}`
        : `flex h-11 items-center gap-3 rounded-xl px-3 text-sm font-semibold transition ${active ? "bg-emerald-50 text-emerald-800" : "text-slate-500 hover:bg-slate-50 hover:text-slate-800"}`}
    >
      <Icon className={compact ? "size-4" : "size-5"} />
      {item.label}
    </Link>
  );
}

function WorkspaceNavigation({ activePath }: { activePath: string }) {
  return (
    <>
      <nav aria-label="Navigasi utama" className="mt-8 space-y-1.5">
        {primaryNavigation.map((item) => <NavigationItem key={item.href} item={item} activePath={activePath} />)}
      </nav>
      <p className="mb-2 mt-7 px-3 text-[10px] font-bold uppercase tracking-[0.18em] text-slate-300">Pengelolaan</p>
      <nav aria-label="Navigasi pengelolaan" className="space-y-1.5">
        {managementNavigation.map((item) => <NavigationItem key={item.href} item={item} activePath={activePath} />)}
      </nav>
    </>
  );
}

export function WorkspaceShell({ organizations, activeOrganization, userEmail, activePath, children }: WorkspaceShellProps) {
  return (
    <div className="min-h-screen bg-[#f6f8f7] text-slate-950">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 overflow-y-auto border-r border-slate-200 bg-white p-5 lg:flex lg:flex-col">
        <OperroMark />
        <WorkspaceNavigation activePath={activePath} />
        <div className="mt-auto space-y-3 pt-8">
          <div className="flex items-center gap-3 rounded-xl bg-slate-50 p-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-full bg-slate-900 text-xs font-bold uppercase text-white">{userEmail.slice(0, 1)}</span>
            <span className="min-w-0">
              <span className="block text-xs font-semibold text-slate-400">Akun masuk</span>
              <span className="block truncate text-sm font-semibold text-slate-700">{userEmail}</span>
            </span>
          </div>
          <LogoutButton compact />
        </div>
      </aside>

      <div className="lg:pl-64">
        <header className="sticky top-0 z-20 border-b border-slate-200/80 bg-white/90 px-4 py-4 backdrop-blur-xl sm:px-7">
          <div className="mx-auto flex max-w-7xl flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex w-full items-center justify-between sm:w-auto lg:hidden">
              <OperroMark />
              <span className="max-w-44 truncate text-xs font-semibold text-slate-400">{userEmail}</span>
            </div>
            <div className="hidden min-w-0 lg:block">
              <p className="text-xs font-bold uppercase tracking-[0.16em] text-emerald-700">Workspace aktif</p>
              <p className="mt-1 truncate text-sm font-semibold text-slate-700">{activeOrganization.name}</p>
            </div>
            <div className="w-full sm:max-w-md">
              <OrganizationSwitcher organizations={organizations} activeOrganizationId={activeOrganization.id} variant="compact" />
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-7xl px-4 py-7 pb-28 sm:px-7 sm:py-10 lg:pb-10">{children}</main>
        <nav aria-label="Navigasi seluler" className="fixed inset-x-4 bottom-4 z-30 grid grid-cols-4 rounded-2xl border border-slate-200 bg-white/95 p-2 shadow-2xl shadow-slate-950/10 backdrop-blur lg:hidden">
          {primaryNavigation.map((item) => <NavigationItem key={item.href} item={item} activePath={activePath} compact />)}
        </nav>
      </div>
    </div>
  );
}

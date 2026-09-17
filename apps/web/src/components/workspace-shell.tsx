/**
 * Function index:
 * - WorkspaceShell: shared authenticated application chrome for every pilot route.
 * - WorkspaceNavigation: renders desktop and mobile navigation with active-route state.
 */
import Link from "next/link";
import type { ReactNode } from "react";

import {
  BookingIcon,
  CalendarIcon,
  CatalogIcon,
  CustomersIcon,
  DashboardIcon,
  FinanceIcon,
  FollowupIcon,
  GroomingIcon,
  InventoryIcon,
  LeaderboardIcon,
  MyScheduleIcon,
  PayrollIcon,
  ProgramsIcon,
  ReportsIcon,
  TasksIcon,
} from "@/components/icons";
import { CommandPalette } from "@/components/command-palette";
import { LogoutButton } from "@/components/logout-button";
import { OperroMark } from "@/components/operro-mark";
import { OrganizationSwitcher } from "@/components/organization-switcher";
import { WorkspaceMobileMenu } from "@/components/workspace-mobile-menu";
import type { CapabilityMap } from "@/lib/authorization";
import type { AccessibleOrganization } from "@/lib/organizations";

interface WorkspaceShellProps {
  organizations: readonly AccessibleOrganization[];
  activeOrganization: AccessibleOrganization;
  userEmail: string;
  activePath: string;
  capabilities: CapabilityMap;
  children: ReactNode;
}

type NavigationItemConfig = {
  label: string;
  href: string;
  icon: typeof DashboardIcon;
  permission?: keyof CapabilityMap;
  anyPermission?: readonly (keyof CapabilityMap)[];
};

const primaryNavigation: NavigationItemConfig[] = [
  { label: "Ringkasan", href: "/dashboard", icon: DashboardIcon, anyPermission: ["booking.create", "customer.read", "finance.read", "inventory.read", "membership.read", "payroll.read", "reports.view", "service.manage", "task.manage"] },
  { label: "Kalender", href: "/schedule", icon: CalendarIcon, permission: "booking.read" },
  { label: "Booking", href: "/bookings", icon: BookingIcon, permission: "booking.create" },
  { label: "Pelanggan", href: "/customers", icon: CustomersIcon, permission: "customer.read" },
  { label: "Tugas", href: "/tasks", icon: TasksIcon, permission: "task.manage" },
];

const managementNavigation: NavigationItemConfig[] = [
  { label: "Operasional", href: "/operations", icon: GroomingIcon, permission: "booking.update" },
  { label: "Jadwal saya", href: "/my-schedule", icon: MyScheduleIcon, permission: "booking.read" },
  { label: "Layanan & tim", href: "/catalog", icon: CatalogIcon, anyPermission: ["service.manage", "resource.manage"] },
  { label: "Paket", href: "/programs", icon: ProgramsIcon, permission: "membership.read" },
  { label: "Inventaris", href: "/inventory", icon: InventoryIcon, permission: "inventory.read" },
  { label: "Keuangan", href: "/finance", icon: FinanceIcon, permission: "finance.read" },
  { label: "Payroll", href: "/payroll", icon: PayrollIcon, permission: "payroll.read" },
  { label: "Laporan", href: "/reports", icon: ReportsIcon, permission: "reports.view" },
  { label: "Leaderboard", href: "/leaderboard", icon: LeaderboardIcon, permission: "booking.read" },
  { label: "Follow-up", href: "/followups", icon: FollowupIcon, permission: "customer.read" },
];

function NavigationItem({
  item,
  activePath,
  compact = false,
}: {
  item: NavigationItemConfig;
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
        ? `flex flex-col items-center gap-1 rounded-[10px] px-2 py-2 text-[10px] font-semibold ${active ? "bg-[#e3f5f1] text-[#0b6e5a]" : "text-slate-400"}`
        : `flex h-10 items-center gap-3 rounded-[10px] border px-3 text-[13px] font-semibold transition ${active ? "border-white/10 bg-white/10 text-white shadow-sm" : "border-transparent text-slate-400 hover:bg-white/[0.06] hover:text-white"}`}
    >
      <Icon className={compact ? "size-4" : "size-5"} />
      {item.label}
    </Link>
  );
}

function isNavigationVisible(item: NavigationItemConfig, capabilities: CapabilityMap) {
  if (item.permission && !capabilities[item.permission]) return false;
  if (item.anyPermission && !item.anyPermission.some((key) => capabilities[key])) return false;
  return true;
}

function WorkspaceNavigation({ activePath, capabilities }: { activePath: string; capabilities: CapabilityMap }) {
  const visiblePrimary = primaryNavigation.filter((item) => isNavigationVisible(item, capabilities));
  const visibleManagement = managementNavigation.filter((item) => isNavigationVisible(item, capabilities));
  return (
    <>
      <nav aria-label="Navigasi utama" className="mt-7 space-y-1">
        {visiblePrimary.map((item) => <NavigationItem key={item.href} item={item} activePath={activePath} />)}
      </nav>
      {visibleManagement.length > 0 ? <>
        <p className="mb-2 mt-6 px-3 text-[10px] font-bold uppercase tracking-[0.18em] text-slate-500">Pengelolaan</p>
        <nav aria-label="Navigasi pengelolaan" className="space-y-1">
          {visibleManagement.map((item) => <NavigationItem key={item.href} item={item} activePath={activePath} />)}
        </nav>
      </> : null}
    </>
  );
}

export function WorkspaceShell({ organizations, activeOrganization, userEmail, activePath, capabilities, children }: WorkspaceShellProps) {
  const visiblePrimary = primaryNavigation.filter((item) => isNavigationVisible(item, capabilities));
  return (
    <div className="min-h-screen bg-[#f6f7f9] text-[#1a2233]">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 overflow-y-auto border-r border-white/[0.06] bg-[#0f1b2d] p-4 lg:flex lg:flex-col">
        <div className="border-b border-white/[0.08] px-2 pb-4 pt-1"><OperroMark inverse /></div>
        <WorkspaceNavigation activePath={activePath} capabilities={capabilities} />
        <div className="mt-auto space-y-3 pt-8">
          <div className="flex items-center gap-3 rounded-[12px] border border-white/[0.08] bg-white/[0.05] p-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-full bg-[#0f8a72] text-xs font-bold uppercase text-white">{userEmail.slice(0, 1)}</span>
            <span className="min-w-0">
              <span className="block text-[10px] font-semibold uppercase tracking-wide text-slate-500">Akun masuk</span>
              <span className="block truncate text-xs font-semibold text-slate-300">{userEmail}</span>
            </span>
          </div>
          <LogoutButton compact inverse />
        </div>
      </aside>

      <div className="lg:pl-64">
        <header className="sticky top-0 z-20 border-b border-[#e4e7ec] bg-white/95 px-4 py-3 backdrop-blur-xl sm:px-7">
          <div className="mx-auto flex max-w-[1440px] flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex w-full items-center justify-between gap-3 sm:w-auto lg:hidden">
              <div className="flex min-w-0 items-center gap-3">
                <WorkspaceMobileMenu activePath={activePath} userEmail={userEmail} capabilities={capabilities} />
                <OperroMark />
              </div>
              <span className="max-w-36 truncate text-xs font-semibold text-slate-400">{userEmail}</span>
            </div>
            <div className="hidden min-w-0 lg:block lg:w-52">
              <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-[#0f8a72]">Workspace aktif</p>
              <p className="mt-0.5 truncate text-sm font-bold text-[#1a2233]">{activeOrganization.name}</p>
            </div>
            <div className="w-full sm:max-w-xs lg:max-w-md">
              <CommandPalette />
            </div>
            <div className="w-full sm:max-w-md">
              <OrganizationSwitcher organizations={organizations} activeOrganizationId={activeOrganization.id} variant="compact" />
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-[1440px] px-4 py-7 pb-28 sm:px-7 sm:py-9 lg:pb-10">{children}</main>
        <nav aria-label="Navigasi seluler" className="fixed inset-x-4 bottom-4 z-30 grid rounded-[16px] border border-[#e4e7ec] bg-white/95 p-2 shadow-2xl shadow-slate-950/10 backdrop-blur lg:hidden" style={{ gridTemplateColumns: `repeat(${Math.max(visiblePrimary.length, 1)}, minmax(0, 1fr))` }}>
          {visiblePrimary.map((item) => <NavigationItem key={item.href} item={item} activePath={activePath} compact />)}
        </nav>
      </div>
    </div>
  );
}

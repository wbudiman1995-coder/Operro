"use client";

/**
 * Function index:
 * - WorkspaceMobileMenu: exposes the complete workspace navigation on small screens.
 */
import Link from "next/link";
import { useEffect, useState, type ComponentType, type SVGProps } from "react";

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
import { LogoutButton } from "@/components/logout-button";
import { OperroMark } from "@/components/operro-mark";
import type { CapabilityMap } from "@/lib/authorization";

type Icon = ComponentType<SVGProps<SVGSVGElement>>;
type MenuItem = { label: string; href: string; icon: Icon; permission?: keyof CapabilityMap; anyPermission?: readonly (keyof CapabilityMap)[] };

const sections: { label: string; items: MenuItem[] }[] = [
  {
    label: "Utama",
    items: [
      { label: "Ringkasan", href: "/dashboard", icon: DashboardIcon, anyPermission: ["booking.create", "customer.read", "finance.read", "inventory.read", "membership.read", "payroll.read", "reports.view", "service.manage", "task.manage"] },
      { label: "Kalender", href: "/schedule", icon: CalendarIcon, permission: "booking.read" },
      { label: "Booking", href: "/bookings", icon: BookingIcon, permission: "booking.create" },
      { label: "Pelanggan", href: "/customers", icon: CustomersIcon, permission: "customer.read" },
      { label: "Tugas", href: "/tasks", icon: TasksIcon, permission: "task.manage" },
    ],
  },
  {
    label: "Pengelolaan",
    items: [
      { label: "Operasional", href: "/operations", icon: GroomingIcon, permission: "booking.update" },
      { label: "Jadwal saya", href: "/my-schedule", icon: MyScheduleIcon, permission: "booking.read" },
      { label: "Layanan & tim", href: "/catalog", icon: CatalogIcon, anyPermission: ["service.manage", "resource.manage"] },
      { label: "Paket", href: "/programs", icon: ProgramsIcon, permission: "membership.read" },
      { label: "Inventaris", href: "/inventory", icon: InventoryIcon, permission: "inventory.read" },
      { label: "Keuangan", href: "/finance", icon: FinanceIcon, permission: "finance.read" },
      { label: "Payroll", href: "/payroll", icon: PayrollIcon, permission: "payroll.read" },
      { label: "Kehadiran", href: "/attendance", icon: MyScheduleIcon, anyPermission: ["payroll.read", "resource.manage"] },
      { label: "Laporan", href: "/reports", icon: ReportsIcon, permission: "reports.view" },
      { label: "Leaderboard", href: "/leaderboard", icon: LeaderboardIcon, permission: "booking.read" },
      { label: "Follow-up", href: "/followups", icon: FollowupIcon, permission: "customer.read" },
    ],
  },
];

function isVisible(item: MenuItem, capabilities: CapabilityMap) {
  if (item.permission && !capabilities[item.permission]) return false;
  if (item.anyPermission && !item.anyPermission.some((key) => capabilities[key])) return false;
  return true;
}

export function WorkspaceMobileMenu({ activePath, userEmail, capabilities }: { activePath: string; userEmail: string; capabilities: CapabilityMap }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        aria-label="Buka semua navigasi"
        aria-expanded={open}
        aria-controls="workspace-mobile-navigation"
        onClick={() => setOpen(true)}
        className="grid size-10 place-items-center rounded-[10px] border border-[#e4e7ec] bg-white text-[#1a2233] shadow-sm lg:hidden"
      >
        <span aria-hidden="true" className="space-y-1">
          <span className="block h-0.5 w-4 rounded bg-current" />
          <span className="block h-0.5 w-4 rounded bg-current" />
          <span className="block h-0.5 w-4 rounded bg-current" />
        </span>
      </button>

      {open ? (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigasi workspace">
          <button type="button" aria-label="Tutup navigasi" onClick={() => setOpen(false)} className="absolute inset-0 bg-slate-950/55 backdrop-blur-sm" />
          <aside id="workspace-mobile-navigation" className="absolute inset-y-0 left-0 flex w-[min(88vw,22rem)] flex-col overflow-y-auto bg-[#0f1b2d] p-4 shadow-2xl">
            <div className="flex items-center justify-between border-b border-white/[0.08] px-2 pb-4 pt-1">
              <OperroMark inverse />
              <button type="button" aria-label="Tutup navigasi" onClick={() => setOpen(false)} className="grid size-9 place-items-center rounded-[9px] text-2xl text-slate-400 hover:bg-white/[0.06] hover:text-white">×</button>
            </div>

            <div className="space-y-6 py-5">
              {sections.map((section) => {
                const visibleItems = section.items.filter((item) => isVisible(item, capabilities));
                if (visibleItems.length === 0) return null;
                return <section key={section.label}>
                  <p className="mb-2 px-3 text-[10px] font-bold uppercase tracking-[0.18em] text-slate-500">{section.label}</p>
                  <nav aria-label={section.label} className="space-y-1">
                    {visibleItems.map((item) => {
                      const active = activePath === item.href || activePath.startsWith(`${item.href}/`);
                      const ItemIcon = item.icon;
                      return (
                        <Link key={item.href} href={item.href} aria-current={active ? "page" : undefined} onClick={() => setOpen(false)} className={`flex h-11 items-center gap-3 rounded-[10px] border px-3 text-sm font-semibold transition ${active ? "border-white/10 bg-white/10 text-white" : "border-transparent text-slate-400 hover:bg-white/[0.06] hover:text-white"}`}>
                          <ItemIcon className="size-5" />
                          {item.label}
                        </Link>
                      );
                    })}
                  </nav>
                </section>;
              })}
            </div>

            <div className="mt-auto border-t border-white/[0.08] pt-4">
              <p className="mb-3 truncate px-1 text-xs font-semibold text-slate-400">{userEmail}</p>
              <LogoutButton inverse />
            </div>
          </aside>
        </div>
      ) : null}
    </>
  );
}

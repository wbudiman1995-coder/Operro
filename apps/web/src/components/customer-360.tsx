/**
 * Function index:
 * - Customer360Header: profile identity, contact actions, and per-currency spend.
 * - Customer360Tabs: server-rendered tab bar; each tab is a link so only its data loads.
 * - Customer360Notes: customer-level notes panel.
 */
import Link from "next/link";

import { StatusBadge } from "@/components/pilot-ui";
import { CUSTOMER_360_TAB_LABELS, type Customer360Tab, type CustomerOverview } from "@/lib/customer-360";

function formatMoney(value: number, currency: string) {
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: currency || "IDR", maximumFractionDigits: 0 }).format(value);
}

/**
 * Builds a wa.me URL from a stored phone number.
 *
 * Returns null rather than a broken link when no usable digits remain, and percent-encodes
 * the prefilled text so a customer name containing `&`, `#` or `?` cannot truncate or
 * corrupt the query string.
 */
export function buildWhatsAppUrl(phone: string | null, message?: string): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 8) return null;
  const international = digits.startsWith("0") ? `62${digits.slice(1)}` : digits;
  const base = `https://wa.me/${international}`;
  return message && message.length > 0 ? `${base}?text=${encodeURIComponent(message)}` : base;
}

export function Customer360Header({ overview }: { overview: CustomerOverview }) {
  const waUrl = buildWhatsAppUrl(overview.phone, `Halo ${overview.name},`);
  return (
    <header className="rounded-[14px] border border-[#e4e7ec] bg-white p-5 shadow-[0_1px_2px_rgba(16,24,40,0.06)] sm:p-7">
      <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-start">
        <div className="min-w-0">
          <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-[#0f8a72]">Profil 360</p>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <h1 className="text-3xl font-bold tracking-[-0.04em]">{overview.name}</h1>
            <StatusBadge status={overview.status} />
          </div>
          <p className="mt-2 text-sm text-slate-500">
            {overview.phone ?? "Nomor belum diisi"}
            {overview.email ? ` · ${overview.email}` : ""}
            {overview.source ? ` · sumber ${overview.source}` : ""}
          </p>
          {overview.addressLine ? <p className="mt-1 max-w-xl text-xs leading-5 text-slate-400">{overview.addressLine}</p> : null}
        </div>

        <div className="shrink-0 rounded-[12px] border border-[#e4e7ec] bg-[#fbfbfc] px-5 py-4">
          <p className="text-xs font-semibold text-slate-400">Total pembayaran masuk</p>
          {overview.spendByCurrency === null ? (
            <>
              {/* Never render a restricted total as zero: that asserts the customer paid
                  nothing, which is a different claim from "you may not see this". */}
              <p className="mt-1 text-sm font-bold text-slate-500">Tidak ditampilkan</p>
              <p className="mt-1 max-w-[13rem] text-[11px] leading-4 text-slate-400">Perlu izin finance.read untuk melihat nilai pembayaran.</p>
            </>
          ) : overview.spendByCurrency.length === 0 ? (
            <p className="mt-1 text-2xl font-bold tracking-[-0.03em] text-slate-900">Belum ada</p>
          ) : (
            <div className="mt-1 space-y-0.5">
              {/* One line per currency. Different currencies are never added together. */}
              {overview.spendByCurrency.map((entry) => (
                <p key={entry.currency} className="text-2xl font-bold tracking-[-0.03em] text-slate-900">
                  {formatMoney(entry.amount, entry.currency)}
                </p>
              ))}
            </div>
          )}
          <p className="mt-1 text-[11px] text-slate-400">
            {overview.pets.length} hewan terdaftar{overview.spendCapped ? " · sebagian pembayaran belum dihitung" : ""}
          </p>
        </div>
      </div>

      <div className="mt-5 flex flex-wrap gap-2">
        {waUrl ? <a href={waUrl} target="_blank" rel="noreferrer" className="rounded-[10px] bg-[#e3f5f1] px-3 py-2 text-xs font-bold text-[#0b6e5a] transition hover:bg-[#d2eee7]">Buka WhatsApp</a> : null}
        {overview.mapsUrl ? <a href={overview.mapsUrl} target="_blank" rel="noreferrer" className="rounded-[10px] bg-slate-100 px-3 py-2 text-xs font-bold text-slate-600 transition hover:bg-slate-200">Lihat lokasi</a> : null}
        {/* customerId is a preselection HINT only. /bookings re-reads it server-side,
            organization-scoped, and ignores it when the customer is not accessible. */}
        <Link href={`/bookings?customerId=${encodeURIComponent(overview.id)}#booking-baru`} className="rounded-[10px] bg-[#0f8a72] px-3 py-2 text-xs font-bold text-white transition hover:bg-[#0b6e5a]">Buat booking</Link>
        <Link href="/schedule" className="rounded-[10px] border border-[#e4e7ec] px-3 py-2 text-xs font-bold text-slate-600 transition hover:bg-[#fbfbfc]">Lihat kalender</Link>
      </div>
    </header>
  );
}

export function Customer360Tabs({
  customerId,
  activeTab,
  tabs,
}: {
  customerId: string;
  activeTab: Customer360Tab;
  /** Only tabs the caller is permitted to read; unauthorized tabs are not offered at all. */
  tabs: readonly Customer360Tab[];
}) {
  return (
    <nav aria-label="Bagian profil pelanggan" className="mt-6 flex gap-1.5 overflow-x-auto pb-1">
      {tabs.map((tab) => {
        const active = tab === activeTab;
        return (
          <Link
            key={tab}
            href={`/customers/${customerId}?tab=${tab}`}
            aria-current={active ? "page" : undefined}
            className={`shrink-0 rounded-[10px] px-3.5 py-2 text-xs font-bold transition ${active ? "bg-[#0f8a72] text-white" : "bg-white text-slate-500 ring-1 ring-[#e4e7ec] hover:text-slate-800"}`}
          >
            {CUSTOMER_360_TAB_LABELS[tab]}
          </Link>
        );
      })}
    </nav>
  );
}

export function Customer360Notes({ overview }: { overview: CustomerOverview }) {
  const petNotes = overview.pets.flatMap((pet) => (pet.notes ? [{ name: pet.name, notes: pet.notes }] : []));
  if (!overview.notes && petNotes.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50/70 px-6 py-12 text-center">
        <p className="font-bold text-slate-700">Belum ada catatan</p>
        <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-500">Catatan pelanggan dan catatan per hewan akan tampil di sini.</p>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {overview.notes ? (
        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <h3 className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-300">Catatan pelanggan</h3>
          <p className="mt-2 whitespace-pre-line text-sm leading-6 text-slate-600">{overview.notes}</p>
        </section>
      ) : null}
      {petNotes.map((entry) => (
        <section key={entry.name} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <h3 className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-300">Catatan · {entry.name}</h3>
          <p className="mt-2 whitespace-pre-line text-sm leading-6 text-slate-600">{entry.notes}</p>
        </section>
      ))}
    </div>
  );
}

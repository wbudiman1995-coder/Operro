/**
 * Customer 360 — read-only except for saved addresses.
 *
 * The Addresses tab is a deliberate, narrow exception to the read-only design: it is the
 * only place a customer's saved addresses are created, edited, deleted, or have their
 * default changed. Every other tab remains a pure read surface.
 *
 * Tabs are server-rendered and each fetches only its own data, so opening a profile does
 * not pull invoices, packages, and history the user has not asked for. There is no Visits
 * tab: Operro has one authoritative booking entity, which removes the HomePaw
 * visits/appointments duality and the reconciliation class that policed it.
 *
 * Permissions: a tab whose capability is missing is not offered and cannot be reached by
 * editing the query string. Missing permission renders as an explicit restricted state,
 * never as an empty list.
 *
 * Time zones: booking and invoice timestamps use the time zone of the branch that owns
 * the record; timeline events, which carry no branch, use the explicitly resolved
 * default-branch zone. No formatter here omits `timeZone`.
 *
 * There is no grooming photo surface. Evidence is Batch 2, on private storage.
 */
import Link from "next/link";
import { notFound } from "next/navigation";

import { Customer360Notes, Customer360Header, Customer360Tabs } from "@/components/customer-360";
import { CustomerAddressActions, CustomerAddressForm } from "@/components/customer-address-forms";
import { CustomerNextDiscount } from "@/components/customer-next-discount";
import { EmptyState, StatusBadge } from "@/components/pilot-ui";
import { RestrictedNotice } from "@/components/restricted-notice";
import { WorkspaceShell } from "@/components/workspace-shell";
import { StylingReferenceGallery, StylingReferenceUploader } from "@/components/styling-references";
import { loadCapabilities } from "@/lib/authorization";
import { loadBranchTimezones } from "@/lib/branch-context";
import {
  isCustomer360TabPermitted,
  loadCustomerAddresses,
  loadCustomerBookings,
  loadCustomerHistory,
  loadCustomerInvoices,
  loadCustomerNextDiscount,
  loadCustomerOverview,
  loadCustomerPackages,
  loadCustomerStylingReferences,
  parseCustomer360Tab,
  visibleCustomer360Tabs,
} from "@/lib/customer-360";
import { requireActiveWorkspace } from "@/lib/require-workspace";
import { formatZonedDate, formatZonedDateTime } from "@/lib/timezone";

export const metadata = { title: "Profil pelanggan" };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function formatMoney(value: number, currency: string) {
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: currency || "IDR", maximumFractionDigits: 0 }).format(value);
}

export default async function CustomerDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ customerId: string }>;
  searchParams: Promise<{ tab?: string; pet?: string }>;
}) {
  const { customerId } = await params;
  const query = await searchParams;
  if (!UUID_PATTERN.test(customerId)) notFound();

  const workspace = await requireActiveWorkspace();
  const organizationId = workspace.activeOrganization.id;
  const [capabilities, branchContext] = await Promise.all([
    loadCapabilities(workspace.supabase),
    loadBranchTimezones(workspace.supabase, organizationId),
  ]);

  const [overview, nextDiscount] = await Promise.all([
    loadCustomerOverview(workspace.supabase, organizationId, customerId, capabilities),
    loadCustomerNextDiscount(workspace.supabase, organizationId, customerId),
  ]);
  // A customer outside the active organization is filtered out by RLS, so this is the
  // cross-tenant deny path as well as the genuine not-found path.
  if (!overview) notFound();

  const requestedTab = parseCustomer360Tab(query.tab);
  const permittedTabs = visibleCustomer360Tabs(capabilities);
  const tabPermitted = isCustomer360TabPermitted(requestedTab, capabilities);
  const tab = requestedTab;

  const zoneFor = (branchId: string) => branchContext.byBranchId.get(branchId) ?? branchContext.defaultTimezone;

  const addresses = tab === "addresses" && tabPermitted ? await loadCustomerAddresses(workspace.supabase, organizationId, customerId) : [];
  const bookings = tab === "bookings" && tabPermitted ? await loadCustomerBookings(workspace.supabase, organizationId, customerId) : [];
  const invoices = tab === "invoices" && tabPermitted ? await loadCustomerInvoices(workspace.supabase, organizationId, customerId) : [];
  const packages = tab === "packages" && tabPermitted ? await loadCustomerPackages(workspace.supabase, organizationId, customerId) : [];
  const stylingReferences = tab === "style" && tabPermitted ? await loadCustomerStylingReferences(workspace.supabase, organizationId, overview.pets.map((pet) => pet.id)) : [];
  const history =
    tab === "history" && tabPermitted
      ? await loadCustomerHistory(workspace.supabase, organizationId, customerId, overview.pets.map((pet) => pet.id))
      : [];

  const restrictionCopy: Record<string, { title: string; description: string }> = {
    bookings: {
      title: "Tidak ada izin melihat booking",
      description: "Peran Anda tidak memiliki izin booking.read, sehingga riwayat booking pelanggan ini tidak dapat ditampilkan.",
    },
    invoices: {
      title: "Tidak ada izin melihat data keuangan",
      description: "Peran Anda tidak memiliki izin finance.read, sehingga invoice dan pembayaran pelanggan ini tidak dapat ditampilkan.",
    },
    packages: {
      title: "Tidak ada izin melihat paket",
      description: "Peran Anda tidak memiliki izin membership.read, sehingga saldo paket dan langganan pelanggan ini tidak dapat ditampilkan.",
    },
  };

  return (
    <WorkspaceShell {...workspace} activePath="/customers">
      <Customer360Header overview={overview} />
      {capabilities["customer.manage"] ? <CustomerNextDiscount customerId={customerId} offer={nextDiscount} /> : null}
      <Customer360Tabs customerId={customerId} activeTab={tab} tabs={permittedTabs} />

      <div className="mt-5">
        {!tabPermitted ? (
          <RestrictedNotice
            title={restrictionCopy[tab]?.title ?? "Tidak ada izin"}
            description={restrictionCopy[tab]?.description ?? "Peran Anda tidak memiliki izin untuk bagian ini."}
          />
        ) : null}

        {tabPermitted && tab === "pets" ? (
          overview.pets.length === 0 ? (
            <EmptyState title="Belum ada hewan" description="Tambahkan hewan pada halaman Pelanggan agar profil grooming dapat dilengkapi." />
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {overview.pets.map((pet) => (
                <article key={pet.id} id={`pet-${pet.id}`} className={`rounded-2xl border bg-white p-5 shadow-sm ${query.pet === pet.id ? "border-emerald-400 ring-2 ring-emerald-100" : "border-slate-200"}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="truncate text-lg font-bold text-slate-900">{pet.name}</h3>
                      <p className="mt-0.5 text-xs text-slate-500">
                        {pet.species}{pet.breed ? ` · ${pet.breed}` : ""}{pet.sex !== "unknown" ? ` · ${pet.sex}` : ""}
                      </p>
                    </div>
                    <StatusBadge status={pet.status} />
                  </div>
                  <dl className="mt-4 grid grid-cols-2 gap-3 text-xs">
                    {[
                      ["Usia", pet.ageLabel],
                      ["Berat", pet.weightKg !== null ? `${pet.weightKg} kg${pet.sizeBand ? ` · ukuran ${pet.sizeBand}` : ""}` : null],
                      ["Warna", pet.color],
                      ["Temperamen", pet.temperament],
                    ].flatMap(([label, value]) =>
                      value ? [
                        <div key={String(label)} className="rounded-xl bg-slate-50 p-3">
                          <dt className="font-semibold text-slate-400">{label}</dt>
                          <dd className="mt-0.5 font-bold text-slate-700">{value}</dd>
                        </div>,
                      ] : [],
                    )}
                  </dl>
                  {pet.medicalFlags.length > 0 ? (
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {pet.medicalFlags.map((flag) => <span key={flag} className="rounded-full bg-rose-50 px-2.5 py-1 text-[11px] font-bold text-rose-700">{flag}</span>)}
                    </div>
                  ) : null}
                  {pet.customFields.length > 0 ? (
                    <dl className="mt-3 space-y-1 border-t border-slate-100 pt-3 text-xs">
                      {pet.customFields.map((field) => (
                        <div key={field.label} className="flex justify-between gap-3">
                          <dt className="text-slate-400">{field.label}</dt>
                          <dd className="truncate font-semibold text-slate-600">{field.value}</dd>
                        </div>
                      ))}
                    </dl>
                  ) : null}
                  {pet.notes ? <p className="mt-3 whitespace-pre-line rounded-xl bg-amber-50 p-3 text-xs leading-5 text-amber-900">{pet.notes}</p> : null}
                </article>
              ))}
            </div>
          )
        ) : null}

        {tabPermitted && tab === "style" ? (
          <div className="space-y-4">
            {overview.pets.length > 0 && capabilities["customer.manage"] ? <StylingReferenceUploader customerId={customerId} pets={overview.pets.map((pet)=>({id:pet.id,name:pet.name}))}/> : null}
            {stylingReferences.length === 0 ? <EmptyState title="Belum ada referensi gaya" description="Simpan foto model potongan agar groomer dapat melihatnya langsung pada jadwal layanan."/> : <StylingReferenceGallery photos={stylingReferences} petNames={Object.fromEntries(overview.pets.map((pet)=>[pet.id,pet.name]))} customerId={customerId} canManage={Boolean(capabilities["customer.manage"])}/>}
          </div>
        ) : null}

        {tabPermitted && tab === "addresses" ? (
          <div className="space-y-4">
            {addresses.length === 0 ? (
              <EmptyState title="Belum ada alamat tersimpan" description="Tambahkan alamat agar booking home service dapat dibuat dengan lokasi yang jelas." />
            ) : (
              <div className="grid gap-3 md:grid-cols-2">
                {addresses.map((address) => (
                  <article key={address.id} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-bold text-slate-800">{address.label}{address.isDefault ? <span className="ml-2 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-bold text-emerald-700">Utama</span> : null}</p>
                        <p className="mt-1 text-xs leading-5 text-slate-500">{address.formattedLine}</p>
                        {address.recipientName || address.recipientPhone ? (
                          <p className="mt-1 text-xs text-slate-400">{[address.recipientName, address.recipientPhone].filter(Boolean).join(" · ")}</p>
                        ) : null}
                        {address.landmark ? <p className="mt-1 text-xs text-slate-400">Patokan: {address.landmark}</p> : null}
                        {address.accessNotes ? <p className="mt-1 rounded-lg bg-amber-50 p-2 text-[11px] leading-5 text-amber-900">{address.accessNotes}</p> : null}
                      </div>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                      <a href={address.mapsUrl} target="_blank" rel="noreferrer" className="rounded-lg bg-slate-100 px-2.5 py-1.5 text-[11px] font-bold text-slate-600 hover:bg-slate-200">Buka di Maps</a>
                      <CustomerAddressActions customerId={customerId} address={address} />
                    </div>
                    <details className="mt-3 rounded-lg border border-slate-100"><summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-slate-500">Ubah alamat ini</summary><div className="p-3 pt-1"><CustomerAddressForm customerId={customerId} existing={address} /></div></details>
                  </article>
                ))}
              </div>
            )}
            <details className="rounded-2xl border border-dashed border-slate-300 p-4">
              <summary className="cursor-pointer text-sm font-bold text-emerald-700">+ Tambah alamat baru</summary>
              <div className="mt-3"><CustomerAddressForm customerId={customerId} /></div>
            </details>
          </div>
        ) : null}

        {tabPermitted && tab === "bookings" ? (
          bookings.length === 0 ? (
            <EmptyState title="Belum ada booking" description="Booking yang dibuat untuk pelanggan ini akan muncul di sini." />
          ) : (
            <ul className="space-y-2">
              {bookings.map((booking) => (
                <li key={booking.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-bold text-slate-800">{formatZonedDateTime(booking.startsAt, zoneFor(booking.branchId))}</p>
                    <p className="mt-0.5 truncate text-xs text-slate-500">
                      {booking.petNames.join(", ") || "Tanpa hewan"}{booking.serviceNames.length > 0 ? ` · ${booking.serviceNames.join(", ")}` : ""}
                    </p>
                  </div>
                  <StatusBadge status={booking.status} />
                </li>
              ))}
            </ul>
          )
        ) : null}

        {tabPermitted && tab === "invoices" ? (
          invoices.length === 0 ? (
            <EmptyState title="Belum ada invoice" description="Invoice terbit akan tercatat di sini beserta pembayaran yang sudah masuk." />
          ) : (
            <ul className="space-y-2">
              {invoices.map((invoice) => {
                const outstanding = invoice.total - invoice.paidAmount;
                const zone = zoneFor(invoice.branchId);
                return (
                  <li key={invoice.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-bold text-slate-800">{invoice.invoiceNumber}</p>
                      <p className="mt-0.5 text-xs text-slate-500">
                        Terbit {formatZonedDate(invoice.issuedAt, zone)}
                        {invoice.paidAt ? ` · lunas ${formatZonedDate(invoice.paidAt, zone)}` : outstanding > 0 ? ` · sisa ${formatMoney(outstanding, invoice.currency)}` : ""}
                      </p>
                      {invoice.discountTotal > 0 ? <p className="mt-1 text-xs font-bold text-violet-700">Diskon {formatMoney(invoice.discountTotal, invoice.currency)}</p> : null}
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-sm font-bold text-slate-900">{formatMoney(invoice.total, invoice.currency)}</span>
                      <StatusBadge status={invoice.status} />
                    </div>
                    {invoice.lines.length > 0 ? (
                      <ul className="mt-3 w-full space-y-1 border-t border-slate-100 pt-3">
                        {invoice.lines.map((line) => (
                          <li key={line.id} className="flex items-center justify-between gap-3 text-xs text-slate-600">
                            <span className="truncate">{line.name} × {line.quantity}{line.discountAmount > 0 ? ` · diskon ${formatMoney(line.discountAmount, invoice.currency)}` : ""}</span>
                            <span className="font-semibold text-slate-800">{formatMoney(line.lineTotal, invoice.currency)}</span>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )
        ) : null}

        {tabPermitted && tab === "packages" ? (
          packages.length === 0 ? (
            <EmptyState title="Belum ada paket" description="Paket dan langganan pelanggan akan muncul di sini dengan saldo sesi dari ledger." />
          ) : (
            <ul className="space-y-2">
              {packages.map((item) => (
                <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-bold text-slate-800">{item.packageName}{item.petName ? ` · ${item.petName}` : ""}</p>
                    <p className="mt-0.5 text-xs text-slate-500">
                      Dibeli {formatZonedDate(item.purchasedAt, branchContext.defaultTimezone)}
                      {item.expiresAt ? ` · berlaku sampai ${formatZonedDate(item.expiresAt, branchContext.defaultTimezone)}` : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-bold text-emerald-700">{item.availableSessions}/{item.sessionsRemaining} sesi{item.reservedSessions > 0 ? ` (${item.reservedSessions} dipesan)` : ""}</span>
                    <StatusBadge status={item.status} />
                  </div>
                </li>
              ))}
            </ul>
          )
        ) : null}

        {tabPermitted && tab === "notes" ? <Customer360Notes overview={overview} /> : null}

        {tabPermitted && tab === "history" ? (
          history.length === 0 ? (
            <EmptyState title="Belum ada riwayat" description="Peristiwa pelanggan dan hewan akan tercatat di sini sebagai riwayat baca-saja." />
          ) : (
            <>
              <ol className="space-y-2">
                {history.map((event) => (
                  <li key={event.id} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <p className="text-sm font-bold text-slate-800">{event.summary ?? event.eventType}</p>
                      {/* Timeline events carry no branch, so the explicitly resolved
                          default-branch zone is used rather than the server's. */}
                      <p className="text-xs text-slate-400">{formatZonedDateTime(event.occurredAt, branchContext.defaultTimezone)}</p>
                    </div>
                    <p className="mt-1 text-[11px] font-semibold uppercase tracking-[0.1em] text-slate-300">{event.subjectType} · {event.eventType}</p>
                  </li>
                ))}
              </ol>
              <p className="mt-3 text-[11px] leading-5 text-slate-400">
                Riwayat berasal dari peristiwa timeline dan ditampilkan dalam zona waktu cabang utama. Log audit tingkat basis data belum diekspos ke aplikasi.
              </p>
            </>
          )
        ) : null}
      </div>

      <p className="mt-7 rounded-2xl border border-dashed border-slate-200 px-4 py-4 text-[11px] leading-5 text-slate-400">
        Alamat dapat dikelola langsung pada tab Alamat di atas. Data pelanggan lainnya masih baca-saja — ubah pada halaman <Link href="/customers" className="font-semibold text-emerald-700 underline">Pelanggan</Link>.
        Foto layanan dan referensi gaya disimpan privat dan hanya tersedia untuk anggota workspace aktif.
      </p>
    </WorkspaceShell>
  );
}

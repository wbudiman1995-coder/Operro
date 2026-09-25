"use client";

import { useActionState, useMemo, useState } from "react";

import { createBookingInvoiceAction, createPackageInvoiceAction } from "@/app/invoices/actions";
import { InvoiceDiscountPanel } from "@/components/invoice-discount-panel";
import type { PilotActionState } from "@/app/pilot-actions";
import type { InvoiceStudioData } from "@/lib/invoice-workspace";

const initial: PilotActionState = { error: null, success: null };
const field = "h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm outline-none focus:border-emerald-500 focus:ring-4 focus:ring-emerald-500/10";
const localDate = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const nextDate = (value: string) => { const date = new Date(`${value}T12:00:00`); date.setDate(date.getDate() + 1); return localDate(date); };

function Result({ state }: { state: PilotActionState }) {
  if (!state.error && !state.success) return null;
  return <p role="status" className={`rounded-xl px-4 py-3 text-sm font-semibold ${state.error ? "bg-rose-50 text-rose-700" : "bg-emerald-50 text-emerald-700"}`}>{state.error ?? state.success}</p>;
}

export function InvoiceStudio({ data, requestKey, defaultBookingId }: { data: InvoiceStudioData; requestKey: string; defaultBookingId?: string }) {
  const today = localDate();
  const [mode, setMode] = useState<"after_visit" | "package_sale">("after_visit");
  const [search, setSearch] = useState("");
  const [bookingId, setBookingId] = useState(data.recentBookings.some((item) => item.id === defaultBookingId) ? defaultBookingId! : data.recentBookings[0]?.id ?? "");
  const [customerId, setCustomerId] = useState(data.customers[0]?.id ?? "");
  const [packageId, setPackageId] = useState(data.packages[0]?.id ?? "");
  const [packagePetId, setPackagePetId] = useState("");
  const [packageKey, setPackageKey] = useState(requestKey);
  const [invoiceDate, setInvoiceDate] = useState(today);
  const [dueDate, setDueDate] = useState(nextDate(today));
  const [bookingState, bookingAction, bookingPending] = useActionState(createBookingInvoiceAction, initial);
  const [packageState, packageAction, packagePending] = useActionState(createPackageInvoiceAction, initial);
  const query = search.trim().toLowerCase();
  const bookings = useMemo(() => data.recentBookings.filter((item) => !query || item.searchText.includes(query)), [data.recentBookings, query]);
  const customers = useMemo(() => data.customers.filter((item) => !query || item.searchText.includes(query)), [data.customers, query]);
  const selectedBooking = data.recentBookings.find((item) => item.id === bookingId);
  const selectedCustomer = data.customers.find((item) => item.id === customerId);
  const selectedPackage = data.packages.find((item) => item.id === packageId);
  const availableGroomers = data.groomers.filter((item) => !selectedBooking || item.branchId === selectedBooking.branchId);
  const changeInvoiceDate = (value: string) => { setInvoiceDate(value); setDueDate(nextDate(value)); };

  return <div className="space-y-6">
    <div className="grid gap-3 sm:grid-cols-2" role="tablist" aria-label="Mode penagihan">
      <button type="button" role="tab" aria-selected={mode === "after_visit"} onClick={() => setMode("after_visit")} className={`rounded-2xl border p-5 text-left transition ${mode === "after_visit" ? "border-emerald-500 bg-emerald-50 ring-4 ring-emerald-500/10" : "border-slate-200 bg-white"}`}><span className="text-xs font-bold uppercase tracking-wider text-emerald-700">Sesudah kunjungan</span><strong className="mt-1 block text-lg">Grooming selesai</strong><span className="mt-1 block text-sm text-slate-500">Muat appointment hari ini atau 14 hari terakhir, termasuk semua hewan dan layanan.</span></button>
      <button type="button" role="tab" aria-selected={mode === "package_sale"} onClick={() => setMode("package_sale")} className={`rounded-2xl border p-5 text-left transition ${mode === "package_sale" ? "border-amber-500 bg-amber-50 ring-4 ring-amber-500/10" : "border-slate-200 bg-white"}`}><span className="text-xs font-bold uppercase tracking-wider text-amber-800">Paket / prepaid</span><strong className="mt-1 block text-lg">Penjualan sesi</strong><span className="mt-1 block text-sm text-slate-500">Terbitkan invoice khusus dan buat saldo sesi yang terlacak ke invoice sumber.</span></button>
    </div>
    <label className="block text-sm font-semibold text-slate-700">Cari pelanggan, kode, alamat, hewan, layanan, atau groomer<input className={`${field} mt-2`} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Contoh: Cynthia, CUS-1234, Milo, Bogor…" /></label>

    {mode === "after_visit" ? <form action={bookingAction} className="space-y-5 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
      <input type="hidden" name="bookingId" value={bookingId} />
      <div><h2 className="text-lg font-bold">Appointment yang siap ditagih</h2><p className="mt-1 text-sm text-slate-500">Appointment yang sudah memiliki invoice otomatis disembunyikan.</p></div>
      <div className="grid max-h-80 gap-3 overflow-y-auto pr-1 lg:grid-cols-2">{bookings.map((item) => <label key={item.id} className={`cursor-pointer rounded-2xl border p-4 ${bookingId === item.id ? "border-emerald-500 bg-emerald-50" : "border-slate-200"}`}><input className="sr-only" type="radio" checked={bookingId === item.id} onChange={() => setBookingId(item.id)} /><div className="flex justify-between gap-3"><strong>{item.customerName}</strong><span className="text-sm font-bold text-slate-700">Rp{item.estimatedTotal.toLocaleString("id-ID")}</span></div><p className="mt-1 text-xs text-slate-500">{new Date(item.startsAt).toLocaleString("id-ID", { dateStyle: "medium", timeStyle: "short" })}</p><p className="mt-2 text-sm">{item.petNames.join(", ") || "Tanpa hewan"} · {item.serviceNames.join(", ") || "Tanpa layanan"}</p><p className="mt-1 text-xs font-semibold text-emerald-700">Groomer: {item.groomerNames.join(", ") || "pilih di bawah"}</p></label>)}{bookings.length === 0 ? <p className="rounded-xl bg-slate-50 p-4 text-sm text-slate-500">Tidak ada appointment selesai tanpa invoice yang cocok.</p> : null}</div>
      <div className="grid gap-4 md:grid-cols-2"><label className="text-sm font-semibold">Tanggal invoice<input className={`${field} mt-1`} type="date" name="invoiceDate" value={invoiceDate} onChange={(event) => changeInvoiceDate(event.target.value)} required /></label><label className="text-sm font-semibold">Jatuh tempo<input className={`${field} mt-1`} type="date" name="dueDate" value={dueDate} min={invoiceDate} onChange={(event) => setDueDate(event.target.value)} /></label></div>
      <div className="grid gap-4 md:grid-cols-3"><label className="text-sm font-semibold">Groomer terdaftar<select className={`${field} mt-1`} name="groomerId" defaultValue=""><option value="">Deteksi dari appointment</option>{availableGroomers.map((groomer) => <option key={groomer.id} value={groomer.id}>{groomer.name}</option>)}</select></label><label className="text-sm font-semibold">Atau nama manual<input className={`${field} mt-1`} name="manualGroomer" placeholder="Vendor / groomer eksternal" /></label><label className="text-sm font-semibold">Jenis dokumen<select className={`${field} mt-1`} name="documentType" defaultValue="auto"><option value="auto">Otomatis</option><option value="invoice">Invoice</option><option value="service_report">Laporan layanan prepaid</option></select></label></div>
      <label className="block text-sm font-semibold">Catatan internal<textarea className="mt-1 min-h-24 w-full rounded-xl border border-slate-200 p-3 text-sm" name="adminNotes" placeholder="Hanya terlihat oleh tim internal" /></label>
      {selectedBooking ? <InvoiceDiscountPanel key={selectedBooking.id} bookingId={selectedBooking.id} pets={selectedBooking.pets} serviceLines={selectedBooking.serviceLines} inInvoiceForm /> : null}
      <Result state={bookingState} /><button disabled={bookingPending || !bookingId} className="h-11 rounded-xl bg-emerald-700 px-5 text-sm font-bold text-white disabled:opacity-50">{bookingPending ? "Menerbitkan…" : "Terbitkan invoice kunjungan"}</button>
    </form> : <form action={packageAction} onChange={() => setPackageKey(crypto.randomUUID())} className="space-y-5 rounded-3xl border border-amber-200 bg-amber-50/40 p-5 shadow-sm sm:p-7">
      <input type="hidden" name="requestKey" value={packageKey} />
      <div><h2 className="text-lg font-bold">Invoice paket / prepaid</h2><p className="mt-1 text-sm text-slate-500">Nomor PKG terpisah, baris invoice khusus, dan saldo sesi dibuat dalam satu transaksi.</p></div>
      <div className="grid gap-4 md:grid-cols-2"><label className="text-sm font-semibold">Pelanggan<select className={`${field} mt-1`} name="customerId" value={customerId} onChange={(event) => { setCustomerId(event.target.value); setPackagePetId(""); }} required>{customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name} · {customer.code}</option>)}</select></label><label className="text-sm font-semibold">Cabang<select className={`${field} mt-1`} name="branchId" required>{data.branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></label></div>
      {selectedCustomer ? <p className="rounded-xl bg-white p-3 text-xs text-slate-600"><strong>{selectedCustomer.petNames.join(", ") || "Belum ada hewan"}</strong>{selectedCustomer.address ? ` · ${selectedCustomer.address}` : " · alamat belum lengkap"}</p> : null}
      <label className="block text-sm font-semibold">Paket<select className={`${field} mt-1`} name="packageId" value={packageId} onChange={(event) => { setPackageId(event.target.value); setPackagePetId(""); }} required>{data.packages.map((pkg) => <option key={pkg.id} value={pkg.id}>{pkg.name} · {pkg.sessions} sesi · Rp{pkg.price.toLocaleString("id-ID")}{pkg.perPet ? " · per hewan" : ""}{pkg.recurrenceInterval !== "none" ? ` · ${pkg.recurrenceInterval}` : ""}</option>)}</select></label>
      {selectedPackage?.perPet ? <label className="block text-sm font-semibold">Hewan untuk paket ini<select className={`${field} mt-1`} name="petId" value={packagePetId} onChange={(event) => setPackagePetId(event.target.value)} required><option value="">Pilih hewan</option>{selectedCustomer?.pets.map((pet) => <option key={pet.id} value={pet.id}>{pet.name}</option>)}</select></label> : null}
      <div className="grid gap-4 md:grid-cols-2"><label className="text-sm font-semibold">Tanggal invoice<input className={`${field} mt-1`} type="date" name="invoiceDate" value={invoiceDate} onChange={(event) => changeInvoiceDate(event.target.value)} required /></label><label className="text-sm font-semibold">Jatuh tempo<input className={`${field} mt-1`} type="date" name="dueDate" value={dueDate} min={invoiceDate} onChange={(event) => setDueDate(event.target.value)} /></label></div>
      <label className="block text-sm font-semibold">Catatan internal<textarea className="mt-1 min-h-24 w-full rounded-xl border border-slate-200 p-3 text-sm" name="adminNotes" /></label>
      <Result state={packageState} /><button disabled={packagePending || !customerId || data.packages.length === 0 || data.branches.length === 0 || (selectedPackage?.perPet && !packagePetId)} className="h-11 rounded-xl bg-amber-800 px-5 text-sm font-bold text-white disabled:opacity-50">{packagePending ? "Menerbitkan…" : "Terbitkan invoice paket"}</button>
    </form>}
  </div>;
}

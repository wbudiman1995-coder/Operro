"use client";

/**
 * Function index:
 * - CustomerForm, TaskForm, ServiceForm, PackageForm, ResourceForm, InventoryForm, PaymentForm, ExpenseForm: interactive pilot forms.
 * - ActionMessage: consistent success and error feedback.
 */
import { useActionState, useState } from "react";

import {
  adjustInventoryAction,
  createCustomerAction,
  createPackageAction,
  createResourceAction,
  createServiceAction,
  createTaskAction,
  recordExpenseAction,
  recordPaymentAction,
} from "@/app/pilot-actions";
import type { PilotActionState } from "@/app/pilot-actions";
import { MapsCoordinateFields } from "@/components/customer-address-forms";
import { IndonesiaRegionFields } from "@/components/indonesia-region-fields";

const initialPilotActionState: PilotActionState = { error: null, success: null };

const inputClass = "h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm outline-none transition focus:border-emerald-500 focus:ring-4 focus:ring-emerald-500/10";
const buttonClass = "inline-flex h-11 items-center justify-center rounded-xl bg-emerald-700 px-5 text-sm font-bold text-white transition hover:bg-emerald-800 disabled:cursor-wait disabled:opacity-60";

function ActionMessage({ state }: { state: PilotActionState }) {
  if (!state.error && !state.success) return null;
  return <p className={`rounded-xl px-3 py-2 text-xs font-semibold ${state.error ? "bg-rose-50 text-rose-700" : "bg-emerald-50 text-emerald-700"}`}>{state.error ?? state.success}</p>;
}

export function CustomerForm() {
  const [state, action, pending] = useActionState(createCustomerAction, initialPilotActionState);
  type PetDraft = { id: number; name: string; species: "dog" | "cat"; breed: string; size: string; weightKg: string; color: string; age: string; notes: string };
  const [pets, setPets] = useState<PetDraft[]>([{ id: 0, name: "", species: "dog", breed: "", size: "", weightKg: "", color: "", age: "", notes: "" }]);
  const patchPet = (id: number, key: keyof PetDraft, value: string) => setPets(current => current.map(pet => pet.id === id ? { ...pet, [key]: value } : pet));
  return <form action={action} className="space-y-3"><div className="grid gap-3 sm:grid-cols-2"><input className={inputClass} name="name" placeholder="Nama pelanggan" required /><input className={inputClass} name="phone" placeholder="WhatsApp, contoh 0812..." /></div>
    <input type="hidden" name="petsJson" value={JSON.stringify(pets.map((pet) => ({ name: pet.name, species: pet.species, breed: pet.breed, size: pet.size, weightKg: pet.weightKg, color: pet.color, age: pet.age, notes: pet.notes })))} />
    <div className="space-y-3"><p className="text-sm font-semibold text-slate-700">Pet pelanggan</p>{pets.map((pet, index) => <section key={pet.id} className="space-y-3 rounded-xl border border-slate-200 p-3">
      <div className="flex items-center justify-between"><strong className="text-xs">Pet {index + 1}</strong>{pets.length > 1 ? <button type="button" onClick={() => setPets(current => current.filter(item => item.id !== pet.id))} className="text-xs font-bold text-rose-700">Hapus</button> : null}</div>
      <div className="grid gap-3 sm:grid-cols-4"><input className={inputClass} value={pet.name} onChange={event => patchPet(pet.id, "name", event.target.value)} placeholder="Nama pet" aria-label={`Nama pet ${index + 1}`} required /><select className={inputClass} value={pet.species} onChange={event => patchPet(pet.id, "species", event.target.value)} aria-label={`Jenis pet ${index + 1}`}><option value="dog">Anjing</option><option value="cat">Kucing</option></select><input className={inputClass} value={pet.breed} onChange={event => patchPet(pet.id, "breed", event.target.value)} placeholder="Ras" aria-label={`Ras pet ${index + 1}`} /><select className={inputClass} value={pet.size} onChange={event => patchPet(pet.id, "size", event.target.value)} aria-label={`Ukuran pet ${index + 1}`}><option value="">Ukuran (opsional)</option><option value="small">Kecil</option><option value="medium">Sedang</option><option value="large">Besar</option><option value="extra_large">Extra besar</option></select></div>
      <div className="grid gap-3 sm:grid-cols-3"><input className={inputClass} value={pet.weightKg} onChange={event => patchPet(pet.id, "weightKg", event.target.value)} placeholder="Berat kg" aria-label={`Berat pet ${index + 1}`} inputMode="decimal" /><input className={inputClass} value={pet.color} onChange={event => patchPet(pet.id, "color", event.target.value)} placeholder="Warna bulu" aria-label={`Warna pet ${index + 1}`} /><input className={inputClass} value={pet.age} onChange={event => patchPet(pet.id, "age", event.target.value)} placeholder="Umur" aria-label={`Umur pet ${index + 1}`} /></div>
      <textarea className={`${inputClass} h-auto py-2`} value={pet.notes} onChange={event => patchPet(pet.id, "notes", event.target.value)} placeholder="Catatan pet untuk groomer" aria-label={`Catatan pet ${index + 1}`} rows={2} />
    </section>)}{pets.length < 5 ? <button type="button" onClick={() => setPets(current => [...current, { id: Math.max(...current.map(pet => pet.id)) + 1, name: "", species: "dog", breed: "", size: "", weightKg: "", color: "", age: "", notes: "" }])} className="w-full rounded-xl border-2 border-dashed border-emerald-300 py-3 text-sm font-bold text-emerald-700">+ Tambah pet</button> : null}</div>
    <details className="rounded-xl border border-slate-200 p-3">
      <summary className="cursor-pointer text-sm font-semibold text-slate-700">Alamat (opsional, untuk layanan home service)</summary>
      <div className="mt-3 space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <input className={inputClass} name="label" placeholder="Label, contoh Rumah / Kantor" />
          <input className={inputClass} name="recipientPhone" placeholder="No. WhatsApp penerima di lokasi" />
        </div>
        <input className={inputClass} name="line1" placeholder="Nama jalan dan nomor rumah" />
        <div className="grid gap-3 sm:grid-cols-2"><input className={inputClass} name="line2" placeholder="Detail tambahan (blok, unit)" /><input className={inputClass} name="landmark" placeholder="Patokan (contoh: sebelah minimarket)" /></div>
        <div className="grid gap-3 sm:grid-cols-3">
          <input className={inputClass} name="rt" placeholder="RT" />
          <input className={inputClass} name="rw" placeholder="RW" />
          <input className={inputClass} name="kelurahan" placeholder="Kelurahan/Desa" />
        </div>
        <IndonesiaRegionFields className={inputClass} />
        <input className={inputClass} name="postalCode" placeholder="Kode pos" />
        <textarea className={`${inputClass} h-auto py-2`} name="accessNotes" placeholder="Catatan akses (pagar, parkir, keamanan)" rows={2} />
        <MapsCoordinateFields />
      </div>
    </details>
    <div className="flex flex-wrap items-center justify-between gap-3"><ActionMessage state={state} /><button className={buttonClass} disabled={pending}>{pending ? "Menyimpan..." : "Tambah pelanggan"}</button></div></form>;
}

export function TaskForm({ branches }: { branches: Array<{ id: string; name: string }> }) {
  const [state, action, pending] = useActionState(createTaskAction, initialPilotActionState);
  return <form action={action} className="space-y-3"><input className={inputClass} name="title" placeholder="Contoh: follow-up booking Bubu" required /><div className="grid gap-3 sm:grid-cols-3"><select className={inputClass} name="branchId" required>{branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select><select className={inputClass} name="priority" defaultValue="normal"><option value="low">Rendah</option><option value="normal">Normal</option><option value="high">Tinggi</option><option value="urgent">Mendesak</option></select><input className={inputClass} type="datetime-local" name="dueAt" /></div><div className="flex flex-wrap items-center justify-between gap-3"><ActionMessage state={state} /><button className={buttonClass} disabled={pending}>{pending ? "Menyimpan..." : "Buat tugas"}</button></div></form>;
}

const SERVICE_SIZE_FIELDS = [
  ["small", "Kecil"],
  ["medium", "Sedang"],
  ["large", "Besar"],
  ["extraLarge", "Extra besar"],
] as const;

export function ServiceForm() {
  const [state, action, pending] = useActionState(createServiceAction, initialPilotActionState);
  const [zeroTime, setZeroTime] = useState(false);
  const [duration, setDuration] = useState("60");
  return <form action={action} className="space-y-3">
    <input className={inputClass} name="name" placeholder="Nama layanan" required />
    <select className={inputClass} name="category" defaultValue="" aria-label="Kategori layanan">
      <option value="">Kategori (opsional)</option><option value="Basic Grooming">Basic Grooming</option><option value="Styling">Styling</option><option value="Special Charges">Special Charges</option><option value="Other Fees">Other Fees</option>
    </select>
    <div className="grid gap-3 sm:grid-cols-2">
      <input className={inputClass} type="number" min="15" step="5" name="duration" value={duration} onChange={(event) => setDuration(event.target.value)} disabled={zeroTime} aria-label="Durasi menit" />
      <input className={inputClass} type="number" min="0" step="1000" name="price" placeholder="Harga dasar Rp" required />
    </div>
    <label className="flex items-center gap-2 text-xs font-semibold text-slate-700"><input type="checkbox" name="zeroTimeAddon" checked={zeroTime} onChange={(event) => setZeroTime(event.target.checked)} />Layanan tambahan: berbayar, tidak menambah waktu booking (contoh: mandi kutu/jamur)</label>
    <input className={inputClass} type="number" min="0" step="5" name="additionalDuration" disabled={zeroTime} placeholder="Menit tambahan per unit ekstra (opsional)" />
    <div>
      <p className="mb-2 text-xs font-semibold text-slate-500">Harga per ukuran hewan (opsional, kosongkan untuk pakai harga dasar)</p>
      <div className="grid gap-3 sm:grid-cols-4">
        {SERVICE_SIZE_FIELDS.map(([size, label]) => <input key={size} className={inputClass} type="number" min="0" step="1000" name={`price_${size}`} placeholder={label} aria-label={`Harga ${label}`} />)}
      </div>
    </div>
    <div className="flex flex-wrap gap-4 text-xs font-semibold text-slate-700">
      <label className="flex items-center gap-2"><input type="checkbox" name="fulfillmentModes" value="home" defaultChecked />Home service</label>
      <label className="flex items-center gap-2"><input type="checkbox" name="fulfillmentModes" value="in_store" defaultChecked />Di toko</label>
    </div>
    <ActionMessage state={state} />
    <button className={buttonClass} disabled={pending}>{pending ? "Menyimpan..." : "Tambah layanan"}</button>
  </form>;
}

/** Section 24: package/membership catalog terms. Governs future sales only -- see createPackageAction. */
export function PackageForm({ services }: { services: Array<{ id: string; name: string }> }) {
  const [state, action, pending] = useActionState(createPackageAction, initialPilotActionState);
  return <form action={action} className="space-y-3">
    <input className={inputClass} name="name" placeholder="Nama paket" required />
    <input className={inputClass} name="description" placeholder="Deskripsi (opsional)" />
    <div className="grid gap-3 sm:grid-cols-2">
      <input className={inputClass} type="number" min="1" step="1" name="sessions" placeholder="Jumlah sesi" required />
      <input className={inputClass} type="number" min="0" step="1000" name="price" placeholder="Harga Rp" required />
    </div>
    <select className={inputClass} name="serviceId" defaultValue="" aria-label="Berlaku untuk layanan">
      <option value="">Berlaku untuk semua layanan</option>
      {services.map((service) => <option key={service.id} value={service.id}>{service.name}</option>)}
    </select>
    <div className="grid gap-3 sm:grid-cols-3">
      <input className={inputClass} type="number" min="1" step="1" name="validityDays" placeholder="Masa berlaku (hari, opsional)" />
      <select className={inputClass} name="recurrenceInterval" defaultValue="none" aria-label="Interval perpanjangan">
        <option value="none">Sekali beli (tidak berulang)</option><option value="week">Mingguan</option><option value="month">Bulanan</option><option value="year">Tahunan</option>
      </select>
      <select className={inputClass} name="rolloverPolicy" defaultValue="none" aria-label="Kebijakan rollover">
        <option value="none">Sesi tidak digabung</option><option value="rollover">Sesi bisa digabung (rollover)</option>
      </select>
    </div>
    <label className="flex items-center gap-2 text-xs font-semibold text-slate-700"><input type="checkbox" name="perPet" />Khusus satu hewan per pembelian (bukan berbagi antar hewan pelanggan)</label>
    <ActionMessage state={state} />
    <button className={buttonClass} disabled={pending}>{pending ? "Menyimpan..." : "Tambah paket"}</button>
  </form>;
}

export function ResourceForm({ branches, memberships }: { branches: Array<{ id: string; name: string }>; memberships: Array<{ id: string; name: string }> }) {
  const [state, action, pending] = useActionState(createResourceAction, initialPilotActionState);
  return <form action={action} className="space-y-3"><input className={inputClass} name="name" placeholder="Nama groomer" required /><div className="grid gap-3 sm:grid-cols-2"><input className={inputClass} name="phone" placeholder="Telepon / WhatsApp" /><input className={`${inputClass} p-1`} type="color" name="color" defaultValue="#0f766e" aria-label="Warna kalender" /></div><select className={inputClass} name="branchId" required>{branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select><select className={inputClass} name="membershipId" defaultValue=""><option value="">Tanpa akun staf</option>{memberships.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><input className={inputClass} name="baseLabel" placeholder="Alamat / titik keberangkatan groomer" /><MapsCoordinateFields /><ActionMessage state={state} /><button className={buttonClass} disabled={pending}>{pending ? "Menyimpan..." : "Tambah groomer"}</button></form>;
}

export function InventoryForm({ branches, products }: { branches: Array<{ id: string; name: string }>; products: Array<{ id: string; name: string }> }) {
  const [state, action, pending] = useActionState(adjustInventoryAction, initialPilotActionState);
  return <form action={action} className="space-y-3"><div className="grid gap-3 sm:grid-cols-3"><select className={inputClass} name="branchId" required>{branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select><select className={inputClass} name="productId" required>{products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}</select><input className={inputClass} name="quantity" type="number" step="0.001" placeholder="+ masuk / - keluar" required /></div><input className={inputClass} name="notes" placeholder="Catatan penyesuaian" /><div className="flex flex-wrap items-center justify-between gap-3"><ActionMessage state={state} /><button className={buttonClass} disabled={pending}>{pending ? "Menyimpan..." : "Simpan penyesuaian"}</button></div></form>;
}

export function PaymentForm({ invoices }: { invoices: Array<{ id: string; number: string; total: number }> }) {
  const [state, action, pending] = useActionState(recordPaymentAction, initialPilotActionState);
  // Generated once per form mount and resubmitted unchanged on retry — this is
  // what makes app.record_payment's request_key idempotency actually work. A
  // fresh key on every submit would defeat it (see recordPaymentAction). Only
  // regenerated after an ACKNOWLEDGED success, so a second, intentional
  // payment on the same invoice gets its own identity while an ambiguous
  // failed attempt keeps retrying under the same one.
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID());
  const [method, setMethod] = useState("bank_transfer");
  // Adjusting state during render (React-recommended in place of an effect):
  // regenerate the request key the moment an acknowledged success is seen,
  // before this render commits, so a second submit never reuses the key of
  // the payment that just succeeded.
  const [ackedSuccess, setAckedSuccess] = useState(state.success);
  if (state.success !== ackedSuccess) {
    setAckedSuccess(state.success);
    if (state.success) setRequestKey(crypto.randomUUID());
  }
  return <form action={action} className="space-y-3" key={requestKey}>
    <input type="hidden" name="requestKey" value={requestKey} />
    <select className={inputClass} name="invoiceId" required>{invoices.map((invoice) => <option key={invoice.id} value={invoice.id}>{invoice.number} · Rp{invoice.total.toLocaleString("id-ID")}</option>)}</select>
    <div className="grid grid-cols-2 gap-3">
      <select className={inputClass} name="method" value={method} onChange={(event) => setMethod(event.target.value)}><option value="cash">Tunai</option><option value="bank_transfer">Transfer</option><option value="card">Kartu</option><option value="wallet">Wallet</option><option value="other">Lainnya</option></select>
      <input className={inputClass} type="number" min="1" step="1" name="amount" placeholder="Jumlah Rp" required />
    </div>
    {method === "bank_transfer" ? <div className="space-y-1"><label className="text-xs font-semibold text-slate-600">Bukti transfer (wajib)</label><input className={inputClass} type="file" name="proof" accept="image/jpeg,image/png,image/webp" required /></div> : null}
    <ActionMessage state={state} /><button className={buttonClass} disabled={pending || invoices.length === 0}>{pending ? "Menyimpan..." : "Catat pembayaran"}</button>
  </form>;
}

export function ExpenseForm({ branches }: { branches: Array<{ id: string; name: string }> }) {
  const [state, action, pending] = useActionState(recordExpenseAction, initialPilotActionState);
  return <form action={action} className="space-y-3"><input className={inputClass} name="description" placeholder="Deskripsi pengeluaran" required /><div className="grid gap-3 sm:grid-cols-3"><select className={inputClass} name="branchId" required>{branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select><input className={inputClass} name="category" placeholder="Kategori" /><input className={inputClass} type="number" min="1" step="1000" name="amount" placeholder="Jumlah Rp" required /></div><ActionMessage state={state} /><button className={buttonClass} disabled={pending}>{pending ? "Menyimpan..." : "Catat pengeluaran"}</button></form>;
}

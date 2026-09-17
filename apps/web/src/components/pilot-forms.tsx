"use client";

/**
 * Function index:
 * - CustomerForm, TaskForm, ServiceForm, ResourceForm, InventoryForm, PaymentForm, ExpenseForm: interactive pilot forms.
 * - PackageSaleForm: sells a catalog package to a customer.
 * - ActionMessage: consistent success and error feedback.
 */
import { useActionState } from "react";

import {
  adjustInventoryAction,
  createCustomerAction,
  createResourceAction,
  createServiceAction,
  createTaskAction,
  recordExpenseAction,
  recordPaymentAction,
  sellPackageAction,
} from "@/app/pilot-actions";
import type { PilotActionState } from "@/app/pilot-actions";

const initialPilotActionState: PilotActionState = { error: null, success: null };

const inputClass = "h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm outline-none transition focus:border-emerald-500 focus:ring-4 focus:ring-emerald-500/10";
const buttonClass = "inline-flex h-11 items-center justify-center rounded-xl bg-emerald-700 px-5 text-sm font-bold text-white transition hover:bg-emerald-800 disabled:cursor-wait disabled:opacity-60";

function ActionMessage({ state }: { state: PilotActionState }) {
  if (!state.error && !state.success) return null;
  return <p className={`rounded-xl px-3 py-2 text-xs font-semibold ${state.error ? "bg-rose-50 text-rose-700" : "bg-emerald-50 text-emerald-700"}`}>{state.error ?? state.success}</p>;
}

export function CustomerForm() {
  const [state, action, pending] = useActionState(createCustomerAction, initialPilotActionState);
  return <form action={action} className="space-y-3"><div className="grid gap-3 sm:grid-cols-2"><input className={inputClass} name="name" placeholder="Nama pelanggan" required /><input className={inputClass} name="phone" placeholder="WhatsApp, contoh 0812..." /></div><div className="grid gap-3 sm:grid-cols-3"><input className={inputClass} name="petName" placeholder="Nama hewan" /><select className={inputClass} name="species" defaultValue="dog"><option value="dog">Anjing</option><option value="cat">Kucing</option><option value="rabbit">Kelinci</option></select><input className={inputClass} name="breed" placeholder="Ras" /></div><div className="flex flex-wrap items-center justify-between gap-3"><ActionMessage state={state} /><button className={buttonClass} disabled={pending}>{pending ? "Menyimpan..." : "Tambah pelanggan"}</button></div></form>;
}

export function TaskForm({ branches }: { branches: Array<{ id: string; name: string }> }) {
  const [state, action, pending] = useActionState(createTaskAction, initialPilotActionState);
  return <form action={action} className="space-y-3"><input className={inputClass} name="title" placeholder="Contoh: follow-up booking Bubu" required /><div className="grid gap-3 sm:grid-cols-3"><select className={inputClass} name="branchId" required>{branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select><select className={inputClass} name="priority" defaultValue="normal"><option value="low">Rendah</option><option value="normal">Normal</option><option value="high">Tinggi</option><option value="urgent">Mendesak</option></select><input className={inputClass} type="datetime-local" name="dueAt" /></div><div className="flex flex-wrap items-center justify-between gap-3"><ActionMessage state={state} /><button className={buttonClass} disabled={pending}>{pending ? "Menyimpan..." : "Buat tugas"}</button></div></form>;
}

export function ServiceForm() {
  const [state, action, pending] = useActionState(createServiceAction, initialPilotActionState);
  return <form action={action} className="space-y-3"><input className={inputClass} name="name" placeholder="Nama layanan" required /><div className="grid grid-cols-2 gap-3"><input className={inputClass} type="number" min="15" step="15" name="duration" defaultValue="60" aria-label="Durasi menit" /><input className={inputClass} type="number" min="0" step="1000" name="price" placeholder="Harga Rp" required /></div><ActionMessage state={state} /><button className={buttonClass} disabled={pending}>{pending ? "Menyimpan..." : "Tambah layanan"}</button></form>;
}

export function ResourceForm({ branches }: { branches: Array<{ id: string; name: string }> }) {
  const [state, action, pending] = useActionState(createResourceAction, initialPilotActionState);
  return <form action={action} className="space-y-3"><input className={inputClass} name="name" placeholder="Nama groomer" required /><select className={inputClass} name="branchId" required>{branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select><ActionMessage state={state} /><button className={buttonClass} disabled={pending}>{pending ? "Menyimpan..." : "Tambah groomer"}</button></form>;
}

export function InventoryForm({ branches, products }: { branches: Array<{ id: string; name: string }>; products: Array<{ id: string; name: string }> }) {
  const [state, action, pending] = useActionState(adjustInventoryAction, initialPilotActionState);
  return <form action={action} className="space-y-3"><div className="grid gap-3 sm:grid-cols-3"><select className={inputClass} name="branchId" required>{branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select><select className={inputClass} name="productId" required>{products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}</select><input className={inputClass} name="quantity" type="number" step="0.001" placeholder="+ masuk / - keluar" required /></div><input className={inputClass} name="notes" placeholder="Catatan penyesuaian" /><div className="flex flex-wrap items-center justify-between gap-3"><ActionMessage state={state} /><button className={buttonClass} disabled={pending}>{pending ? "Menyimpan..." : "Simpan penyesuaian"}</button></div></form>;
}

export function PaymentForm({ invoices }: { invoices: Array<{ id: string; number: string; total: number }> }) {
  const [state, action, pending] = useActionState(recordPaymentAction, initialPilotActionState);
  return <form action={action} className="space-y-3"><select className={inputClass} name="invoiceId" required>{invoices.map((invoice) => <option key={invoice.id} value={invoice.id}>{invoice.number} · Rp{invoice.total.toLocaleString("id-ID")}</option>)}</select><div className="grid grid-cols-2 gap-3"><select className={inputClass} name="method" defaultValue="bank_transfer"><option value="cash">Tunai</option><option value="bank_transfer">Transfer</option><option value="card">Kartu</option><option value="wallet">Wallet</option><option value="other">Lainnya</option></select><input className={inputClass} type="number" min="1" step="1000" name="amount" placeholder="Jumlah Rp" required /></div><ActionMessage state={state} /><button className={buttonClass} disabled={pending || invoices.length === 0}>{pending ? "Menyimpan..." : "Catat pembayaran"}</button></form>;
}

export function PackageSaleForm({ customers, packages, branches }: { customers: Array<{ id: string; name: string }>; packages: Array<{ id: string; name: string; sessions: number; price: number }>; branches: Array<{ id: string; name: string }> }) {
  const [state, action, pending] = useActionState(sellPackageAction, initialPilotActionState);
  return <form action={action} className="space-y-3"><select className={inputClass} name="customerId" required><option value="">Pilih pelanggan</option>{customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name}</option>)}</select><select className={inputClass} name="packageId" required><option value="">Pilih paket</option>{packages.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.sessions} sesi · Rp{item.price.toLocaleString("id-ID")}</option>)}</select><div className="grid grid-cols-2 gap-3"><select className={inputClass} name="branchId" required>{branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select><select className={inputClass} name="method" defaultValue="cash"><option value="cash">Tunai</option><option value="bank_transfer">Transfer</option><option value="card">Kartu</option><option value="wallet">Wallet</option><option value="other">Lainnya</option></select></div><ActionMessage state={state} /><button className={buttonClass} disabled={pending || customers.length === 0 || packages.length === 0}>{pending ? "Menyimpan..." : "Jual paket"}</button></form>;
}

export function ExpenseForm({ branches }: { branches: Array<{ id: string; name: string }> }) {
  const [state, action, pending] = useActionState(recordExpenseAction, initialPilotActionState);
  return <form action={action} className="space-y-3"><input className={inputClass} name="description" placeholder="Deskripsi pengeluaran" required /><div className="grid gap-3 sm:grid-cols-3"><select className={inputClass} name="branchId" required>{branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select><input className={inputClass} name="category" placeholder="Kategori" /><input className={inputClass} type="number" min="1" step="1000" name="amount" placeholder="Jumlah Rp" required /></div><ActionMessage state={state} /><button className={buttonClass} disabled={pending}>{pending ? "Menyimpan..." : "Catat pengeluaran"}</button></form>;
}

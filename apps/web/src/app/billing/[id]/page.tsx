import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { OperroMark } from "@/components/operro-mark";
import { loadOperroInvoice, rupiah } from "@/lib/platform-invoice";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Invoice Operro" };

export default async function OperroInvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) redirect("/login");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const invoice = await loadOperroInvoice(supabase, id).catch(() => null);
  if (!invoice) notFound();
  return <main className="min-h-screen bg-slate-50 p-5 text-slate-900 sm:p-8"><div className="mx-auto max-w-3xl"><div className="mb-5 flex flex-wrap items-center justify-between gap-3 print:hidden"><Link href="/billing" className="text-sm font-bold text-emerald-800 underline">← Semua tagihan</Link><a href={`/billing/${id}/pdf`} className="rounded-lg bg-emerald-700 px-4 py-2 text-xs font-bold text-white">Unduh PDF</a></div><article className="rounded-3xl border bg-white p-6 shadow-sm sm:p-10 print:border-0 print:shadow-none"><div className="flex flex-wrap items-start justify-between gap-5 border-b pb-7"><div><OperroMark /><p className="mt-2 text-xs text-slate-500">Tagihan langganan platform Operro</p></div><div className="text-right"><h1 className="text-2xl font-bold">INVOICE</h1><p className="mt-1 font-mono text-sm">{invoice.invoice_number}</p></div></div><div className="mt-7 grid gap-6 text-sm sm:grid-cols-2"><div><p className="text-xs font-bold uppercase tracking-wide text-slate-500">Ditagih kepada</p><p className="mt-2 font-bold">{invoice.organization_name}</p><p className="text-slate-600">{invoice.recipient_email ?? "Pemilik bisnis"}</p></div><div className="sm:text-right"><p>Diterbitkan: {new Date(invoice.issued_at).toLocaleDateString("id-ID")}</p><p>Periode: {new Date(`${invoice.period_month}T00:00:00`).toLocaleDateString("id-ID", { month: "long", year: "numeric" })}</p><p>Jatuh tempo: {invoice.due_date}</p><p className="mt-1 font-bold">Status: {invoice.status === "paid" ? "Lunas" : invoice.status === "overdue" ? "Terlambat" : "Menunggu pembayaran"}</p></div></div><div className="mt-8 overflow-hidden rounded-xl border"><div className="grid grid-cols-[1fr_auto] bg-slate-100 p-3 text-xs font-bold"><span>Rincian</span><span>Jumlah</span></div><div className="grid grid-cols-[1fr_auto] gap-3 p-4 text-sm"><span>{invoice.description}</span><span className="font-bold">{rupiah(invoice.amount_idr)}</span></div></div><div className="mt-6 flex justify-end"><div className="w-full max-w-64 border-t pt-3 text-right"><p className="text-xs text-slate-500">Total tagihan</p><p className="mt-1 text-2xl font-bold">{rupiah(invoice.amount_idr)}</p></div></div><p className="mt-12 border-t pt-5 text-xs leading-5 text-slate-500">Pembayaran dicatat dan dikonfirmasi manual oleh Operro. Hubungi Operro untuk petunjuk pembayaran. Invoice ini adalah tagihan platform dan tidak termasuk pendapatan grooming bisnis Anda.</p></article></div></main>;
}

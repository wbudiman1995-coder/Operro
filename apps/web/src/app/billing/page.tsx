import Link from "next/link";
import { redirect } from "next/navigation";
import { OperroMark } from "@/components/operro-mark";
import type { OperroInvoice } from "@/lib/platform-invoice";
import { rupiah } from "@/lib/platform-invoice";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Tagihan Operro" };

export default async function BillingPage() {
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) redirect("/login");
  const result = await supabase.schema("app").rpc("list_my_operro_invoices");
  const invoices = (result.data ?? []) as OperroInvoice[];
  return <main className="min-h-screen bg-slate-50 p-5 text-slate-900 sm:p-8"><div className="mx-auto max-w-4xl"><header className="flex items-center justify-between gap-3"><OperroMark /><Link href="/organizations" className="text-sm font-bold text-emerald-800 underline">Workspace</Link></header><h1 className="mt-10 text-3xl font-bold">Tagihan dari Operro</h1><p className="mt-2 text-sm text-slate-600">Invoice langganan untuk bisnis Anda. Tetap dapat dibuka saat workspace ditangguhkan karena pembayaran.</p>{result.error ? <p className="mt-5 rounded-lg bg-rose-50 p-4 text-sm text-rose-800">Tagihan tidak dapat dimuat. Coba masuk ulang.</p> : <div className="mt-6 space-y-3">{invoices.length ? invoices.map((invoice) => <Link key={invoice.id} href={`/billing/${invoice.id}`} className="block rounded-2xl border bg-white p-5 hover:border-emerald-500"><div className="flex flex-wrap justify-between gap-2"><div><p className="font-bold">{invoice.invoice_number}</p><p className="mt-1 text-xs text-slate-500">{invoice.organization_name} · {invoice.description}</p></div><p className="font-bold">{rupiah(invoice.amount_idr)}</p></div><p className="mt-3 text-xs">Jatuh tempo {invoice.due_date} · {invoice.status}</p></Link>) : <p className="rounded-2xl border bg-white p-5 text-sm text-slate-600">Belum ada invoice Operro untuk akun ini.</p>}</div>}</div></main>;
}

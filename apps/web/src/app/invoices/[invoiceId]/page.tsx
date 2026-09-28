/**
 * Section 27 — printable/downloadable invoice document. A branded,
 * customer-facing view reusing the SAME persisted snapshot every other
 * screen (finance, Customer 360) already trusts (invoice_lines,
 * groomer_name_snapshot) - never recomputed from today's catalog.
 */
import Link from "next/link";
import { notFound } from "next/navigation";

import { InvoiceCustomerNotesEditor } from "@/components/invoice-customer-notes-editor";
import { PrintDownloadButton, WhatsAppHandoffButton } from "@/components/invoice-document-actions";
import { formatRupiah } from "@/lib/pilot-data";
import { loadInvoiceDocument } from "@/lib/invoice-document";
import { requireActiveWorkspace } from "@/lib/require-workspace";

export const metadata = { title: "Invoice" };

export default async function InvoiceDocumentPage({ params }: { params: Promise<{ invoiceId: string }> }) {
  const { invoiceId } = await params;
  const workspace = await requireActiveWorkspace();
  const doc = await loadInvoiceDocument(workspace.supabase, workspace.activeOrganization.id, invoiceId);
  if (!doc) notFound();

  const isServiceReport = doc.documentType === "service_report";
  const isPackageSale = doc.billingMode === "package_sale";
  const showPaymentInstructions = doc.balanceDue > 0 && !isServiceReport && doc.bankAccounts.length > 0;
  const waLabel = doc.balanceDue <= 0 ? "WhatsApp: konfirmasi lunas" : isPackageSale ? "WhatsApp: tagihan langganan" : "WhatsApp: invoice belum lunas";
  const waTemplate = doc.balanceDue <= 0 ? doc.organization.waTemplates.paidCompletion : isPackageSale ? doc.organization.waTemplates.subscriptionBilling : doc.organization.waTemplates.outstanding;

  return <div className="mx-auto max-w-3xl px-4 py-8 print:max-w-full print:px-0 print:py-0">
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3 print:hidden">
      <Link href="/finance" className="text-sm font-semibold text-slate-500">&larr; Kembali ke Keuangan</Link>
      <div className="flex flex-wrap items-center gap-2">
        <WhatsAppHandoffButton phone={doc.customer.phone} template={waTemplate} invoiceNumber={doc.invoiceNumber} customerName={doc.customer.name} total={doc.balanceDue <= 0 ? doc.total : doc.balanceDue} currency={doc.currency} notes={doc.customerNotes ?? ""} label={waLabel} />
        <PrintDownloadButton invoiceNumber={doc.invoiceNumber} customerName={doc.customer.name} />
      </div>
    </div>

    <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm print:rounded-none print:border-none print:shadow-none sm:p-10">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 pb-6">
        <div className="flex items-start gap-3">
          {doc.organization.logoUrl ?
            // eslint-disable-next-line @next/next/no-img-element -- print layout needs a plain <img>, not next/image's runtime optimization
            <img src={doc.organization.logoUrl} alt={doc.organization.name} className="h-12 w-12 shrink-0 rounded-lg object-contain" />
          : null}
          <div>
            <h1 className="text-xl font-bold">{doc.organization.name}</h1>
            {doc.organization.tagline ? <p className="mt-1 text-sm text-slate-500">{doc.organization.tagline}</p> : null}
          </div>
        </div>
        <div className="text-right">
          <p className="text-lg font-bold">{isServiceReport ? "Laporan Layanan" : "Invoice"} {doc.invoiceNumber}</p>
          <p className="text-xs text-slate-500">Terbit {new Date(doc.issuedAt).toLocaleDateString("id-ID")}{doc.dueAt ? ` · Jatuh tempo ${new Date(doc.dueAt).toLocaleDateString("id-ID")}` : ""}</p>
          <p className="mt-1 text-xs font-bold uppercase text-emerald-700">{doc.status === "paid" ? "Lunas" : doc.status === "void" ? "Dibatalkan" : "Terbit"}</p>
        </div>
      </header>

      <section className="mt-6 grid gap-4 sm:grid-cols-2">
        <div>
          <p className="text-xs font-bold uppercase text-slate-400">Kepada</p>
          <p className="mt-1 font-bold">{doc.customer.name}</p>
          {doc.customer.phone ? <p className="text-sm text-slate-600">{doc.customer.phone}</p> : null}
          {doc.customer.address ? <p className="text-sm text-slate-600">{doc.customer.address}</p> : null}
          {doc.pets.length ? <p className="mt-1 text-sm text-slate-600">Hewan: {doc.pets.join(", ")}</p> : null}
        </div>
        {doc.groomerName ? <div><p className="text-xs font-bold uppercase text-slate-400">Groomer</p><p className="mt-1 font-bold">{doc.groomerName}</p></div> : null}
      </section>

      <section className="mt-6">
        <table className="w-full text-sm">
          <thead><tr className="border-b border-slate-200 text-left text-xs font-bold uppercase text-slate-400"><th className="py-2">Item</th><th className="py-2 text-right">Qty</th><th className="py-2 text-right">Harga</th><th className="py-2 text-right">Diskon</th><th className="py-2 text-right">Total</th></tr></thead>
          <tbody>{doc.lines.map((line) => <tr key={line.id} className="border-b border-slate-100"><td className="py-2">{line.name}</td><td className="py-2 text-right">{line.quantity}</td><td className="py-2 text-right">{formatRupiah(line.unitPrice)}</td><td className="py-2 text-right text-rose-600">{line.discountAmount > 0 ? `-${formatRupiah(line.discountAmount)}` : "-"}</td><td className="py-2 text-right font-semibold">{formatRupiah(line.lineTotal)}</td></tr>)}</tbody>
        </table>
        <div className="mt-4 ml-auto max-w-xs space-y-1 text-sm">
          <div className="flex justify-between"><span className="text-slate-500">Subtotal</span><span>{formatRupiah(doc.subtotal)}</span></div>
          {doc.discountTotal > 0 ? <div className="flex justify-between text-rose-600"><span>Diskon</span><span>-{formatRupiah(doc.discountTotal)}</span></div> : null}
          {doc.taxTotal > 0 ? <div className="flex justify-between"><span className="text-slate-500">Pajak</span><span>{formatRupiah(doc.taxTotal)}</span></div> : null}
          <div className="flex justify-between border-t border-slate-200 pt-1 font-bold"><span>Total</span><span>{formatRupiah(doc.total)}</span></div>
          {doc.paidTotal > 0 ? <div className="flex justify-between text-emerald-700"><span>Sudah dibayar</span><span>{formatRupiah(doc.paidTotal)}</span></div> : null}
          {doc.balanceDue > 0 ? <div className="flex justify-between font-bold text-amber-700"><span>Sisa tagihan</span><span>{formatRupiah(doc.balanceDue)}</span></div> : null}
        </div>
      </section>

      {doc.packageBalance ? (
        doc.packageBalance.status === "unavailable" ? <section className="mt-6 rounded-xl bg-amber-50 p-4 text-sm">
          <p className="font-bold text-amber-800">Saldo paket: perlu ditinjau</p>
          <p className="text-amber-700">{doc.packageBalance.reviewNote}</p>
        </section> : <section className="mt-6 rounded-xl bg-emerald-50 p-4 text-sm">
          <p className="font-bold text-emerald-800">{doc.packageBalance.status === "purchase" ? `Pembelian paket: ${doc.packageBalance.packageName}` : `Menggunakan paket: ${doc.packageBalance.packageName}`}</p>
          {doc.packageBalance.status === "consumption" ? <p className="text-emerald-700">Sesi terpakai pada kunjungan ini: {doc.packageBalance.sessionsUsedThisVisit}</p> : null}
          <p className="text-emerald-700">Saldo saat ini: {doc.packageBalance.sessionsAvailable} sesi{doc.packageBalance.expiresAt ? ` · Berlaku hingga ${new Date(doc.packageBalance.expiresAt).toLocaleDateString("id-ID")}` : ""}{doc.packageBalance.packageStatus && doc.packageBalance.packageStatus !== "active" ? ` · Status: ${doc.packageBalance.packageStatus}` : ""}</p>
          <p className="mt-1 text-[10px] text-emerald-600">Saldo ini mencerminkan kondisi paket saat dokumen dibuka, bukan kondisi historis saat invoice ini pertama diterbitkan.</p>
        </section>
      ) : null}

      {showPaymentInstructions ? <section className="mt-6">
        <p className="text-xs font-bold uppercase text-slate-400">Instruksi pembayaran</p>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">{doc.bankAccounts.map((a, i) => <div key={i} className="rounded-xl border border-slate-200 p-3 text-sm"><p className="font-bold">{a.bankName}{a.isPrimary ? " (Utama)" : ""}</p><p>{a.accountNumber}</p><p className="text-slate-500">a.n. {a.accountHolder}</p></div>)}</div>
      </section> : null}

      {isPackageSale && doc.organization.membershipTerms ? <section className="mt-6 rounded-xl border border-slate-200 p-4 text-xs text-slate-600 print:break-before-page"><p className="mb-1 font-bold text-slate-700">Syarat & Ketentuan</p><p className="whitespace-pre-line">{doc.organization.membershipTerms}</p></section> : null}

      {doc.customerNotes ? <section className="mt-6 rounded-xl bg-slate-50 p-4 text-sm"><p className="font-bold text-slate-700">Catatan dari groomer</p><p className="mt-1 text-slate-600">{doc.customerNotes}</p></section> : null}

      {!isPackageSale && doc.photos.length > 0 ? <section className="mt-6 print:break-before-page">
        <p className="text-xs font-bold uppercase text-slate-400">Dokumentasi</p>
        {/* eslint-disable-next-line @next/next/no-img-element -- print layout needs a plain <img>, not next/image's runtime optimization */}
        <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3">{doc.photos.map((p) => <div key={p.id} className="overflow-hidden rounded-lg border border-slate-200"><img src={p.url} alt={p.category} className="aspect-square w-full object-cover" /><p className="p-1 text-center text-[10px] font-semibold capitalize text-slate-500">{p.category}</p></div>)}</div>
      </section> : null}

      {doc.status === "issued" ? <InvoiceCustomerNotesEditor invoiceId={doc.id} revision={doc.revision} initialNotes={doc.customerNotes ?? ""} internalNote={doc.internalGroomerNotes} /> : null}
    </div>
  </div>;
}

"use client";

/**
 * Print/download and WhatsApp handoff for the invoice document. Printing
 * uses the browser's native print-to-PDF (no new PDF dependency - the
 * lazy/native option since nothing else in this repo generates PDFs
 * server-side); "download" IS print-to-PDF, and the button says so rather
 * than implying a separate file is produced. WhatsApp opens a prefilled
 * draft for a human to send - never sent automatically, and the button
 * says so; it does not attach the PDF (browsers cannot do that from a
 * wa.me link), and the copy does not claim otherwise.
 */
import { useState } from "react";

import { buildWhatsAppUrl } from "@/components/customer-360";

function sanitizeFilename(input: string): string {
  return input.normalize("NFKD").replace(/[^a-zA-Z0-9-_ ]/g, "").trim().replace(/\s+/g, "-").slice(0, 80) || "invoice";
}

function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => vars[key] ?? "");
}

export function PrintDownloadButton({ invoiceNumber, customerName }: { invoiceNumber: string; customerName: string }) {
  function handlePrint() {
    const previousTitle = document.title;
    document.title = sanitizeFilename(`Invoice-${invoiceNumber}-${customerName}`);
    window.print();
    window.setTimeout(() => { document.title = previousTitle; }, 500);
  }
  return <button type="button" onClick={handlePrint} className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-bold text-white print:hidden">
    Cetak / Unduh PDF
  </button>;
}

export function WhatsAppHandoffButton({ phone, template, invoiceNumber, customerName, total, currency, label }: {
  phone: string | null; template: string; invoiceNumber: string; customerName: string; total: number; currency: string; label: string;
}) {
  const [copied, setCopied] = useState(false);
  const totalFormatted = new Intl.NumberFormat("id-ID", { style: "currency", currency: currency || "IDR", maximumFractionDigits: 0 }).format(total);
  const message = interpolate(template, { customer: customerName, number: invoiceNumber, total: totalFormatted });
  const url = buildWhatsAppUrl(phone, message);

  if (!phone) return <div className="print:hidden">
    <button type="button" disabled className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-bold text-slate-400">{label} (nomor tidak tersedia)</button>
  </div>;
  if (!url) return <div className="print:hidden">
    <button type="button" disabled className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-bold text-slate-400">{label} (nomor tidak valid)</button>
  </div>;

  return <div className="flex items-center gap-2 print:hidden">
    <a href={url} target="_blank" rel="noreferrer" className="rounded-xl border border-emerald-600 px-4 py-2 text-sm font-bold text-emerald-700">{label}</a>
    <button type="button" onClick={() => { navigator.clipboard.writeText(message).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 2000); }); }} className="text-xs font-semibold text-slate-500 underline">
      {copied ? "Tersalin" : "Salin pesan"}
    </button>
  </div>;
}

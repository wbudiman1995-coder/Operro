import "server-only";

import PDFDocument from "pdfkit";
import { NextResponse } from "next/server";
import { loadOperroInvoice, rupiah } from "@/lib/platform-invoice";
import { createClient } from "@/lib/supabase/server";

function makePdf(invoice: NonNullable<Awaited<ReturnType<typeof loadOperroInvoice>>>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 52 });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.fillColor("#047857").font("Helvetica-Bold").fontSize(23).text("Operro");
    doc.fillColor("#64748b").font("Helvetica").fontSize(10).text("Tagihan langganan platform");
    doc.moveDown(2);
    doc.fillColor("#0f172a").font("Helvetica-Bold").fontSize(21).text("INVOICE");
    doc.font("Helvetica").fontSize(11).text(invoice.invoice_number);
    doc.moveDown(1.5);
    doc.font("Helvetica-Bold").text("Ditagih kepada");
    doc.font("Helvetica").text(invoice.organization_name).text(invoice.recipient_email ?? "Pemilik bisnis");
    doc.moveDown();
    doc.text(`Diterbitkan: ${new Date(invoice.issued_at).toLocaleDateString("id-ID")}`);
    doc.text(`Periode: ${invoice.period_month.slice(0, 7)}`);
    doc.text(`Jatuh tempo: ${invoice.due_date}`);
    doc.text(`Status: ${invoice.status === "paid" ? "Lunas" : invoice.status === "overdue" ? "Terlambat" : "Menunggu pembayaran"}`);
    doc.moveDown(2);
    const left = 52; const right = doc.page.width - 52;
    doc.moveTo(left, doc.y).lineTo(right, doc.y).strokeColor("#cbd5e1").stroke();
    doc.moveDown();
    const y = doc.y;
    doc.font("Helvetica").fontSize(11).text(invoice.description, left, y, { width: 330 });
    doc.font("Helvetica-Bold").text(rupiah(invoice.amount_idr), left, y, { width: right - left, align: "right" });
    doc.moveDown(3);
    doc.moveTo(left, doc.y).lineTo(right, doc.y).stroke();
    doc.moveDown();
    doc.fontSize(13).text(`Total: ${rupiah(invoice.amount_idr)}`, { align: "right" });
    doc.moveDown(3);
    doc.font("Helvetica").fontSize(9).fillColor("#64748b").text("Pembayaran dikonfirmasi manual oleh Operro. Hubungi Operro untuk petunjuk pembayaran. Tagihan ini terpisah dari penjualan grooming bisnis Anda.");
    doc.end();
  });
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Invoice tidak ditemukan" }, { status: 404 });
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return NextResponse.json({ error: "Masuk diperlukan" }, { status: 401 });
  const invoice = await loadOperroInvoice(supabase, id).catch(() => null);
  if (!invoice) return NextResponse.json({ error: "Invoice tidak ditemukan atau akses ditolak" }, { status: 404 });
  const pdf = await makePdf(invoice);
  return new NextResponse(new Uint8Array(pdf), { headers: {
    "Content-Type": "application/pdf",
    "Content-Disposition": `attachment; filename="${invoice.invoice_number}.pdf"`,
    "Cache-Control": "private, no-store",
  } });
}

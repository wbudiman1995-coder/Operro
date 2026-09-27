/**
 * Function index:
 * - buildPayrollWorkbook: real .xlsx (ExcelJS) with Summary / Detail Job / Missing & Review
 *   sheets, per brief section 8. Reads the SAME payroll-data.ts / detail-RPC results the UI
 *   reads -- no second, independent calculation happens in here.
 * - buildPayrollCsv: one-sheet cycle CSV (the Summary rows), with formula-injection escaping
 *   (HomePaw's own SheetJS export has none -- this is a deliberate improvement, not a gap).
 * - buildPayslipPdf: a single groomer's printable/downloadable payslip (PDFKit), built from the
 *   same breakdown object the "Gaji saya" card and the workbook's Summary row read.
 * - sanitizeExportFilename: sanitizes a business name into a safe filename component.
 */
import "server-only";
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";

import { formatRupiah } from "@/lib/pilot-data";
import type { PayrollBreakdown, PayrollMissingItem, PayrollStaffCard } from "@/lib/payroll-data";

export interface PayrollExportDetailRow {
  bookingId: string; membershipId: string; staffName: string; startsAt: string;
  customerName: string; petName: string; petSize: string | null; services: string;
  serviceRevenue: number; invoiceNumber: string | null; invoiceStatus: string | null;
}

export interface PayrollExportData {
  organizationName: string;
  currency: string;
  periodStart: string;
  periodEnd: string;
  label: string;
  runStatus: string | null;
  staff: PayrollStaffCard[];
  detail: PayrollExportDetailRow[];
  missing: PayrollMissingItem[];
}

/** Neutralizes a leading =, +, -, or @ so a spreadsheet never treats a cell value as a formula. */
function csvSafeCell(value: string | number): string | number {
  if (typeof value !== "string") return value;
  return /^[=+\-@]/.test(value) ? `'${value}` : value;
}

function csvEscape(value: string | number): string {
  const safe = String(csvSafeCell(value));
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function sanitizeExportFilename(name: string): string {
  return name.replace(/[^A-Za-z0-9]/g, "") || "Operro";
}

const RUN_STATUS_LABEL: Record<string, string> = { draft: "DRAFT", approved: "APPROVED", paid: "PAID" };

function summaryRows(data: PayrollExportData) {
  return data.staff.map((s) => {
    const br = (s.breakdown ?? {}) as Partial<PayrollBreakdown>;
    const customTotal = s.customRows.reduce((sum, r) => sum + r.amount, 0);
    return {
      "Groomer": s.name,
      "Status": RUN_STATUS_LABEL[data.runStatus ?? ""] ?? "PENDING",
      "Cycle start": data.periodStart,
      "Cycle end": data.periodEnd,
      "Gaji pokok": br.basic ?? 0,
      "Gaji mingguan": br.weekly ?? 0,
      "Bonus no-late": br.noLate ?? 0,
      "Bonus no-sakit": br.noSick ?? 0,
      "Komisi styling": br.styling ?? 0,
      "Styling job count": br.meta?.stylingCount ?? 0,
      "Styling % diterapkan": br.meta?.stylingAppliedPct ?? 0,
      "Insentif Botak": br.botak ?? 0,
      "Botak job count": br.meta?.botakCount ?? 0,
      "Basic Grooming per dog": br.perDog ?? 0,
      "Basic Grooming job count": br.meta?.basicCount ?? 0,
      "Transport fee 1/2": br.transport ?? 0,
      "Uang harian": br.daily ?? 0,
      "Tambahan pay": customTotal,
      "Take-home": s.grossPay,
      "Hari kerja": br.meta?.workedDays ?? 0,
      "Hari sakit": br.meta?.sickDays ?? 0,
      "Late (kali)": br.meta?.lateCount ?? 0,
      "Dipublikasikan": s.published ? "YA" : "TIDAK",
    };
  });
}

export async function buildPayrollWorkbook(data: PayrollExportData): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Operro";
  wb.created = new Date();

  const summary = summaryRows(data);
  const ws1 = wb.addWorksheet("Summary", { views: [{ state: "frozen", ySplit: 1 }] });
  const summaryHeaders = summary.length > 0 ? Object.keys(summary[0]) : ["Groomer", "Status", "Info"];
  ws1.columns = summaryHeaders.map((h) => ({ header: h, key: h, width: Math.max(h.length + 2, 16) }));
  if (summary.length > 0) ws1.addRows(summary);
  else ws1.addRow({ Groomer: "-", Status: "-", Info: "Belum ada staf aktif untuk cycle ini" });

  const ws2 = wb.addWorksheet("Detail Job", { views: [{ state: "frozen", ySplit: 1 }] });
  ws2.columns = [
    { header: "Tanggal", key: "date", width: 14, style: { numFmt: "yyyy-mm-dd hh:mm" } },
    { header: "Groomer", key: "staff", width: 20 },
    { header: "Owner", key: "customer", width: 20 },
    { header: "Hewan", key: "pet", width: 16 },
    { header: "Ukuran", key: "size", width: 10 },
    { header: "Layanan", key: "services", width: 30 },
    { header: "Nilai layanan", key: "revenue", width: 16 },
    { header: "Invoice #", key: "invoiceNumber", width: 16 },
    { header: "Status invoice", key: "invoiceStatus", width: 14 },
  ];
  if (data.detail.length > 0) {
    for (const row of data.detail) {
      ws2.addRow({
        date: new Date(row.startsAt), staff: row.staffName, customer: row.customerName, pet: row.petName,
        size: row.petSize ?? "", services: row.services, revenue: row.serviceRevenue,
        invoiceNumber: row.invoiceNumber ?? "", invoiceStatus: row.invoiceStatus ?? "",
      });
    }
  } else {
    ws2.addRow({ date: "", staff: "", customer: "Tidak ada job terhitung di cycle ini" });
  }

  const ws3 = wb.addWorksheet("Missing & Review", { views: [{ state: "frozen", ySplit: 1 }] });
  ws3.columns = [
    { header: "Jenis", key: "kind", width: 20 },
    { header: "Tanggal", key: "date", width: 18, style: { numFmt: "yyyy-mm-dd hh:mm" } },
    { header: "Groomer", key: "staff", width: 20 },
    { header: "Tindakan", key: "action", width: 50 },
  ];
  if (data.missing.length > 0) {
    for (const row of data.missing) {
      ws3.addRow({ kind: "DONE TANPA INVOICE", date: new Date(row.startsAt), staff: row.staffName, action: "Buat invoice untuk booking ini agar masuk payroll" });
    }
  } else {
    ws3.addRow({ kind: "-", date: "", staff: "", action: "Tidak ada item yang hilang -- semua tally" });
  }

  const arrayBuffer = await wb.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

export function buildPayrollCsv(data: PayrollExportData): string {
  const rows = summaryRows(data);
  if (rows.length === 0) return "Groomer,Status,Info\r\n-,-,Belum ada staf aktif untuk cycle ini\r\n";
  const headers = Object.keys(rows[0]);
  const lines = [headers.map(csvEscape).join(",")];
  for (const row of rows) lines.push(headers.map((h) => csvEscape((row as Record<string, string | number>)[h])).join(","));
  return lines.join("\r\n") + "\r\n";
}

const PAYSLIP_LINES: Array<[keyof PayrollBreakdown, string]> = [
  ["basic", "Gaji pokok"], ["weekly", "Gaji mingguan"], ["noLate", "Bonus no-late"], ["noSick", "Bonus no-sakit"],
  ["styling", "Komisi styling"], ["botak", "Insentif Botak"], ["transport", "Transport fee 1/2"],
  ["perDog", "Basic Grooming per dog"], ["daily", "Uang harian"],
];

export async function buildPayslipPdf(data: PayrollExportData, staff: PayrollStaffCard): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fontSize(18).font("Helvetica-Bold").text(data.organizationName, { continued: false });
    doc.fontSize(11).font("Helvetica").fillColor("#555").text("Slip Gaji / Payslip").moveDown(0.3);
    doc.fillColor("#000").text(`Cycle: ${data.label}`).text(`Groomer: ${staff.name}`).text(`Status: ${RUN_STATUS_LABEL[data.runStatus ?? ""] ?? "PENDING"}`);
    doc.moveDown(1);

    const br = staff.breakdown;
    doc.font("Helvetica-Bold").fontSize(12).text("Rincian komponen").moveDown(0.3);
    doc.font("Helvetica").fontSize(10);
    const left = doc.page.margins.left; const right = doc.page.width - doc.page.margins.right;
    for (const [key, label] of PAYSLIP_LINES) {
      const value = br ? Number(br[key]) : 0;
      if (value <= 0) continue;
      const y = doc.y;
      doc.text(label, left, y, { continued: false });
      doc.text(formatRupiah(value), left, y, { width: right - left, align: "right" });
    }
    for (const row of staff.customRows) {
      if (row.amount <= 0) continue;
      const y = doc.y;
      doc.text(row.label || "Tambahan", left, y);
      doc.text(formatRupiah(row.amount), left, y, { width: right - left, align: "right" });
    }
    doc.moveDown(0.5);
    doc.moveTo(left, doc.y).lineTo(right, doc.y).strokeColor("#ccc").stroke();
    doc.moveDown(0.3);
    doc.font("Helvetica-Bold").fontSize(13);
    const totalY = doc.y;
    doc.text("Total", left, totalY);
    doc.text(formatRupiah(staff.grossPay), left, totalY, { width: right - left, align: "right" });

    doc.moveDown(2);
    doc.font("Helvetica").fontSize(8).fillColor("#888").text(`Dibuat ${new Date().toLocaleString("id-ID")} · angka dihitung dari invoice, bukan input manual.`);

    doc.end();
  });
}

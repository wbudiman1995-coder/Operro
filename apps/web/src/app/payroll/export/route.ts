/**
 * Payroll exports (section 33): ?format=xlsx|csv (whole cycle) or ?format=pdf&membershipId=...
 * (one groomer's payslip). Enforced server-side: payroll.read for the whole-cycle exports;
 * a groomer may also download their OWN payslip PDF without payroll.read. Reuses the exact
 * breakdown loadPayrollWorkspace/the UI already reads -- no independent recalculation here.
 */
import "server-only";

import { NextResponse } from "next/server";

import { loadPayrollExportDetail, loadPayrollWorkspace } from "@/lib/payroll-data";
import { buildPayrollCsv, buildPayrollWorkbook, buildPayslipPdf, sanitizeExportFilename, type PayrollExportData } from "@/lib/payroll-export";
import { requireActiveWorkspace } from "@/lib/require-workspace";

export async function GET(request: Request) {
  const workspace = await requireActiveWorkspace();
  const url = new URL(request.url);
  const format = url.searchParams.get("format");
  const anchor = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get("anchor") ?? "") ? url.searchParams.get("anchor") : null;
  const membershipId = url.searchParams.get("membershipId");

  if (!format || !["xlsx", "csv", "pdf"].includes(format)) {
    return NextResponse.json({ error: "format tidak dikenali (gunakan xlsx, csv, atau pdf)" }, { status: 400 });
  }

  const isOwnPayslip = format === "pdf" && membershipId === workspace.activeOrganization.membershipId;
  if (!workspace.capabilities["payroll.read"] && !isOwnPayslip) {
    return NextResponse.json({ error: "izin payroll.read diperlukan" }, { status: 403 });
  }

  const data = await loadPayrollWorkspace(workspace.supabase, workspace.activeOrganization.id, anchor);
  const staffByMembership = new Map(data.staff.map((s) => [s.membershipId, s.name]));
  const detail = format === "pdf" ? [] : await loadPayrollExportDetail(workspace.supabase, workspace.activeOrganization.id, data.periodStart, data.periodEnd, staffByMembership);

  const exportData: PayrollExportData = {
    organizationName: workspace.activeOrganization.name, currency: "IDR",
    periodStart: data.periodStart, periodEnd: data.periodEnd, label: data.label,
    runStatus: data.run?.status ?? null, staff: data.staff, detail, missing: data.missing,
  };

  const org = sanitizeExportFilename(workspace.activeOrganization.name);

  if (format === "xlsx") {
    const buffer = await buildPayrollWorkbook(exportData);
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${org}_Payroll_${data.periodStart}_${data.periodEnd}.xlsx"`,
      },
    });
  }

  if (format === "csv") {
    const csv = buildPayrollCsv(exportData);
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${org}_Payroll_${data.periodStart}_${data.periodEnd}.csv"`,
      },
    });
  }

  if (!membershipId) return NextResponse.json({ error: "membershipId wajib diisi untuk payslip" }, { status: 400 });
  const staff = data.staff.find((s) => s.membershipId === membershipId);
  if (!staff) return NextResponse.json({ error: "staf tidak ditemukan pada cycle ini" }, { status: 404 });
  if (!isOwnPayslip && !workspace.capabilities["payroll.read"]) {
    return NextResponse.json({ error: "izin payroll.read diperlukan" }, { status: 403 });
  }
  const pdf = await buildPayslipPdf(exportData, staff);
  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${org}_Payslip_${sanitizeExportFilename(staff.name)}_${data.periodStart}.pdf"`,
    },
  });
}

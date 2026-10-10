/**
 * Finance export (section 31): ?stage&month&q mirror the on-screen register
 * filters on /finance. Enforced server-side with finance.read, same
 * permission key the Finance page itself checks before showing numbers.
 */
import "server-only";

import { NextResponse } from "next/server";

import { parseCashPeriod } from "@/lib/cash-position";
import { loadBranchTimezones } from "@/lib/branch-context";
import { buildFinanceExport } from "@/lib/finance-export";
import { PAYMENT_STAGES, type PaymentStage } from "@/lib/payment-register";
import { sanitizeExportFilename } from "@/lib/payroll-export";
import { requireActiveWorkspace } from "@/lib/require-workspace";

export async function GET(request: Request) {
  const workspace = await requireActiveWorkspace();
  if (!workspace.capabilities["finance.read"]) {
    return NextResponse.json({ error: "izin finance.read diperlukan" }, { status: 403 });
  }

  const url = new URL(request.url);
  const stageParam = url.searchParams.get("stage");
  if (stageParam && !(PAYMENT_STAGES as string[]).includes(stageParam)) {
    return NextResponse.json({ error: "filter tahap pembayaran tidak valid" }, { status: 400 });
  }
  const stage = stageParam && (PAYMENT_STAGES as string[]).includes(stageParam) ? (stageParam as PaymentStage) : undefined;
  const monthParam = url.searchParams.get("month");
  if (monthParam && !/^\d{4}-(0[1-9]|1[0-2])$/.test(monthParam)) {
    return NextResponse.json({ error: "filter bulan harus YYYY-MM" }, { status: 400 });
  }
  const filters = { stage, serviceMonth: monthParam || undefined, search: url.searchParams.get("q") || undefined };

  const { defaultTimezone } = await loadBranchTimezones(workspace.supabase, workspace.activeOrganization.id);
  const period = parseCashPeriod(url.searchParams.get("from"), url.searchParams.get("to"), new Date(), defaultTimezone);
  if (!period.ok) return NextResponse.json({ error: period.message }, { status: 400 });

  const book = await buildFinanceExport(workspace.supabase, workspace.activeOrganization.id, filters, { period: period.period, timeZone: defaultTimezone });
  const buffer = await book.xlsx.writeBuffer();
  const org = sanitizeExportFilename(workspace.activeOrganization.name);
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${org}_Keuangan.xlsx"`,
    },
  });
}

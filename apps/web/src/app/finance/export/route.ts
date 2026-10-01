/**
 * Finance export (section 31): ?stage&month&q mirror the on-screen register
 * filters on /finance. Enforced server-side with finance.read, same
 * permission key the Finance page itself checks before showing numbers.
 */
import "server-only";

import { NextResponse } from "next/server";

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
  const stage = stageParam && (PAYMENT_STAGES as string[]).includes(stageParam) ? (stageParam as PaymentStage) : undefined;
  const filters = { stage, serviceMonth: url.searchParams.get("month") || undefined, search: url.searchParams.get("q") || undefined };

  const book = await buildFinanceExport(workspace.supabase, workspace.activeOrganization.id, filters);
  const buffer = await book.xlsx.writeBuffer();
  const org = sanitizeExportFilename(workspace.activeOrganization.name);
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${org}_Keuangan.xlsx"`,
    },
  });
}

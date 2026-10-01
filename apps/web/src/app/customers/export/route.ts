import "server-only";

import { NextResponse } from "next/server";

import { requireActiveWorkspace } from "@/lib/require-workspace";
import { buildCustomerExport, buildHomePawExport } from "@/lib/homepaw-export";

export async function GET(request: Request) {
  const workspace = await requireActiveWorkspace();
  if (!workspace.capabilities["customer.read"]) {
    return NextResponse.json({ error: "Izin customer.read diperlukan" }, { status: 403 });
  }
  const format = new URL(request.url).searchParams.get("format");
  if (format !== "xlsx" && format !== "all") {
    return NextResponse.json({ error: "Gunakan format=xlsx atau format=all" }, { status: 400 });
  }
  if (format === "all") {
    // The full backup contains finance, booking and complaint data. The
    // customer-only export below remains available to customer.read users.
    if (!(["booking.read", "finance.read", "membership.read", "reports.view"] as const).every((key) => workspace.capabilities[key])) {
      return NextResponse.json({ error: "Ekspor lengkap memerlukan izin booking, finance, membership dan reports" }, { status: 403 });
    }
    try {
      const workbook = await buildHomePawExport(workspace.supabase, workspace.activeOrganization.id);
      const bytes = await workbook.xlsx.writeBuffer();
      const slug = workspace.activeOrganization.name.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 50) || "workspace";
      return new NextResponse(new Uint8Array(bytes), { headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${slug}_Export_${new Date().toISOString().slice(0, 10)}.xlsx"`,
        "Cache-Control": "private, no-store",
      } });
    } catch {
      return NextResponse.json({ error: "Ekspor tidak dapat dimuat lengkap. Coba lagi atau hubungi Operro." }, { status: 500 });
    }
  }
  const workbook = await buildCustomerExport(workspace.supabase, workspace.activeOrganization.id);
  const bytes = await workbook.xlsx.writeBuffer();
  const slug = workspace.activeOrganization.name.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 50) || "workspace";
  return new NextResponse(new Uint8Array(bytes), { headers: {
    "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": `attachment; filename="${slug}_CRM_${new Date().toISOString().slice(0, 10)}.xlsx"`,
    "Cache-Control": "private, no-store",
  } });
}

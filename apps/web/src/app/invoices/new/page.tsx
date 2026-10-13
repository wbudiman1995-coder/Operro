import { randomUUID } from "node:crypto";
import Link from "next/link";

import { InvoiceStudio } from "@/components/invoice-studio";
import { PageHeader } from "@/components/pilot-ui";
import { WorkspaceShell } from "@/components/workspace-shell";
import { loadBusinessDefaults, NO_DEFAULTS } from "@/lib/business-defaults";
import { loadInvoiceStudioData } from "@/lib/invoice-workspace";
import { requireActiveWorkspace } from "@/lib/require-workspace";

export const metadata = { title: "Buat invoice" };

export default async function NewInvoicePage({ searchParams }: { searchParams: Promise<{ booking?: string }> }) {
  const workspace = await requireActiveWorkspace();
  const query = await searchParams;
  const [data, defaults] = await Promise.all([
    loadInvoiceStudioData(workspace.supabase, workspace.activeOrganization.id),
    // A missing table (older database) or a failed read keeps today's behavior: the due date defaults to the day after the invoice date.
    loadBusinessDefaults(workspace.supabase).catch(() => NO_DEFAULTS),
  ]);
  return <WorkspaceShell {...workspace} activePath="/finance">
    <PageHeader eyebrow="Service-to-cash" title="Buat invoice" description="Pilih penagihan sesudah kunjungan atau penjualan paket. Semua nominal disimpan sebagai snapshot dan invoice final tidak dapat diubah." action={<Link href="/finance" className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-bold text-slate-700">Kembali ke keuangan</Link>} />
    <div className="mt-7"><InvoiceStudio data={data} requestKey={randomUUID()} defaultBookingId={query.booking} dueDays={defaults.invoiceDueDays} /></div>
  </WorkspaceShell>;
}

/** Visits route (section 30): visit register over completed bookings + manual visits. */
import { PageHeader } from "@/components/pilot-ui";
import { VisitRegister } from "@/components/visit-register";
import { WorkspaceShell } from "@/components/workspace-shell";
import { loadCatalogWorkspace } from "@/lib/pilot-data";
import { loadVisitRegister, type InvoicedStatus } from "@/lib/visit-register";
import { requireActiveWorkspace } from "@/lib/require-workspace";

export const metadata = { title: "Kunjungan" };

const INVOICED_STATUSES: InvoicedStatus[] = ["invoiced", "manually_billed", "unbilled"];

function parseCursor(raw: string | undefined): { visitAt: string; id: string } | undefined {
  if (!raw) return undefined;
  const sep = raw.lastIndexOf("_");
  if (sep < 0) return undefined;
  const visitAt = decodeURIComponent(raw.slice(0, sep));
  const id = raw.slice(sep + 1);
  return visitAt && id ? { visitAt, id } : undefined;
}

export default async function VisitsPage({ searchParams }: { searchParams: Promise<{ q?: string; customerId?: string; petId?: string; status?: string; sort?: string; cursor?: string }> }) {
  const workspace = await requireActiveWorkspace();
  const organizationId = workspace.activeOrganization.id;
  const params = await searchParams;
  const org = await workspace.supabase.from("organizations").select("settings").eq("id", organizationId).single();
  const autoLogEnabled = Boolean((org.data?.settings as { visits?: { auto_log_enabled?: boolean } } | undefined)?.visits?.auto_log_enabled ?? true);
  const invoicedStatus: InvoicedStatus | "all" = params.status && (INVOICED_STATUSES as string[]).includes(params.status) ? (params.status as InvoicedStatus) : "all";
  const sort: "newest" | "oldest" = params.sort === "oldest" ? "oldest" : "newest";
  const registerFilters = {
    autoLogEnabled, search: params.q || undefined, customerId: params.customerId || undefined, petId: params.petId || undefined,
    invoicedStatus, sort, cursor: parseCursor(params.cursor),
  };
  const [page, catalog, customers, pets] = await Promise.all([
    loadVisitRegister(workspace.supabase, organizationId, registerFilters),
    loadCatalogWorkspace(workspace.supabase, organizationId),
    workspace.supabase.from("customers").select("id,display_name").eq("organization_id", organizationId).is("deleted_at", null).order("display_name"),
    workspace.supabase.from("pets").select("id,name,customer_id").eq("organization_id", organizationId).is("deleted_at", null),
  ]);

  return <WorkspaceShell {...workspace} activePath="/visits">
    <PageHeader eyebrow="Riwayat layanan" title="Kunjungan" description="Riwayat kunjungan otomatis dari booking selesai, ditambah kunjungan manual di luar sistem booking." />
    <div className="mt-7">
      <VisitRegister
        page={page}
        filters={{ search: params.q ?? "", customerId: params.customerId ?? "", petId: params.petId ?? "", invoicedStatus, sort }}
        autoLogEnabled={autoLogEnabled}
        branches={catalog.branches}
        customers={(customers.data ?? []).map((c) => ({ id: c.id, name: c.display_name }))}
        pets={(pets.data ?? []).map((p) => ({ id: p.id, name: p.name, customerId: p.customer_id }))}
      />
    </div>
  </WorkspaceShell>;
}

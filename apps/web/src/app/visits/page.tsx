/** Visits route (section 30): visit register over completed bookings + manual visits. */
import { PageHeader } from "@/components/pilot-ui";
import { VisitRegister } from "@/components/visit-register";
import { WorkspaceShell } from "@/components/workspace-shell";
import { loadCatalogWorkspace } from "@/lib/pilot-data";
import { loadVisitRegister } from "@/lib/visit-register";
import { requireActiveWorkspace } from "@/lib/require-workspace";

export const metadata = { title: "Kunjungan" };

export default async function VisitsPage() {
  const workspace = await requireActiveWorkspace();
  const organizationId = workspace.activeOrganization.id;
  const org = await workspace.supabase.from("organizations").select("settings").eq("id", organizationId).single();
  const autoLogEnabled = Boolean((org.data?.settings as { visits?: { auto_log_enabled?: boolean } } | undefined)?.visits?.auto_log_enabled ?? true);
  const [rows, catalog, customers, pets] = await Promise.all([
    loadVisitRegister(workspace.supabase, organizationId, { autoLogEnabled }),
    loadCatalogWorkspace(workspace.supabase, organizationId),
    workspace.supabase.from("customers").select("id,display_name").eq("organization_id", organizationId).is("deleted_at", null).order("display_name"),
    workspace.supabase.from("pets").select("id,name,customer_id").eq("organization_id", organizationId).is("deleted_at", null),
  ]);

  return <WorkspaceShell {...workspace} activePath="/visits">
    <PageHeader eyebrow="Riwayat layanan" title="Kunjungan" description="Riwayat kunjungan otomatis dari booking selesai, ditambah kunjungan manual di luar sistem booking." />
    <div className="mt-7">
      <VisitRegister
        rows={rows}
        autoLogEnabled={autoLogEnabled}
        branches={catalog.branches}
        customers={(customers.data ?? []).map((c) => ({ id: c.id, name: c.display_name }))}
        pets={(pets.data ?? []).map((p) => ({ id: p.id, name: p.name, customerId: p.customer_id }))}
      />
    </div>
  </WorkspaceShell>;
}

/** E1.2: owner-defined Customer 360 and pet fields (settings.manage). */
import { CustomFieldDefinitionManager } from "@/components/custom-field-definition-manager";
import { PageHeader } from "@/components/pilot-ui";
import { RestrictedNotice } from "@/components/restricted-notice";
import { WorkspaceShell } from "@/components/workspace-shell";
import { loadCustomFieldDefinitions } from "@/lib/custom-fields";
import { requireActiveWorkspace } from "@/lib/require-workspace";

export const metadata = { title: "Isian tambahan" };

export default async function CustomFieldSettingsPage() {
  const workspace = await requireActiveWorkspace();
  const allowed = Boolean(workspace.capabilities["settings.manage"]);
  const definitions = allowed ? await loadCustomFieldDefinitions(workspace.supabase, workspace.activeOrganization.id, null, { includeArchived: true }) : [];
  return <WorkspaceShell {...workspace} activePath="/settings/custom-fields">
    <PageHeader eyebrow="Pengaturan" title="Isian tambahan" description="Tambahkan isian khusus bisnis pada profil pelanggan dan hewan: teks singkat, angka, tanggal, ya/tidak, atau pilihan tunggal." />
    <div className="mt-7 max-w-3xl">
      {allowed ? <CustomFieldDefinitionManager definitions={definitions} /> : <RestrictedNotice title="Tidak ada izin mengatur isian" description="Peran Anda tidak memiliki izin settings.manage, sehingga isian tambahan tidak dapat dikelola." />}
    </div>
  </WorkspaceShell>;
}

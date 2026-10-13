/**
 * Official WhatsApp provider boundary (parity #34), disabled by default. Owner only. Records non-secret identifiers and a consent
 * attestation; nothing is sent and the database refuses enabling until the platform opens a provider.
 */
import { PageHeader } from "@/components/pilot-ui";
import { RestrictedNotice } from "@/components/restricted-notice";
import { WhatsAppProviderPanel } from "@/components/whatsapp-provider-panel";
import { WorkspaceShell } from "@/components/workspace-shell";
import { requireActiveWorkspace } from "@/lib/require-workspace";
import { loadProviderState, type ProviderState } from "@/lib/whatsapp-provider-settings";

export const metadata = { title: "Penyedia resmi WhatsApp" };
export const dynamic = "force-dynamic";

export default async function WhatsAppProviderPage() {
  const workspace = await requireActiveWorkspace();
  let state: ProviderState | null = null;
  let error: string | null = null;
  let denied = false;
  try {
    state = await loadProviderState(workspace.supabase);
  } catch (cause) {
    const code = (cause as { code?: string }).code;
    if (code === "42501") denied = true;
    else if (code === "PGRST202" || code === "42883") error = "Fitur ini belum tersedia di database yang terhubung (migrasi 20261101120000 belum diterapkan).";
    else {
      console.error("whatsapp_provider_load_failed", cause instanceof Error ? cause.message : "unknown");
      error = "Pengaturan penyedia belum dapat dimuat. Coba muat ulang halaman.";
    }
  }
  if (denied) {
    return <WorkspaceShell {...workspace} activePath="/whatsapp"><RestrictedNotice title="Hanya untuk pemilik bisnis" description="Pengaturan penyedia resmi WhatsApp hanya dapat dilihat dan diubah oleh pemilik bisnis." /></WorkspaceShell>;
  }
  return <WorkspaceShell {...workspace} activePath="/whatsapp">
    <PageHeader eyebrow="Komunikasi" title="Penyedia resmi WhatsApp" description="Persiapan untuk penyedia resmi. Belum tersedia: Operro tidak mengirim pesan dan tidak menerima status pengiriman." />
    <WhatsAppProviderPanel state={state} error={error} />
  </WorkspaceShell>;
}

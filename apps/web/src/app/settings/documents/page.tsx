/** Section 27 settings route: branding, bank accounts, WhatsApp templates. */
import { BankAccountsSection, DocumentSettingsForm } from "@/components/document-settings-form";
import { PageHeader } from "@/components/pilot-ui";
import { WorkspaceShell } from "@/components/workspace-shell";
import { requireActiveWorkspace } from "@/lib/require-workspace";

export const metadata = { title: "Pengaturan dokumen" };

interface OrgSettingsRow { documents?: { tagline?: string; membership_terms?: string; whatsapp_templates?: { paid_completion?: string; outstanding?: string; subscription_billing?: string } } }

export default async function DocumentSettingsPage() {
  const workspace = await requireActiveWorkspace();
  const organizationId = workspace.activeOrganization.id;
  const [org, bankAccounts] = await Promise.all([
    workspace.supabase.from("organizations").select("settings").eq("id", organizationId).single(),
    workspace.supabase.from("organization_bank_accounts").select("id,bank_name,account_number,account_holder,is_primary").eq("organization_id", organizationId).is("deleted_at", null).order("sort_order"),
  ]);
  const documents = (org.data?.settings as OrgSettingsRow | undefined)?.documents ?? {};

  return <WorkspaceShell {...workspace} activePath="/settings/documents">
    <PageHeader eyebrow="Pengaturan" title="Dokumen & pembayaran" description="Branding, rekening bank, dan template WhatsApp yang tampil pada invoice dan komunikasi pelanggan." />
    <div className="mt-7 grid gap-6 lg:grid-cols-2">
      <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
        <h2 className="mb-4 font-bold">Branding & template WhatsApp</h2>
        <DocumentSettingsForm settings={{
          tagline: documents.tagline ?? "",
          membershipTerms: documents.membership_terms ?? "",
          waPaidTemplate: documents.whatsapp_templates?.paid_completion ?? "",
          waOutstandingTemplate: documents.whatsapp_templates?.outstanding ?? "",
          waSubscriptionTemplate: documents.whatsapp_templates?.subscription_billing ?? "",
        }} />
      </section>
      <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
        <h2 className="mb-4 font-bold">Rekening bank (maksimum 2)</h2>
        <BankAccountsSection accounts={(bankAccounts.data ?? []).map((a) => ({ id: a.id, bankName: a.bank_name, accountNumber: a.account_number, accountHolder: a.account_holder, isPrimary: a.is_primary }))} />
      </section>
    </div>
  </WorkspaceShell>;
}

/**
 * E2.3 WhatsApp draft center. Drafts are wa.me messages a person opens and sends themselves; Operro never sends,
 * scrapes or reads WhatsApp, so every status after "draft" is a user report, not provider-confirmed delivery.
 */
import Link from "next/link";

import { CreateDraftButton, DraftRow } from "@/components/whatsapp-draft-center";
import { PageHeader } from "@/components/pilot-ui";
import { RestrictedNotice } from "@/components/restricted-notice";
import { WorkspaceShell } from "@/components/workspace-shell";
import { requireActiveWorkspace } from "@/lib/require-workspace";
import { loadDraftCandidates, loadWhatsAppDrafts, type DraftCursor } from "@/lib/whatsapp-draft-data";
import { SOURCE_LABELS, WHATSAPP_STATUS_LABELS, WHATSAPP_SOURCES, WHATSAPP_STATUSES, isWhatsAppSource, isWhatsAppStatus } from "@/lib/whatsapp-drafts";

export const metadata = { title: "Pusat WhatsApp" };

function parseCursor(raw: string | undefined): DraftCursor | undefined {
  if (!raw) return undefined;
  const separator = raw.lastIndexOf("_");
  const createdAt = separator > 0 ? raw.slice(0, separator) : "";
  const id = separator > 0 ? raw.slice(separator + 1) : "";
  return Number.isNaN(Date.parse(createdAt)) || !/^[0-9a-f-]{36}$/i.test(id) ? undefined : { createdAt: new Date(createdAt).toISOString(), id };
}

export default async function WhatsAppCenterPage({ searchParams }: { searchParams: Promise<{ status?: string; source?: string; cursor?: string }> }) {
  const workspace = await requireActiveWorkspace();
  const caps = workspace.capabilities;
  const anyAccess = caps["finance.read"] || caps["customer.read"] || caps["membership.read"] || caps["customer.manage"];
  if (!anyAccess) {
    return <WorkspaceShell {...workspace} activePath="/whatsapp"><RestrictedNotice title="Tidak ada izin" description="Pusat WhatsApp memerlukan izin melihat invoice, pelanggan, atau paket." /></WorkspaceShell>;
  }
  const params = await searchParams;
  const status = isWhatsAppStatus(params.status) ? params.status : undefined;
  const source = isWhatsAppSource(params.source) ? params.source : undefined;
  const [page, candidates] = await Promise.all([
    loadWhatsAppDrafts(workspace.supabase, workspace.activeOrganization.id, { status, source, cursor: parseCursor(params.cursor) }),
    loadDraftCandidates(workspace.supabase, workspace.activeOrganization.id, caps),
  ]);
  const filterHref = (patch: Record<string, string | undefined>) => {
    const query = new URLSearchParams();
    const merged = { status, source, ...patch };
    for (const [key, value] of Object.entries(merged)) if (value) query.set(key, value);
    const text = query.toString();
    return `/whatsapp${text ? `?${text}` : ""}`;
  };

  return <WorkspaceShell {...workspace} activePath="/whatsapp">
    <PageHeader eyebrow="Komunikasi" title="Pusat WhatsApp" description="Antrean draf pesan WhatsApp untuk invoice, follow-up, perpanjangan, dan undangan pendaftaran." action={<Link href="/whatsapp/batches" className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm font-bold text-emerald-800">Batch dan riwayat</Link>} />
    <p className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-xs leading-5 text-amber-900">
      Operro tidak mengirim pesan WhatsApp dan tidak membaca status pengiriman. Anda membuka draf di WhatsApp sendiri. Status &ldquo;dibuka&rdquo;, &ldquo;ditandai terkirim&rdquo;, dan &ldquo;ditandai gagal&rdquo; adalah catatan dari pengguna, bukan konfirmasi pengiriman dari WhatsApp.
    </p>

    <section className="mt-6 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
      <h2 className="font-bold">Tambah ke antrean</h2>
      <p className="mt-1 text-xs text-slate-500">Draf dibuat dari template bisnis Anda. Membuat draf tidak mengirim apa pun; membuat ulang untuk sumber yang sama tidak menggandakan draf aktif.</p>
      <div className="mt-4 grid gap-5 lg:grid-cols-3">
        <div>
          <h3 className="text-xs font-bold uppercase text-slate-400">Invoice belum lunas</h3>
          {candidates.invoices === null ? <p className="mt-2 text-xs text-slate-500">Memerlukan izin finance.read.</p>
            : candidates.invoices.length === 0 ? <p className="mt-2 text-xs text-slate-500">Tidak ada invoice terbit.</p>
            : <ul className="mt-2 space-y-3">{candidates.invoices.map((invoice) => <li key={invoice.id} className="text-xs"><p className="font-semibold text-slate-700">{invoice.invoiceNumber} · {invoice.customerName}</p><CreateDraftButton sourceType="invoice" sourceId={invoice.id} disabledReason={invoice.hasPhone ? null : "Nomor WhatsApp tidak tersedia"} /></li>)}</ul>}
        </div>
        <div>
          <h3 className="text-xs font-bold uppercase text-slate-400">Follow-up pelanggan</h3>
          {candidates.followups === null ? <p className="mt-2 text-xs text-slate-500">Memerlukan izin customer.read.</p>
            : candidates.followups.length === 0 ? <p className="mt-2 text-xs text-slate-500">Tidak ada pelanggan yang perlu di-follow-up.</p>
            : <ul className="mt-2 space-y-3">{candidates.followups.map((group) => <li key={group.customerId} className="text-xs"><p className="font-semibold text-slate-700">{group.customerName}</p><CreateDraftButton sourceType="followup" sourceId={group.customerId} disabledReason={group.phone ? null : "Nomor WhatsApp tidak tersedia"} /></li>)}</ul>}
        </div>
        <div>
          <h3 className="text-xs font-bold uppercase text-slate-400">Perpanjangan paket</h3>
          {candidates.renewals === null ? <p className="mt-2 text-xs text-slate-500">Memerlukan izin membership.read.</p>
            : candidates.renewals.length === 0 ? <p className="mt-2 text-xs text-slate-500">Tidak ada paket yang perlu diperpanjang.</p>
            : <ul className="mt-2 space-y-3">{candidates.renewals.flatMap((group) => group.memberships.map((m) => <li key={m.id} className="text-xs"><p className="font-semibold text-slate-700">{group.customerName} · {m.packageName}</p><CreateDraftButton sourceType="renewal" sourceId={m.id} disabledReason={group.phone ? null : "Nomor WhatsApp tidak tersedia"} /></li>))}</ul>}
        </div>
      </div>
      <p className="mt-4 text-[11px] text-slate-400">Undangan pendaftaran dicatat otomatis dari halaman <Link href="/customers/onboarding" className="underline">Onboarding</Link> saat tautan dibuat.</p>
    </section>

    <section className="mt-6" aria-label="Draf">
      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
        <Link href={filterHref({ status: undefined, cursor: undefined })} className={`rounded-full border px-3 py-1 font-bold ${!status ? "border-emerald-600 text-emerald-700" : "border-slate-200 text-slate-500"}`}>Semua status</Link>
        {WHATSAPP_STATUSES.map((value) => <Link key={value} href={filterHref({ status: value, cursor: undefined })} className={`rounded-full border px-3 py-1 font-bold ${status === value ? "border-emerald-600 text-emerald-700" : "border-slate-200 text-slate-500"}`}>{WHATSAPP_STATUS_LABELS[value].split(" (")[0]}</Link>)}
        <span className="mx-1 text-slate-300">|</span>
        <Link href={filterHref({ source: undefined, cursor: undefined })} className={`rounded-full border px-3 py-1 font-bold ${!source ? "border-emerald-600 text-emerald-700" : "border-slate-200 text-slate-500"}`}>Semua sumber</Link>
        {WHATSAPP_SOURCES.map((value) => <Link key={value} href={filterHref({ source: value, cursor: undefined })} className={`rounded-full border px-3 py-1 font-bold ${source === value ? "border-emerald-600 text-emerald-700" : "border-slate-200 text-slate-500"}`}>{SOURCE_LABELS[value]}</Link>)}
      </div>
      {page.rows.length === 0 ? <p className="rounded-2xl border border-dashed border-slate-200 p-8 text-center text-sm text-slate-500">Belum ada draf{status || source ? " untuk filter ini" : ""}.</p>
        : <ul className="space-y-3">{page.rows.map((row) => <DraftRow key={`${row.id}:${row.status}`} draft={row} canManageContacts={Boolean(caps["customer.manage"])} />)}</ul>}
      {page.hasMore && page.nextCursor ? <div className="mt-4 text-center"><Link href={filterHref({ cursor: `${page.nextCursor.createdAt}_${page.nextCursor.id}` })} className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-xs font-bold text-slate-700">Muat lebih banyak</Link></div> : null}
    </section>
  </WorkspaceShell>;
}

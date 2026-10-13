/**
 * Function index:
 * - AccessReadinessPanel: platform-owner block with totals and the organizations that need attention, from existing records only.
 *
 * Counts and fixed flags only: no e-mail address, token or user id is shown because none is read. It does not prove that an invitation
 * e-mail was delivered or that a real person signed in; that needs the hosted QC script (docs/runbooks/STAGING_ACCESS_QC.md).
 */
import { FLAG_INFO, type AccessReadiness } from "@/lib/access-readiness-summary";

export function AccessReadinessPanel({ readiness, error }: { readiness: AccessReadiness | null; error: string | null }) {
  const attention = readiness ? readiness.organizations.filter((org) => org.flags.length > 0) : [];
  return (
    <section className="rounded-2xl border bg-white p-5" aria-label="Kesiapan akses">
      <h2 className="font-bold">Kesiapan akses</h2>
      <p className="mt-1 text-xs text-slate-500">Dihitung dari catatan yang ada (anggota, peran, undangan). Hanya angka dan penanda tetap: tidak ada email, token, atau id pengguna. Ini bukan bukti email undangan terkirim atau orang sungguhan berhasil masuk; itu perlu skrip QC hosted staging.</p>
      {error ? <p role="alert" className="mt-3 rounded-lg bg-rose-50 p-3 text-xs font-semibold text-rose-700">{error}</p> : null}
      {readiness === null ? null : <>
        <dl className="mt-4 grid gap-3 text-xs sm:grid-cols-3 lg:grid-cols-6">
          {([
            ["Organisasi", readiness.totals.organizations], ["Ditangguhkan", readiness.totals.suspendedWorkspaces], ["Tanpa pemilik aktif", readiness.totals.withoutActiveOwner],
            ["Undangan menunggu", readiness.totals.pendingInvitations], ["Undangan kedaluwarsa", readiness.totals.expiredPendingInvitations], ["Orang di >1 organisasi", readiness.totals.peopleInSeveralOrganizations],
          ] as const).map(([label, value]) => <div key={label} className="rounded-xl bg-slate-50 p-3"><dt className="font-semibold text-slate-500">{label}</dt><dd className="mt-1 text-lg font-bold text-slate-900">{value}</dd></div>)}
        </dl>
        {readiness.truncated ? <p className="mt-2 text-xs text-slate-500">Hanya 200 organisasi pertama (menurut nama) yang dirinci.</p> : null}
        {attention.length === 0
          ? <p className="mt-4 rounded-lg bg-emerald-50 p-3 text-xs font-semibold text-emerald-800">Tidak ada organisasi yang perlu tindakan menurut catatan saat ini.</p>
          : <ul className="mt-4 space-y-3">
              {attention.map((org) => (
                <li key={org.id} className="rounded-xl border border-slate-200 p-3 text-xs">
                  <p className="font-bold text-slate-800">{org.name} <span className="font-normal text-slate-500">({org.status}) · {org.activeMembers} anggota aktif · {org.activeOwners} pemilik aktif · {org.pendingInvitations} undangan menunggu</span></p>
                  <ul className="mt-2 space-y-1">
                    {org.flags.map((flag) => {
                      const info = FLAG_INFO[flag];
                      return <li key={flag} className={info?.severity === "attention" ? "text-amber-800" : "text-slate-600"}><span className="font-semibold">{info ? info.text : `Penanda tidak dikenal: ${flag}`}</span>{info ? ` ${info.action}` : ""}</li>;
                    })}
                  </ul>
                </li>
              ))}
            </ul>}
      </>}
    </section>
  );
}

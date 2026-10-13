/**
 * Function index:
 * - NoOrganizationState: honest empty state for authenticated users without a live membership.
 */
import { BuildingIcon } from "@/components/icons";
import { LogoutButton } from "@/components/logout-button";
import { OperroMark } from "@/components/operro-mark";
import Link from "next/link";

export function NoOrganizationState({ email, suspendedOrganizations = [] }: { email: string; suspendedOrganizations?: ReadonlyArray<{ name: string; reason: string | null }> }) {
  const hasSuspension = suspendedOrganizations.length > 0;
  return (
    <main className="min-h-screen bg-slate-50 px-5 py-8 sm:px-8">
      <div className="mx-auto max-w-5xl">
        <header className="flex items-center justify-between gap-4">
          <OperroMark />
          <LogoutButton />
        </header>

        <section className="mx-auto mt-20 max-w-xl rounded-3xl border border-slate-200 bg-white p-8 text-center shadow-xl shadow-slate-950/5 sm:p-12">
          <span className="mx-auto grid size-16 place-items-center rounded-2xl bg-amber-50 text-amber-700">
            <BuildingIcon className="size-8" />
          </span>
          <p className="mt-6 text-xs font-bold uppercase tracking-[0.18em] text-amber-700">
            {hasSuspension ? "Akses workspace ditangguhkan" : "Belum ada workspace"}
          </p>
          <h1 className="mt-3 text-3xl font-bold tracking-[-0.04em] text-slate-950">
            {hasSuspension ? "Workspace Anda untuk sementara tidak tersedia" : "Akun Anda belum memiliki organisasi aktif"}
          </h1>
          <p className="mt-4 text-sm leading-7 text-slate-600">
            Anda masuk sebagai <span className="font-semibold text-slate-800">{email}</span>. {hasSuspension
              ? "Akses dihentikan oleh pemilik platform Operro. Hubungi administrator Operro untuk aktivasi kembali."
              : "Belum ada membership aktif pada organisasi yang beroperasi. Minta pemilik bisnis atau administrator Operro untuk mengundang akun ini."}
          </p>
          <div className="mt-8 rounded-2xl bg-slate-50 px-5 py-4 text-left text-sm leading-6 text-slate-600">
            {hasSuspension ? <span><strong>Alasan:</strong> {suspendedOrganizations.map((organization) => `${organization.name}: ${organization.reason ?? "Tidak ada alasan yang dicantumkan."}`).join(" · ")}</span>
              : "Operro tidak akan menampilkan data bisnis sampai akses organisasi Anda tervalidasi oleh database."}
          </div>
          {email.toLowerCase() === "wbudiman1995@gmail.com" ? <Link href="/platform" className="mt-5 inline-block rounded-lg bg-emerald-700 px-4 py-2 text-sm font-bold text-white">Buka panel platform Operro</Link> : null}
          <p className="mt-5 text-sm"><Link href="/billing" className="font-bold text-emerald-800 underline">Lihat tagihan Operro untuk bisnis Anda</Link></p>
        </section>
      </div>
    </main>
  );
}

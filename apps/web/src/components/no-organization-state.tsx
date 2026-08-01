/**
 * Function index:
 * - NoOrganizationState: honest empty state for authenticated users without a live membership.
 */
import { BuildingIcon } from "@/components/icons";
import { LogoutButton } from "@/components/logout-button";
import { OperroMark } from "@/components/operro-mark";

export function NoOrganizationState({ email }: { email: string }) {
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
            Belum ada workspace
          </p>
          <h1 className="mt-3 text-3xl font-bold tracking-[-0.04em] text-slate-950">
            Akun Anda belum memiliki organisasi aktif
          </h1>
          <p className="mt-4 text-sm leading-7 text-slate-600">
            Anda masuk sebagai <span className="font-semibold text-slate-800">{email}</span>,
            tetapi belum ada membership aktif pada organisasi yang beroperasi.
            Minta pemilik bisnis atau administrator Operro untuk mengundang akun ini.
          </p>
          <div className="mt-8 rounded-2xl bg-slate-50 px-5 py-4 text-left text-sm leading-6 text-slate-600">
            Operro tidak akan menampilkan data bisnis sampai akses organisasi Anda
            tervalidasi oleh database.
          </div>
        </section>
      </div>
    </main>
  );
}

/**
 * Function index:
 * - HomePage: redirects authenticated users into the correct workspace flow or renders the Operro landing page.
 */
import Link from "next/link";
import { redirect } from "next/navigation";

import { ArrowIcon, CalendarIcon, CustomersIcon, TasksIcon } from "@/components/icons";
import { OperroMark } from "@/components/operro-mark";
import { loadAuthContext } from "@/lib/auth-context";
import { createClient } from "@/lib/supabase/server";

export default async function HomePage() {
  const supabase = await createClient();
  const context = await loadAuthContext(supabase);

  if (context) {
    redirect(
      context.organizations.length === 1 && context.activeOrganization
        ? "/dashboard"
        : "/organizations",
    );
  }

  return (
    <main className="min-h-screen overflow-hidden bg-[#f6f7f9] text-[#1a2233]">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[42rem] overflow-hidden">
        <div className="absolute -left-32 top-12 size-96 rounded-full bg-[#bdebe0]/55 blur-3xl" />
        <div className="absolute right-[-8rem] top-[-5rem] size-[30rem] rounded-full bg-[#fce4cc]/60 blur-3xl" />
      </div>

      <header className="relative z-10 mx-auto flex max-w-7xl items-center justify-between px-5 py-6 sm:px-8">
        <OperroMark />
        <Link
          href="/login"
          className="rounded-[10px] border border-[#e4e7ec] bg-white/85 px-4 py-2.5 text-sm font-semibold text-[#1a2233] shadow-sm backdrop-blur transition hover:border-[#0f8a72]/40 hover:text-[#0b6e5a] focus:outline-none focus:ring-4 focus:ring-[#0f8a72]/10"
        >
          Masuk
        </Link>
      </header>

      <section className="relative z-10 mx-auto grid max-w-7xl items-center gap-14 px-5 pb-24 pt-12 sm:px-8 lg:grid-cols-[1.05fr_0.95fr] lg:pb-32 lg:pt-20">
        <div>
          <p className="inline-flex rounded-full border border-[#bdebe0] bg-white/75 px-3 py-1.5 text-xs font-bold uppercase tracking-[0.15em] text-[#0b6e5a] shadow-sm backdrop-blur">
            Dibuat untuk bisnis layanan Indonesia
          </p>
          <h1 className="mt-6 max-w-3xl text-5xl font-bold leading-[1.02] tracking-[-0.06em] text-slate-950 sm:text-6xl lg:text-7xl">
            Operasional lebih rapi. Bisnis bergerak lebih cepat.
          </h1>
          <p className="mt-6 max-w-2xl text-base leading-8 text-slate-600 sm:text-lg">
            Operro menyatukan booking, pelanggan, tim, dan pekerjaan harian dalam
            satu workspace yang jelas—agar pemilik bisnis tahu apa yang perlu
            dilakukan berikutnya.
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Link
              href="/login"
            className="inline-flex h-12 items-center justify-center gap-2 rounded-[10px] bg-[#0f1b2d] px-6 text-sm font-semibold text-white shadow-xl shadow-slate-950/15 transition hover:-translate-y-0.5 hover:bg-[#0f8a72] focus:outline-none focus:ring-4 focus:ring-[#0f8a72]/20"
            >
              Buka workspace
              <ArrowIcon className="size-4" />
            </Link>
            <a
              href="#cara-kerja"
              className="inline-flex h-12 items-center justify-center rounded-[10px] border border-[#e4e7ec] bg-white px-6 text-sm font-semibold text-[#5b6472] shadow-sm transition hover:border-slate-300 hover:bg-[#fbfbfc] focus:outline-none focus:ring-4 focus:ring-slate-200"
            >
              Lihat fondasi Operro
            </a>
          </div>
        </div>

        <div className="relative">
          <div className="absolute inset-5 rounded-[2rem] bg-[#57c9ad]/30 blur-3xl" />
          <div className="relative overflow-hidden rounded-[18px] border border-white/70 bg-[#0f1b2d] p-4 shadow-2xl shadow-slate-950/15 sm:p-6">
            <div className="flex items-center justify-between border-b border-white/10 pb-5">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.16em] text-[#57c9ad]">Ringkasan hari ini</p>
                <p className="mt-2 text-xl font-bold text-white">Workspace Anda</p>
              </div>
              <span className="rounded-full bg-[#57c9ad]/10 px-3 py-1 text-xs font-semibold text-[#57c9ad]">Pratinjau</span>
            </div>
            <div className="mt-5 grid grid-cols-2 gap-3">
              {[
                ["Booking", "—"],
                ["Tugas", "—"],
                ["Pelanggan", "—"],
                ["Cabang", "—"],
              ].map(([label, value]) => (
                <div key={label} className="rounded-2xl border border-white/10 bg-white/5 p-4">
                  <p className="text-xs text-slate-400">{label}</p>
                  <p className="mt-2 text-2xl font-bold text-white">{value}</p>
                </div>
              ))}
            </div>
            <div className="mt-4 rounded-2xl bg-white p-5">
              <div className="flex items-center justify-between">
                <p className="text-sm font-bold text-slate-900">Agenda berikutnya</p>
                <span className="text-xs font-semibold text-slate-400">—</span>
              </div>
              <div className="mt-4 h-2 rounded-full bg-slate-100" />
              <p className="mt-3 text-xs leading-5 text-slate-500">Tampilan ilustratif untuk fondasi produk Operro.</p>
            </div>
          </div>
        </div>
      </section>

      <section id="cara-kerja" className="border-t border-slate-200 bg-white py-20">
        <div className="mx-auto max-w-7xl px-5 sm:px-8">
          <div className="max-w-2xl">
            <p className="text-sm font-bold text-[#0f8a72]">Satu sumber kebenaran</p>
            <h2 className="mt-3 text-3xl font-bold tracking-[-0.045em] sm:text-4xl">Fokus pada pekerjaan yang membuat bisnis berjalan</h2>
          </div>
          <div className="mt-10 grid gap-5 md:grid-cols-3">
            {[
              { icon: CalendarIcon, title: "Booking terstruktur", copy: "Jadwal, layanan, dan eksekusi berada dalam alur operasional yang sama." },
              { icon: CustomersIcon, title: "Pelanggan lebih dikenal", copy: "Hubungan pelanggan dan histori layanan siap menjadi konteks tim." },
              { icon: TasksIcon, title: "Tugas tidak terlewat", copy: "Pekerjaan harian dapat dipantau dari satu workspace yang konsisten." },
            ].map((feature) => {
              const Icon = feature.icon;
              return (
                <article key={feature.title} className="rounded-[14px] border border-[#e4e7ec] bg-[#fbfbfc] p-6 shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
                  <span className="grid size-11 place-items-center rounded-[10px] bg-[#e3f5f1] text-[#0b6e5a]"><Icon className="size-5" /></span>
                  <h3 className="mt-5 text-lg font-bold">{feature.title}</h3>
                  <p className="mt-2 text-sm leading-6 text-slate-500">{feature.copy}</p>
                </article>
              );
            })}
          </div>
        </div>
      </section>
    </main>
  );
}

import { GroomerCodeAccess } from "@/components/groomer-code-access";
import { OperroMark } from "@/components/operro-mark";

export const metadata = { title: "Akses groomer" };

export default function GroomerAccessPage() {
  return <main className="min-h-screen bg-slate-50 px-5 py-8 sm:px-8">
    <div className="mx-auto max-w-md"><OperroMark />
      <section className="mt-16"><p className="text-xs font-bold uppercase tracking-[0.18em] text-emerald-700">Akses lapangan</p><h1 className="mt-3 text-4xl font-bold tracking-[-0.05em] text-slate-950">Jadwal groomer</h1><p className="mt-4 text-sm leading-7 text-slate-600">Masukkan kode pribadi dari admin untuk melihat jadwal dan mengunggah foto sebelum/sesudah. Tidak memerlukan email atau kata sandi.</p><GroomerCodeAccess /><p className="mt-4 text-center text-xs leading-5 text-slate-500">Kode hanya untuk satu aktivasi perangkat dan berlaku 30 hari. Jika berganti perangkat atau kode gagal, minta admin membuatkan kode baru.</p></section>
    </div>
  </main>;
}

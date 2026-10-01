import { AcceptInvitationForm } from "@/components/accept-invitation-form";
import { OperroMark } from "@/components/operro-mark";

export const metadata = { title: "Terima undangan | Operro" };

export default async function AcceptInvitationPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <main className="min-h-screen bg-slate-50 px-4 py-12"><div className="mx-auto max-w-lg rounded-3xl border bg-white p-6 shadow-sm sm:p-9"><OperroMark /><h1 className="mt-8 text-2xl font-bold">Terima undangan workspace</h1><p className="mt-2 text-sm leading-6 text-slate-600">Masuk atau buat akun Operro dengan <strong>alamat email yang menerima link ini</strong>. Anda tidak perlu akun Vercel. Link pendaftaran berlaku sekali selama tujuh hari; setelah diterima, akses akun tidak kedaluwarsa sampai ditangguhkan oleh pemilik bisnis atau Operro.</p><AcceptInvitationForm token={token} /></div></main>;
}

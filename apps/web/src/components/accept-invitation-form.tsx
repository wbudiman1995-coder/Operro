"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { describeInvitationError } from "@/lib/invitation-errors";
import { createClient } from "@/lib/supabase/client";
import { GoogleSignInButton } from "@/components/google-sign-in-button";

export function AcceptInvitationForm({ token }: { token: string }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const attemptedExistingSession = useRef(false);

  async function claim() {
    const supabase = createClient();
    const { error } = await supabase.schema("app").rpc("claim_access_invitation", { p_token: token });
    if (error) {
      setMessage(describeInvitationError(error));
      return;
    }
    await supabase.auth.refreshSession();
    router.replace("/organizations");
    router.refresh();
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setMessage("");
    try {
      const supabase = createClient();
      const result = await supabase.auth.signInWithPassword({ email: email.trim().toLowerCase(), password });
      if (result.error) { setMessage("Email atau kata sandi salah, atau email belum diverifikasi."); return; }
      await claim();
    } catch { setMessage("Koneksi gagal. Coba lagi."); }
    finally { setBusy(false); }
  }

  useEffect(() => {
    if (attemptedExistingSession.current) return;
    attemptedExistingSession.current = true;
    const supabase = createClient();
    supabase.auth.getSession().then(({ data }) => {
      if (!data.session) return;
      setBusy(true);
      claim().finally(() => setBusy(false));
    }).catch(() => undefined);
  // This is intentionally one attempt per invitation view; a rejected token
  // should surface its error instead of repeatedly firing the RPC.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div className="mt-6 space-y-4">
    <p className="rounded-xl bg-slate-50 p-3 text-xs leading-5 text-slate-600">Aktifkan akses Operro hanya dengan masuk ke akun yang sudah ada dan memakai email penerima yang sama. Tidak ada pendaftaran akun dari link ini.</p>
    <form onSubmit={submit} className="space-y-4"><label className="block text-sm font-semibold">Email penerima<input type="email" required autoComplete="email" value={email} onChange={event => setEmail(event.target.value)} className="mt-1 h-11 w-full rounded-lg border px-3" /></label><label className="block text-sm font-semibold">Kata sandi<input type="password" required autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} className="mt-1 h-11 w-full rounded-lg border px-3" /></label><button disabled={busy} className="h-11 w-full rounded-lg bg-emerald-700 px-4 text-sm font-bold text-white disabled:opacity-50">{busy ? "Memproses…" : "Masuk & terima undangan"}</button></form>
    <div className="flex items-center gap-3 text-xs text-slate-400"><span className="h-px flex-1 bg-slate-200" />atau<span className="h-px flex-1 bg-slate-200" /></div>
    <GoogleSignInButton next={`/accept/${token}`} label="Masuk dengan Google & terima undangan" />
    <button type="button" disabled={busy} onClick={() => { setBusy(true); setMessage(""); claim().finally(() => setBusy(false)); }} className="text-xs font-bold text-emerald-700 underline">Sudah masuk? Terima undangan sekarang</button>
    {message ? <p role="status" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{message}</p> : null}
  </div>;
}

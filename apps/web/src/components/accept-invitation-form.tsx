"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { describeInvitationError } from "@/lib/invitation-errors";
import { createClient } from "@/lib/supabase/client";

type Mode = "create" | "sign-in";

export function AcceptInvitationForm({ token }: { token: string }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [mode, setMode] = useState<Mode>("create");
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [message, setMessage] = useState("");
  const attemptedExistingSession = useRef(false);

  async function claim() {
    const supabase = createClient();
    const { error } = await supabase.schema("app").rpc("claim_access_invitation", { p_token: token });
    if (error) { setMessage(describeInvitationError(error)); return false; }
    await supabase.auth.refreshSession();
    router.replace("/organizations");
    router.refresh();
    return true;
  }

  useEffect(() => {
    const supabase = createClient();
    void supabase.schema("app").rpc("pending_access_invitation_email", { p_token: token }).then(({ data, error }) => {
      if (error || typeof data !== "string") {
        const invitationUnavailable = error?.message.includes("invitation_unavailable")
          || error?.message.includes("invalid_invitation");
        setMessage(invitationUnavailable
          ? "Link undangan sudah tidak berlaku. Minta pemilik bisnis mengirim link baru."
          : "Undangan belum dapat diperiksa. Muat ulang halaman atau coba lagi sebentar.");
        return;
      }
      setEmail(data);
      setReady(true);
    }, () => setMessage("Link undangan tidak dapat diperiksa. Coba lagi."));
  }, [token]);

  useEffect(() => {
    if (!ready || attemptedExistingSession.current) return;
    attemptedExistingSession.current = true;
    const supabase = createClient();
    supabase.auth.getSession().then(({ data }) => {
      if (!data.session) return;
      setBusy(true);
      claim().finally(() => setBusy(false));
    }).catch(() => undefined);
  // Claim only once for a pre-existing signed-in session.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  async function createPassword(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (password.length < 8) { setMessage("Kata sandi minimal 8 karakter."); return; }
    if (password !== confirmPassword) { setMessage("Konfirmasi kata sandi belum sama."); return; }
    setBusy(true); setMessage("");
    try {
      const supabase = createClient();
      const redirectTo = `${globalThis.location.origin}/auth/callback?next=${encodeURIComponent(`/accept/${token}`)}`;
      const { data, error } = await supabase.auth.signUp({ email, password, options: { emailRedirectTo: redirectTo } });
      if (error) { setMessage(error.message.includes("already registered") ? "Email ini sudah punya akun. Pilih Masuk ke akun yang sudah ada." : "Akun tidak dapat dibuat. Coba lagi."); return; }
      if (data.session) { await claim(); return; }
      setMessage("Kata sandi dibuat. Periksa email untuk mengonfirmasi akun, lalu masuk dengan kata sandi baru Anda.");
    } catch { setMessage("Koneksi gagal. Coba lagi."); }
    finally { setBusy(false); }
  }

  async function signIn(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setMessage("");
    try {
      const result = await createClient().auth.signInWithPassword({ email, password });
      if (result.error) { setMessage("Email atau kata sandi salah, atau email belum diverifikasi."); return; }
      await claim();
    } catch { setMessage("Koneksi gagal. Coba lagi."); }
    finally { setBusy(false); }
  }

  if (!ready) return <p role={message ? "alert" : "status"} className={`mt-6 rounded-xl p-4 text-sm ${message ? "bg-amber-50 text-amber-900" : "bg-slate-50 text-slate-600"}`}>{message || "Memeriksa undangan…"}</p>;

  return <div className="mt-6 space-y-4">
    <div className="rounded-xl bg-slate-50 p-4 text-sm text-slate-700"><p className="font-semibold">Undangan untuk</p><p className="mt-1 font-medium text-slate-950">{email}</p></div>
    <div className="grid grid-cols-2 rounded-xl bg-slate-100 p-1 text-sm font-semibold"><button type="button" onClick={() => { setMode("create"); setMessage(""); }} className={`rounded-lg px-3 py-2 ${mode === "create" ? "bg-white text-emerald-800 shadow-sm" : "text-slate-600"}`}>Buat kata sandi</button><button type="button" onClick={() => { setMode("sign-in"); setMessage(""); }} className={`rounded-lg px-3 py-2 ${mode === "sign-in" ? "bg-white text-emerald-800 shadow-sm" : "text-slate-600"}`}>Sudah punya akun</button></div>
    {mode === "create" ? <form onSubmit={createPassword} className="space-y-4"><label className="block text-sm font-semibold">Kata sandi baru<input type="password" required minLength={8} autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} className="mt-1 h-11 w-full rounded-lg border px-3" /></label><label className="block text-sm font-semibold">Konfirmasi kata sandi<input type="password" required minLength={8} autoComplete="new-password" value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} className="mt-1 h-11 w-full rounded-lg border px-3" /></label><button disabled={busy} className="h-11 w-full rounded-lg bg-emerald-700 px-4 text-sm font-bold text-white disabled:opacity-50">{busy ? "Memproses…" : "Buat akun & terima undangan"}</button></form> : <form onSubmit={signIn} className="space-y-4"><label className="block text-sm font-semibold">Kata sandi<input type="password" required autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} className="mt-1 h-11 w-full rounded-lg border px-3" /></label><button disabled={busy} className="h-11 w-full rounded-lg bg-emerald-700 px-4 text-sm font-bold text-white disabled:opacity-50">{busy ? "Memproses…" : "Masuk & terima undangan"}</button></form>}
    {message ? <p role="status" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{message}</p> : null}
  </div>;
}

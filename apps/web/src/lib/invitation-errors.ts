/**
 * Function index:
 * - describeInvitationError: plain-language reason for a failed app.claim_access_invitation call, distinguishing the cases a
 *   person can act on (wrong or unverified e-mail, already a member, workspace not active, link used/expired/revoked) from a
 *   transient or unexpected failure, which must NOT be reported as "the link is invalid".
 *
 * The database error text is matched, never displayed.
 */
export function describeInvitationError(error: { code?: string; message?: string }): string {
  const message = error.message ?? "";
  if (/wrong_or_unverified_email/.test(message)) return "Masuk menggunakan email penerima undangan yang sudah diverifikasi.";
  if (/membership_already_exists/.test(message)) return "Akun ini sudah tercatat di workspace tersebut. Link lama tidak mengaktifkan kembali atau mengubah akses; masuk lalu pilih workspace, atau minta pemilik memulihkan akses Anda.";
  if (/organization_unavailable/.test(message)) return "Workspace ini sedang tidak aktif (ditangguhkan atau belum siap), sehingga undangan tidak dapat diterima sekarang. Hubungi pemilik bisnis atau Operro.";
  if (/invitation_unavailable|invalid_invitation/.test(message)) return "Link tidak tersedia, kedaluwarsa, atau sudah digunakan. Minta link baru kepada pemilik.";
  if (error.code === "PGRST202" || error.code === "42883") return "Layanan undangan belum siap di server ini. Jangan coba lagi dengan link lain; hubungi pemilik Operro.";
  return "Undangan belum dapat diproses karena gangguan sementara. Link Anda belum tentu bermasalah; coba lagi sebentar lagi.";
}

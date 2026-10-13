/**
 * Function index:
 * - DRILL_KINDS / DRILL_KIND_LABELS: the four kinds of drill the platform owner can record.
 * - validateDrillForm: display-only checks that mirror app.record_recovery_drill_with_evidence (the database repeats every rule).
 * - describeDrillError: plain-language mapping of database errors.
 * - describeEvidence: how a recorded drill's evidence is shown, always saying what a matching hash does NOT prove.
 *
 * Migration 20261101160000. A drill is a human-attested fact. The database can verify one thing only: that the archive manifest hash named in
 * the record is the hash of a completed export on this platform. That proves the archive existed, not that a restore happened, and an archive
 * drill can never be recorded as "passed" (it exercises no provider backup, Storage, Auth or secrets).
 */
export const DRILL_KINDS = ["provider_backup", "export_archive_dry_run", "guarded_archive_restore", "other"] as const;
export type DrillKind = (typeof DRILL_KINDS)[number];
export const DRILL_KIND_LABELS: Record<DrillKind, string> = {
  provider_backup: "A. Pemulihan backup penyedia ke proyek percobaan",
  export_archive_dry_run: "B. Uji kesiapan arsip (tanpa menulis database)",
  guarded_archive_restore: "C. Pemulihan arsip terpandu ke database percobaan",
  other: "Lainnya",
};
export const ARCHIVE_KINDS: readonly DrillKind[] = ["export_archive_dry_run", "guarded_archive_restore"];
const HASH = /^[0-9a-f]{64}$/;

export interface DrillFormInput { date: string; outcome: string; restoredTo: string; kind: string; manifestSha: string; reportSha: string; notes: string; evidenceRef: string; rpo: string; rto: string }
export interface DrillArgs {
  date: string; outcome: "passed" | "failed" | "partial"; restoredTo: string; kind: DrillKind; manifestSha: string | null; reportSha: string | null;
  notes: string | null; evidenceRef: string | null; rpo: number | null; rto: number | null;
}

const minutes = (value: string): number | null | undefined => (value.trim() === "" ? null : /^[0-9]{1,6}$/.test(value.trim()) ? Number(value.trim()) : undefined);

export function validateDrillForm(input: DrillFormInput, today: string): { ok: true; args: DrillArgs } | { ok: false; message: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || input.date > today) return { ok: false, message: "Tanggal uji tidak valid atau di masa depan." };
  if (!["passed", "failed", "partial"].includes(input.outcome)) return { ok: false, message: "Hasil tidak valid." };
  if (!["disposable_project", "staging_project", "other"].includes(input.restoredTo)) return { ok: false, message: "Tujuan pemulihan tidak valid." };
  if (!(DRILL_KINDS as readonly string[]).includes(input.kind)) return { ok: false, message: "Jenis uji tidak valid." };
  const kind = input.kind as DrillKind;
  const archive = ARCHIVE_KINDS.includes(kind);
  if (archive && input.outcome === "passed") return { ok: false, message: "Uji arsip tidak dapat dicatat sebagai lulus: ia tidak menguji backup penyedia, Storage, Auth, atau rahasia. Catat sebagai sebagian atau gagal." };
  const manifest = input.manifestSha.trim();
  const report = input.reportSha.trim();
  if (archive !== (manifest !== "")) return { ok: false, message: archive ? "Uji arsip memerlukan hash manifes arsip (64 karakter hex huruf kecil)." : "Hash arsip hanya untuk uji arsip." };
  if ((kind === "guarded_archive_restore") !== (report !== "")) return { ok: false, message: kind === "guarded_archive_restore" ? "Pemulihan terpandu memerlukan hash laporan (reportSha256)." : "Hash laporan hanya untuk pemulihan arsip terpandu." };
  if ((manifest !== "" && !HASH.test(manifest)) || (report !== "" && !HASH.test(report))) return { ok: false, message: "Hash harus tepat 64 karakter hex huruf kecil." };
  const rpo = minutes(input.rpo);
  const rto = minutes(input.rto);
  if (rpo === undefined || rto === undefined) return { ok: false, message: "RPO dan RTO berupa menit (angka bulat, maksimal 525600)." };
  if ((rpo !== null && rpo > 525600) || (rto !== null && rto > 525600)) return { ok: false, message: "RPO dan RTO berupa menit (angka bulat, maksimal 525600)." };
  if (input.notes.length > 500 || input.evidenceRef.length > 300) return { ok: false, message: "Catatan maksimal 500 dan referensi maksimal 300 karakter." };
  return {
    ok: true,
    args: { date: input.date, outcome: input.outcome as DrillArgs["outcome"], restoredTo: input.restoredTo, kind, manifestSha: manifest || null, reportSha: report || null, notes: input.notes.trim() || null, evidenceRef: input.evidenceRef.trim() || null, rpo, rto },
  };
}

export function describeDrillError(error: { code?: string; message?: string }): string {
  const message = error.message ?? "";
  if (error.code === "42501") return "Hanya pemilik platform Operro yang dapat mencatat uji pemulihan.";
  if (/credential_like_text/.test(message)) return "Catatan atau referensi tampak memuat kredensial. Hapus kata sandi, token, atau connection string.";
  if (/archive_drill_cannot_pass/.test(message)) return "Uji arsip tidak dapat dicatat sebagai lulus. Catat sebagai sebagian atau gagal.";
  if (/invalid_drill_evidence/.test(message)) return "Bukti tidak valid: uji arsip memerlukan hash manifes (dan pemulihan terpandu juga hash laporan), selain itu tidak boleh ada hash.";
  if (error.code === "PGRST202" || error.code === "42883") return "Fitur bukti uji belum tersedia di database yang terhubung (migrasi 20261101160000 belum diterapkan).";
  return "Data uji pemulihan tidak valid.";
}

export function describeEvidence(kind: string | null | undefined, matches: boolean | null | undefined): string {
  if (!kind) return "Catatan lama tanpa jenis uji dan tanpa bukti hash.";
  if (matches === true) return "Hash manifes sama dengan hash export selesai di platform ini. Itu membuktikan arsipnya ada, bukan bahwa pemulihan terjadi; uji tetap pernyataan pemilik platform.";
  if (matches === false) return "Hash manifes TIDAK sama dengan export selesai mana pun di platform ini: periksa kembali hash yang dicatat.";
  return "Tanpa hash arsip (bukan uji arsip).";
}

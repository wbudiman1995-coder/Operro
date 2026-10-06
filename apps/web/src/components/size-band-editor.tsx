"use client";

import { useMemo, useRef, useState, useTransition } from "react";

import { archiveSizeBandAction, deleteSizeBandAction, previewSizeLayoutAction, saveSizeBandsAction, setSizeBandModeAction, type SizeBandActionResult } from "@/app/catalog/actions";
import {
  LAYOUT_ISSUE_TEXT, MAX_ACTIVE_DOG_BANDS, activeDogBands, addTopBand, archivedDogBands, describeImpact, draftFromBands, draftToPayload, moveBand,
  previewDraftLabel, rangeLabel, validateLayoutDraft, type LayoutDraftRow, type LayoutImpact, type SizeBand,
} from "@/lib/size-bands";

type Row = LayoutDraftRow & { uid: number };
type Status = { kind: "ok" | "error"; text: string } | null;

const field = "h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm outline-none focus:border-emerald-600 focus:ring-4 focus:ring-emerald-500/15";
const smallButton = "min-h-10 rounded-lg border border-slate-300 bg-white px-3 text-xs font-bold text-slate-700 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-700 disabled:opacity-50";

function withUids(rows: LayoutDraftRow[], start: number): Row[] { return rows.map((row, index) => ({ ...row, uid: start + index })); }

/** Read-only summary for members who may see, but not change, the layout. */
export function SizeBandSummary({ bands }: { bands: SizeBand[] }) {
  const dogs = activeDogBands(bands);
  return <section id="batas-ukuran" aria-labelledby="size-summary-title" className="mt-7 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
    <h2 id="size-summary-title" className="font-bold">Kategori ukuran anjing</h2>
    <p className="mt-1 text-xs leading-5 text-slate-500">Kategori mengikuti berat anjing. Hanya pemilik bisnis yang dapat mengubahnya.</p>
    <ul className="mt-3 grid gap-2 sm:grid-cols-2">{dogs.map((band) => <li key={band.id} className="rounded-xl border border-slate-200 px-3 py-2 text-sm"><strong>{band.label}</strong><span className="ml-2 text-xs text-slate-500">{rangeLabel(bands, band.key)}</span></li>)}</ul>
  </section>;
}

/** Platform-only switch for the selected tenant. The database re-checks the role, the tenant and the version. */
export function SizeBandModeControl({ mode, layoutVersion }: { mode: "legacy" | "dynamic"; layoutVersion: number }) {
  const [pending, start] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [status, setStatus] = useState<Status>(null);
  const target = mode === "dynamic" ? "legacy" : "dynamic";
  return <section aria-labelledby="size-mode-title" className="mt-7 rounded-3xl border border-indigo-200 bg-indigo-50 p-5 sm:p-7">
    <h2 id="size-mode-title" className="font-bold text-indigo-950">Mode kategori ukuran (khusus platform)</h2>
    <p className="mt-1 text-xs leading-5 text-indigo-900">Saat ini: <strong>{mode === "dynamic" ? "dinamis (pemilik dapat menambah/mengubah kategori)" : "batas lama XS/S/M/L/XL"}</strong>. Pemilik bisnis tidak dapat mengaktifkan mode ini sendiri. Kembali ke mode lama hanya bisa jika kategori masih XS/S/M/L/XL.</p>
    {confirming
      ? <div className="mt-3 flex flex-wrap items-center gap-2"><span className="text-xs font-semibold">Ubah ke mode {target === "dynamic" ? "dinamis" : "lama"}?</span>
          <button type="button" disabled={pending} className={smallButton} onClick={() => start(async () => { const result = await setSizeBandModeAction({ version: layoutVersion, mode: target }); setStatus(result.ok ? { kind: "ok", text: result.message } : { kind: "error", text: result.error }); setConfirming(false); })}>{pending ? "Memproses…" : "Ya, ubah"}</button>
          <button type="button" className={smallButton} onClick={() => setConfirming(false)}>Batal</button></div>
      : <button type="button" className={`${smallButton} mt-3`} onClick={() => setConfirming(true)}>{target === "dynamic" ? "Aktifkan mode dinamis" : "Kembali ke mode lama"}</button>}
    {status ? <p role={status.kind === "error" ? "alert" : "status"} className={`mt-3 text-xs font-semibold ${status.kind === "error" ? "text-rose-700" : "text-emerald-800"}`}>{status.text}</p> : null}
  </section>;
}

/**
 * Owner/platform editor for the dynamic dog-size layout. Keys are never shown or editable
 * (the database generates them). All validation is advisory here and repeated in SQL.
 */
export function SizeBandEditor({ bands, layoutVersion }: { bands: SizeBand[]; layoutVersion: number }) {
  const nextUid = useRef(1000);
  const [rows, setRows] = useState<Row[]>(() => withUids(draftFromBands(bands), 0));
  const [impact, setImpact] = useState<{ payload: string; lines: string[]; blocking: boolean; newBands: Array<{ key: string; label: string }> } | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [status, setStatus] = useState<Status>(null);
  const [pending, start] = useTransition();
  const [confirmArchive, setConfirmArchive] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);

  const issues = useMemo(() => validateLayoutDraft(rows), [rows]);
  const payload = useMemo(() => (issues.length ? "" : JSON.stringify(draftToPayload(rows))), [issues, rows]);
  const previewCurrent = impact !== null && impact.payload === payload;
  const archived = archivedDogBands(bands);
  const sampleWeights = [3, 8, 12, 20, 25, 25.01, 40];

  const patch = (uid: number, change: Partial<LayoutDraftRow>) => { setRows((current) => current.map((row) => row.uid === uid ? { ...row, ...change } : row)); setConfirmed(false); };
  const announce = (next: Status) => { setStatus(next); queueMicrotask(() => statusRef.current?.focus()); };
  /** Labels as the owner will see them after saving: draft names for kept bands, server-generated keys for new ones. */
  const summarize = (result: Extract<SizeBandActionResult, { ok: true }>) => {
    const labels = new Map<string, string>(bands.map((band) => [band.key, band.label]));
    for (const row of rows) { const kept = bands.find((band) => band.id === row.id); if (kept) labels.set(kept.key, row.label.trim()); }
    for (const created of result.newBands) labels.set(created.key, created.label);
    return result.impact ? describeImpact(result.impact as LayoutImpact, (key) => (key ? labels.get(key) ?? key : "")) : [];
  };

  const runPreview = () => start(async () => {
    const result = await previewSizeLayoutAction({ bands: JSON.parse(payload) });
    if (!result.ok) { announce({ kind: "error", text: result.error }); setImpact(null); return; }
    setImpact({ payload, lines: summarize(result), blocking: (result.impact?.packageConflicts ?? 0) > 0, newBands: result.newBands });
    setConfirmed(false); announce({ kind: "ok", text: "Pratinjau dampak siap. Baca ringkasannya sebelum menyimpan." });
  });
  const runSave = () => start(async () => {
    const result = await saveSizeBandsAction({ version: layoutVersion, bands: JSON.parse(payload) });
    if (!result.ok) { announce({ kind: "error", text: result.error }); return; }
    announce({ kind: "ok", text: result.message }); setImpact(null); setConfirmed(false);
  });
  const runArchive = (band: Row) => start(async () => {
    if (!band.id) return;
    const result = await archiveSizeBandAction({ version: layoutVersion, bandId: band.id });
    setConfirmArchive(null);
    announce(result.ok ? { kind: "ok", text: result.message } : { kind: "error", text: result.error });
  });
  const runDelete = (band: SizeBand) => start(async () => {
    const result = await deleteSizeBandAction({ version: layoutVersion, bandId: band.id });
    setConfirmDelete(null);
    announce(result.ok ? { kind: "ok", text: result.message } : { kind: "error", text: result.error });
  });

  return <section id="batas-ukuran" aria-labelledby="size-editor-title" className="mt-7 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
    <h2 id="size-editor-title" className="font-bold">Kategori ukuran anjing (dinamis)</h2>
    <p className="mt-1 text-xs leading-5 text-slate-500">Rentang berat selalu menyambung tanpa celah: batas atas satu kategori adalah awal kategori berikutnya, dan kategori teratas tidak punya batas atas. Maksimal {MAX_ACTIVE_DOG_BANDS} kategori; Cat selalu terpisah dan tidak dihitung. Kategori baru memakai harga dasar layanan sampai harga per ukuran diisi pada bagian harga di bawah.</p>
    <form className="mt-4" onSubmit={(event) => { event.preventDefault(); if (!issues.length) runPreview(); }} aria-describedby="size-editor-help">
      <p id="size-editor-help" className="sr-only">Ubah nama dan batas kg tiap kategori, lalu pratinjau dampak sebelum menyimpan.</p>
      <ol className="space-y-3">
        {rows.map((row, index) => {
          const last = index === rows.length - 1;
          const rowIssues = issues.filter((issue) => issue.row === index);
          const lower = index > 0 ? rows[index - 1] : null;
          return <li key={row.uid}>
            <fieldset className="min-w-0 rounded-2xl border border-slate-200 p-3 sm:p-4">
              <legend className="px-1 text-xs font-bold text-slate-600">Kategori {index + 1}{row.id === null ? " (baru)" : ""}</legend>
              <div className="grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,9rem)_auto] sm:items-end">
                <label className="block min-w-0 text-xs font-semibold text-slate-700">Nama kategori
                  <input className={`${field} mt-1`} value={row.label} maxLength={40} onChange={(event) => patch(row.uid, { label: event.target.value })} aria-invalid={rowIssues.some((issue) => issue.code === "label" || issue.code === "duplicate_label")} /></label>
                {last
                  ? <p className="min-w-0 text-xs text-slate-600 sm:pb-2">Tanpa batas atas{lower && lower.upper ? ` (di atas ${lower.upper} kg)` : ""}</p>
                  : <label className="block min-w-0 text-xs font-semibold text-slate-700">Sampai berat (kg)
                      <input className={`${field} mt-1`} type="number" inputMode="decimal" min="0.01" max="999" step="0.01" value={row.upper} onChange={(event) => patch(row.uid, { upper: event.target.value })} aria-invalid={rowIssues.some((issue) => issue.code === "upper" || issue.code === "order" || issue.code === "decimals")} /></label>}
                <div className="flex flex-wrap gap-2 sm:justify-end">
                  <button type="button" className={smallButton} onClick={() => { setRows((current) => moveBand(current, index, -1)); setConfirmed(false); }} disabled={index === 0} aria-label={`Naikkan ${row.label || `kategori ${index + 1}`}: tukar rentang dengan kategori di atasnya`}>↑</button>
                  <button type="button" className={smallButton} onClick={() => { setRows((current) => moveBand(current, index, 1)); setConfirmed(false); }} disabled={last} aria-label={`Turunkan ${row.label || `kategori ${index + 1}`}: tukar rentang dengan kategori di bawahnya`}>↓</button>
                  {row.id === null
                    ? <button type="button" className={smallButton} onClick={() => { setRows((current) => current.filter((item) => item.uid !== row.uid)); setConfirmed(false); }}>Hapus baris</button>
                    : <button type="button" className={`${smallButton} text-rose-700`} disabled={rows.length <= 1 || pending} onClick={() => setConfirmArchive(row.id)}>Arsipkan</button>}
                </div>
              </div>
              {!last ? <label className="mt-3 flex items-center gap-2 text-xs text-slate-700"><input type="checkbox" checked={row.inclusive} onChange={(event) => patch(row.uid, { inclusive: event.target.checked })} />Berat tepat di batas atas masuk kategori ini (≤). Jika tidak dicentang, masuk kategori berikutnya (&lt;).</label> : null}
              {rowIssues.length ? <ul className="mt-2 space-y-1 text-xs font-semibold text-rose-700">{rowIssues.map((issue) => <li key={issue.code}>{LAYOUT_ISSUE_TEXT[issue.code]}</li>)}</ul> : null}
              {confirmArchive === row.id && row.id ? <div role="alertdialog" aria-label={`Arsipkan ${row.label}`} className="mt-3 rounded-xl bg-rose-50 p-3 text-xs text-rose-900">
                <p>Arsipkan <strong>{row.label}</strong>? Rentang beratnya diserap kategori terdekat, anjing terukur dipindahkan otomatis, dan riwayat lama tetap terbaca. Ditolak jika masih ada anjing berukuran manual (tanpa berat), paket yang masih dijual, atau paket aktif yang tidak cocok.</p>
                <div className="mt-2 flex gap-2"><button type="button" className={smallButton} disabled={pending} onClick={() => runArchive(row)}>{pending ? "Memproses…" : "Ya, arsipkan"}</button><button type="button" className={smallButton} onClick={() => setConfirmArchive(null)}>Batal</button></div></div> : null}
            </fieldset>
          </li>;
        })}
      </ol>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" className={smallButton} disabled={rows.length >= MAX_ACTIVE_DOG_BANDS} onClick={() => { setRows((current) => addTopBand(current, (label) => ({ id: null, label, upper: "", inclusive: false, uid: nextUid.current++ }), "")); setConfirmed(false); }}>+ Tambah kategori di atas</button>
        <span className="text-xs text-slate-500">{rows.length} dari {MAX_ACTIVE_DOG_BANDS} kategori</span>
      </div>
      {issues.length === 0 ? <p className="mt-3 text-xs text-slate-600" aria-label="Contoh penempatan">Contoh: {sampleWeights.map((weight) => `${weight} kg → ${previewDraftLabel(rows, weight) ?? "-"}`).join(" · ")}</p> : null}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending || issues.length > 0} className="rounded-lg border border-emerald-700 px-4 py-2 text-xs font-bold text-emerald-800 disabled:opacity-50">{pending ? "Menghitung…" : "Pratinjau dampak"}</button>
      </div>
      {previewCurrent && impact ? <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-4" aria-live="polite">
        <h3 className="text-xs font-bold uppercase tracking-wide text-amber-900">Dampak perubahan</h3>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-amber-950">{impact.lines.map((line) => <li key={line}>{line}</li>)}{impact.newBands.length ? <li>Kategori baru {impact.newBands.map((band) => band.label).join(", ")} memakai harga dasar layanan sampai harga per ukuran diisi.</li> : null}<li>Booking, invoice, dan paket yang sudah ada tidak berubah.</li></ul>
        <label className="mt-3 flex items-start gap-2 text-xs font-semibold text-amber-950"><input type="checkbox" className="mt-0.5" checked={confirmed} disabled={impact.blocking} onChange={(event) => setConfirmed(event.target.checked)} />Saya sudah membaca dampak ini dan ingin menyimpannya.</label>
        <button type="button" disabled={pending || !confirmed || impact.blocking} onClick={runSave} className="mt-3 rounded-lg bg-emerald-700 px-4 py-2 text-xs font-bold text-white disabled:opacity-50">{pending ? "Menyimpan…" : "Simpan kategori ukuran"}</button>
      </div> : impact ? <p className="mt-3 text-xs text-slate-500">Isian berubah setelah pratinjau. Hitung ulang dampaknya sebelum menyimpan.</p> : null}
    </form>
    <p ref={statusRef} tabIndex={-1} role={status?.kind === "error" ? "alert" : "status"} aria-live="polite" className={`mt-3 text-xs font-semibold outline-none ${status?.kind === "error" ? "text-rose-700" : "text-emerald-800"}`}>{status?.text ?? ""}</p>
    {archived.length ? <details className="mt-5 rounded-2xl border border-slate-200 p-4">
      <summary className="cursor-pointer text-xs font-bold text-slate-700">Kategori diarsipkan ({archived.length})</summary>
      <ul className="mt-3 space-y-2">{archived.map((band) => <li key={band.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-slate-50 px-3 py-2 text-xs"><span><strong>{band.label}</strong><span className="ml-2 text-slate-500">hanya muncul di riwayat lama</span></span>
        {confirmDelete === band.id
          ? <span className="flex gap-2"><button type="button" className={smallButton} disabled={pending} onClick={() => runDelete(band)}>{pending ? "Memproses…" : "Ya, hapus permanen"}</button><button type="button" className={smallButton} onClick={() => setConfirmDelete(null)}>Batal</button></span>
          : <button type="button" className={`${smallButton} text-rose-700`} onClick={() => setConfirmDelete(band.id)} aria-label={`Hapus permanen ${band.label}`}>Hapus permanen</button>}</li>)}</ul>
      <p className="mt-2 text-[11px] text-slate-500">Hapus permanen hanya berhasil jika tidak ada hewan, paket, saldo, baris booking/invoice, payroll, atau harga yang masih memakai kategori ini.</p>
    </details> : null}
  </section>;
}

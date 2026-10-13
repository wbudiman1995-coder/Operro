import assert from "node:assert/strict";
import fs from "node:fs";
import Module from "node:module";
import path from "node:path";
import test, { before } from "node:test";

import { renderToStaticMarkup } from "react-dom/server";

import type { CustomFieldDefinition } from "../src/lib/custom-fields";

// Renders the real client components (no Next.js runtime) with Server Action modules stubbed and asserts on the
// markup. This is contract-level evidence only and is not a substitute for browser QC.
const STUBBED = new Set([
  "@/app/customers/[customerId]/custom-field-actions",
  "@/app/settings/custom-fields/actions",
  "@/app/settings/preferences/actions",
  "@/app/settings/storage/actions",
  "@/app/customers/[customerId]/actions",
  "@/app/whatsapp/actions",
  "@/app/settings/storage/cleanup-actions",
  "@/app/settings/health/actions",
]);
const inert = new Proxy({}, { get: (_target, name) => (name === "__esModule" ? true : name === "then" ? undefined : async () => ({ ok: false, error: null, success: null })) });
type ModuleLoader = (request: string, parent: unknown, isMain: boolean) => unknown;
const internals = Module as unknown as { _load: ModuleLoader };
const originalLoad = internals._load;

let editor: typeof import("../src/components/custom-field-editor");
let manager: typeof import("../src/components/custom-field-definition-manager");
let values: typeof import("../src/components/custom-field-values");
let landing: typeof import("../src/components/landing-preference-form");
let retention: typeof import("../src/components/evidence-retention-form");
let petEditor: typeof import("../src/components/customer-pet-editor");
let cashPanel: typeof import("../src/components/cash-position-panel");
let whatsapp: typeof import("../src/components/whatsapp-draft-center");
let cleanupPanel: typeof import("../src/components/storage-cleanup-panel");
let healthPanel: typeof import("../src/components/health-panel");
let drillForm: typeof import("../src/components/recovery-drill-form");

before(async () => {
  internals._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request === "server-only") return {};
    if (STUBBED.has(request)) return inert;
    return originalLoad.call(this, request, parent, isMain);
  };
  editor = await import("../src/components/custom-field-editor");
  manager = await import("../src/components/custom-field-definition-manager");
  values = await import("../src/components/custom-field-values");
  landing = await import("../src/components/landing-preference-form");
  retention = await import("../src/components/evidence-retention-form");
  petEditor = await import("../src/components/customer-pet-editor");
  cashPanel = await import("../src/components/cash-position-panel");
  whatsapp = await import("../src/components/whatsapp-draft-center");
  cleanupPanel = await import("../src/components/storage-cleanup-panel");
  healthPanel = await import("../src/components/health-panel");
  drillForm = await import("../src/components/recovery-drill-form");
});

const def = (id: string, fieldType: CustomFieldDefinition["fieldType"], extra: Partial<CustomFieldDefinition> = {}): CustomFieldDefinition => ({
  id, entityType: "customer", label: `Label ${id}`, fieldType, options: [], sortOrder: 0, status: "active", updatedAt: "2026-10-09T00:00:00Z", ...extra,
});

test("custom field editor renders each type, submits only cf_ keys and never an organization id", () => {
  const defs = [
    def("a1", "text"), def("a2", "number"), def("a3", "date"), def("a4", "boolean"),
    def("a5", "select", { options: [{ key: "o1", label: "Teman" }] }),
  ];
  const html = renderToStaticMarkup(<editor.CustomFieldEditor entityType="customer" entityId="e1" customerId="c1" definitions={defs} initial={{ a5: "o7" }} />);
  for (const id of ["a1", "a2", "a3", "a4", "a5"]) assert.match(html, new RegExp(`name="cf_${id}"`));
  assert.match(html, /type="date"/);
  assert.match(html, /Pilihan lama \(tidak lagi tersedia\)/, "a stored option that was removed is flagged, not silently dropped");
  assert.doesNotMatch(html, /organization/i);
});

test("custom field editor renders nothing when the business defined no fields", () => {
  assert.equal(renderToStaticMarkup(<editor.CustomFieldEditor entityType="pet" entityId="e1" customerId="c1" definitions={[]} initial={{}} />), "");
});

test("custom field values list skips empty fields (old records) and labels booleans", () => {
  const defs = [def("a1", "text"), def("a4", "boolean")];
  const none = renderToStaticMarkup(<values.CustomFieldValues definitions={defs} values={[]} />);
  assert.equal(none, "");
  const some = renderToStaticMarkup(<values.CustomFieldValues definitions={defs} values={[{ definitionId: "a4", customerId: "c", petId: null, text: null, number: null, date: null, boolean: true, option: null }]} />);
  assert.match(some, /Ya/);
  assert.doesNotMatch(some, /Label a1/);
});

test("definition manager separates scopes, explains archive and offers re-activation", () => {
  const html = renderToStaticMarkup(<manager.CustomFieldDefinitionManager definitions={[
    def("a1", "text", { label: "Instagram" }),
    def("a2", "select", { label: "Kanal", options: [{ key: "o1", label: "Teman" }] }),
    def("a3", "text", { label: "Lama", status: "archived", entityType: "pet" }),
  ]} />);
  assert.match(html, /Isian pelanggan/);
  assert.match(html, /Isian hewan/);
  assert.match(html, /Aktifkan kembali/);
  assert.match(html, /Nilai tersimpan dipertahankan/);
  assert.match(html, /tidak dapat diubah setelah dibuat/);
  assert.doesNotMatch(html, /name="organizationId"/);
});

test("landing preference form disables pages the role cannot open and explains a stale saved choice", () => {
  const html = renderToStaticMarkup(<landing.LandingPreferenceForm saved="finance" available={["dashboard", "schedule"]} />);
  assert.match(html, /Keuangan \(tidak tersedia untuk peran Anda\)/);
  assert.match(html, /tidak lagi tersedia untuk peran Anda/);
  assert.match(html, /milik akun Anda saja/);
  assert.doesNotMatch(html, /name="(?:userId|organizationId)"/);
  const ok = renderToStaticMarkup(<landing.LandingPreferenceForm saved="schedule" available={["dashboard", "schedule", "finance"]} />);
  assert.doesNotMatch(ok, /tidak lagi tersedia/);
});

test("evidence retention form is editable for the owner and read-only otherwise, and says it is not retroactive", () => {
  const owner = renderToStaticMarkup(<retention.EvidenceRetentionForm days={90} canEdit />);
  assert.match(owner, /name="days"/);
  assert.match(owner, /value="90"/);
  assert.match(owner, /Simpan/);
  assert.match(owner, /foto yang sudah ada tidak berubah/);
  const other = renderToStaticMarkup(<retention.EvidenceRetentionForm days={90} canEdit={false} />);
  assert.match(other, /disabled/);
  assert.match(other, /Hanya pemilik bisnis/);
  assert.doesNotMatch(other, /Simpan/);
});

test("pet editor offers the HomePaw coat options, skin history, and no editable visit counter", () => {
  const html = renderToStaticMarkup(<petEditor.CustomerPetEditor customerId="c" petId="p" updatedAt="2026-10-09T00:00:00Z" currentSizeLabel="S"
    petTypes={[{ key: "dog", label: "Anjing" }]} dogBands={[]}
    defaults={{ name: "Moka", species: "dog", breed: "", sex: "female", birthdate: "", weightKg: "7", manualSize: "", color: "", temperament: "", notes: "", coatType: "curly", skinHistory: "kutu" }} />);
  for (const label of ["Pendek", "Panjang", "Keriting", "Double coat"]) assert.match(html, new RegExp(label));
  assert.match(html, /name="coatType"/);
  assert.match(html, /name="skinHistory"/);
  assert.doesNotMatch(html, /name="(?:washCount|visitCount|completedJobs)"/);
});

const cashRow = (currency: string, extra: Record<string, number> = {}) => ({
  period: "2026-10", currency, paymentsIn: 1000, paymentsCount: 2, refundsOut: 100, refundsCount: 1, expensesOut: 300, expensesCount: 1, net: 600, excludedPayments: 0, ...extra,
});

test("cash panel keeps currencies apart, labels itself read-only/not a ledger, and says so when a period is empty", () => {
  const html = renderToStaticMarkup(<cashPanel.CashPositionPanel period={{ from: "2026-10-01", to: "2026-10-31" }} timeZone="Asia/Jakarta" rows={[cashRow("IDR"), cashRow("USD", { net: -5, excludedPayments: 2 })]} exportHref="/finance/export?from=2026-10-01&to=2026-10-31" />);
  assert.match(html, /Posisi kas \(laporan baca-saja\)/);
  assert.match(html, /bukan buku besar akuntansi/);
  assert.match(html, /IDR · selisih periode/);
  assert.match(html, /USD · selisih periode/);
  assert.match(html, /2 pembayaran tertunda\/gagal/);
  assert.match(html, /href="\/finance\/export\?from=2026-10-01/);
  const empty = renderToStaticMarkup(<cashPanel.CashPositionPanel period={{ from: "2026-01-01", to: "2026-01-31" }} timeZone="UTC" rows={[]} />);
  assert.match(empty, /Tidak ada pembayaran, pengembalian dana, atau pengeluaran/);
  assert.doesNotMatch(empty, /<table/);
  const bad = renderToStaticMarkup(<cashPanel.CashPositionPanel period={{ from: "", to: "" }} timeZone="UTC" rows={null} error="Tanggal harus berformat YYYY-MM-DD." />);
  assert.match(bad, /role="alert"/);
});

const draft = (extra: Record<string, unknown> = {}) => ({
  id: "d1", sourceType: "invoice", sourceId: "i1", customerId: "c1", customerName: "Ani", recipientPhone: "6281234567890", messageText: "Halo Ani, invoice INV-1",
  status: "draft", statusNote: null, statusChangedAt: "2026-10-09T00:00:00Z", statusChangedBy: null, createdAt: "2026-10-09T00:00:00Z",
  health: { optedOut: false, customerArchived: false, phoneChanged: false }, ...extra,
});

test("WhatsApp draft rows: open link only when allowed, never claim delivery, block opted-out/archived", () => {
  const ok = renderToStaticMarkup(<whatsapp.DraftRow draft={draft() as never} canManageContacts />);
  assert.match(ok, /href="https:\/\/wa\.me\/6281234567890\?text=/);
  assert.match(ok, /Buka di WhatsApp/);
  assert.match(ok, /Tandai terkirim/);
  assert.match(ok, /bukan konfirmasi dari WhatsApp/);
  assert.match(ok, /Pelanggan berhenti menerima pesan/);
  assert.doesNotMatch(ok, /Terkirim ke|Delivered|Dibaca|Terkirim\b(?! oleh)/);
  const optedOut = renderToStaticMarkup(<whatsapp.DraftRow draft={draft({ health: { optedOut: true, customerArchived: false, phoneChanged: false } }) as never} canManageContacts />);
  assert.doesNotMatch(optedOut, /wa\.me/);
  assert.doesNotMatch(optedOut, /Tandai terkirim/);
  assert.match(optedOut, /tidak dapat dibuka atau ditandai terkirim; masih dapat dibatalkan/);
  assert.match(optedOut, /Batalkan/);
  assert.match(optedOut, /Izinkan pelanggan ini menerima draf lagi/);
  const archived = renderToStaticMarkup(<whatsapp.DraftRow draft={draft({ health: { optedOut: false, customerArchived: true, phoneChanged: false } }) as never} canManageContacts={false} />);
  assert.match(archived, /Pelanggan sudah diarsipkan/);
  assert.doesNotMatch(archived, /wa\.me|Pelanggan berhenti menerima pesan"/);
  const sent = renderToStaticMarkup(<whatsapp.DraftRow draft={draft({ status: "marked_sent" }) as never} canManageContacts />);
  assert.match(sent, /Ditandai terkirim oleh pengguna/);
  assert.doesNotMatch(sent, /Batalkan|Tandai gagal|Coba lagi|wa\.me/);
  const failed = renderToStaticMarkup(<whatsapp.DraftRow draft={draft({ status: "failed" }) as never} canManageContacts />);
  assert.match(failed, /Coba lagi/);
  const onboarding = renderToStaticMarkup(<whatsapp.DraftRow draft={draft({ sourceType: "onboarding", customerId: null, customerName: null, recipientPhone: null, messageText: "Halo! link [disembunyikan]" }) as never} canManageContacts />);
  assert.match(onboarding, /Tautan sekali pakai tidak disimpan/);
  assert.doesNotMatch(onboarding, /wa\.me/);
  const missingPhone = renderToStaticMarkup(<whatsapp.CreateDraftButton sourceType="followup" sourceId="c1" disabledReason="Nomor WhatsApp tidak tersedia" />);
  assert.match(missingPhone, /disabled/);
  assert.match(missingPhone, /Nomor WhatsApp tidak tersedia/);
});

test("storage cleanup panel: dry-run first, explicit about deletion, no sizes or prices, owner-only apply", () => {
  const runs = [
    { id: "r1", mode: "dry_run", status: "completed", candidateCount: 3, skippedCount: 0, deletedCount: 0, missingCount: 0, failedCount: 0, startedAt: "2026-10-09T00:00:00Z", finishedAt: "2026-10-09T00:00:01Z" },
    { id: "r2", mode: "apply", status: "partial", candidateCount: 3, skippedCount: 1, deletedCount: 1, missingCount: 0, failedCount: 1, startedAt: "2026-10-08T00:00:00Z", finishedAt: null },
  ] as never;
  const html = renderToStaticMarkup(<cleanupPanel.StorageCleanupPanel runs={runs} canPreview canApply />);
  assert.match(html, /Buat pratinjau \(dry-run\)/);
  assert.match(html, /pratinjau tidak menghapus apa pun/);
  assert.match(html, /ditandai terlebih dahulu sebelum file dihapus/);
  assert.match(html, /Pratinjau \(dry-run\)<\/strong> · Selesai · 3 objek terdaftar, tidak ada yang dihapus/);
  assert.match(html, /Sebagian \(ada yang perlu dicoba lagi\)/);
  assert.doesNotMatch(html, /Jalankan pembersihan sesuai pratinjau/, "no apply button before a preview exists");
  assert.doesNotMatch(html, /Rp\b|\bGB\b|\bMB\b|harga|tagihan/i);
  const none = renderToStaticMarkup(<cleanupPanel.StorageCleanupPanel runs={[]} canPreview={false} canApply={false} />);
  assert.match(none, /Hanya pengelola pengaturan yang dapat membuat pratinjau/);
  assert.match(none, /Belum ada proses/);
});

// The fixture follows the newest migration so that adding a migration never needs an edit here (health-recovery.test.ts pins EXPECTED_SCHEMA_VERSION).
const newestMigration = fs.readdirSync(path.join(import.meta.dirname, "../../../supabase/migrations")).filter((name) => /^\d{14}_.+\.sql$/.test(name)).sort().pop()!.slice(0, 14);
const healthy = {
  schema_version: newestMigration, generated_at: "2026-10-09T00:00:00Z",
  exports: { failed_30d: 0, stale_running: 0, last_completed_at: null, last_failure_at: null },
  cleanup: { problem_runs_30d: 0, stale_running: 0, last_apply_status: null, last_apply_at: null, pending_objects: 0 },
  capacity_requests: { pending: 0, oldest_pending_at: null, stale_pending: 0 },
};
const unavailableCount = { count: null, capped: false, note: "Memerlukan izin payroll." };
const zeroCount = { count: 0, capped: false, note: null };

test("health panel: never claims recovery is proven, shows missing provider coverage, and shows 'unavailable' instead of zero", async () => {
  const { deriveReadiness } = await import("../src/lib/health");
  const recovery = { drills_recorded: 0, last_drill_date: null, last_outcome: null, last_passed_date: null, detail: null };
  const reconciliation = { unbilledVisits: zeroCount, invoicePayments: zeroCount, payrollSources: unavailableCount };
  const readiness = deriveReadiness(healthy as never, recovery as never, reconciliation as never, new Date("2026-10-09T00:00:00Z"));
  const html = renderToStaticMarkup(<healthPanel.HealthPanel summary={healthy as never} recovery={recovery as never} reconciliation={reconciliation as never} readiness={readiness} version="0.1.0 (abc1234)" platform={false} />);
  assert.match(html, /Pemulihan belum terbukti/);
  assert.match(html, /bukan cadangan yang terbukti dapat dipulihkan/);
  assert.match(html, /tidak dibaca oleh aplikasi ini/);
  assert.match(html, /Memerlukan izin payroll\./);
  assert.match(html, /0\.1\.0 \(abc1234\)/);
  assert.match(html, /\(sesuai aplikasi\)/);
  assert.doesNotMatch(html, /fetch|api\.vercel|Rp\b|IDR|harga/);
  assert.doesNotMatch(html, /Pemulihan ke:/, "tenant owners never see platform drill detail");
  const platform = renderToStaticMarkup(<healthPanel.HealthPanel summary={{ ...healthy, platform: { pending_capacity_requests: 2, oldest_pending_capacity_request_at: null, failed_exports_30d: 1, problem_cleanup_runs_30d: 0 } } as never}
    recovery={{ drills_recorded: 1, last_drill_date: "2026-10-05", last_outcome: "passed", last_passed_date: "2026-10-05", detail: { restored_to: "disposable_project", rpo_minutes: 15, rto_minutes: 90, notes: "ok", evidence_ref: "TKT-1", recorded_at: "2026-10-05T00:00:00Z" } } as never}
    reconciliation={{ unbilledVisits: { count: 100, capped: true, note: null }, invoicePayments: zeroCount, payrollSources: zeroCount } as never}
    readiness={deriveReadiness(healthy as never, { drills_recorded: 1, last_drill_date: "2026-10-05", last_outcome: "passed", last_passed_date: "2026-10-05", detail: null } as never, { unbilledVisits: { count: 100, capped: true, note: null }, invoicePayments: zeroCount, payrollSources: zeroCount } as never, new Date("2026-10-09T00:00:00Z"))}
    version="0.1.0" platform />);
  assert.match(platform, /Uji pemulihan lulus pada 2026-10-05/);
  assert.match(platform, /bukan jaminan/);
  assert.match(platform, /Pemulihan ke: <\/dt><dd class="inline">disposable_project/);
  assert.match(platform, /TKT-1/);
  assert.match(platform, /100\+/);
  assert.match(platform, /Seluruh platform \(hanya jumlah\): 2 permintaan kapasitas/);
});

test("recovery drill form warns against credentials and states that records are permanent", () => {
  const html = renderToStaticMarkup(<drillForm.RecoveryDrillForm />);
  assert.match(html, /Jangan tulis kata sandi, token, atau connection string/);
  assert.match(html, /bersifat permanen/);
  assert.match(html, /Proyek percobaan sekali pakai/);
  assert.doesNotMatch(html, /organization/i);
});

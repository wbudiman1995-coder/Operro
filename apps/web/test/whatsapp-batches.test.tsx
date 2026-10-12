import assert from "node:assert/strict";
import fs from "node:fs";
import Module from "node:module";
import path from "node:path";
import test, { before } from "node:test";

import { renderToStaticMarkup } from "react-dom/server";

import { CAPABILITY_KEYS, type CapabilityMap } from "../src/lib/authorization";
import {
  BATCH_LIMIT, canBatchSource, describeSkipReason, isBatchSource, loadBatch, loadBatches, loadDraftEvents, summarizeStatuses, SKIP_REASON_LABELS,
} from "../src/lib/whatsapp-batches";
import type { WhatsAppDraftRow } from "../src/lib/whatsapp-draft-data";

const root = path.resolve(import.meta.dirname, "../../..");
const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");
const caps = (...granted: (keyof CapabilityMap)[]): CapabilityMap => {
  const map = Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, false])) as CapabilityMap;
  for (const key of granted) map[key] = true;
  return map;
};

// Real client components render without the Next.js runtime; Server Action modules are stubbed (contract-level evidence).
const STUBBED = new Set(["@/app/whatsapp/batch-actions", "@/app/whatsapp/actions"]);
const inert = new Proxy({}, { get: (_target, name) => (name === "__esModule" ? true : name === "then" ? undefined : async () => ({ error: null, success: null })) });
type ModuleLoader = (request: string, parent: unknown, isMain: boolean) => unknown;
const internals = Module as unknown as { _load: ModuleLoader };
const originalLoad = internals._load;
let builder: typeof import("../src/lib/whatsapp-message-build");
let BatchComposer: typeof import("../src/components/whatsapp-batch-composer").BatchComposer;
let CancelBatchButton: typeof import("../src/components/whatsapp-batch-composer").CancelBatchButton;
let DraftRow: typeof import("../src/components/whatsapp-draft-center").DraftRow;
before(async () => {
  internals._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request === "server-only") return {};
    if (STUBBED.has(request)) return inert;
    return originalLoad.call(this, request, parent, isMain);
  };
  builder = await import("../src/lib/whatsapp-message-build");
  ({ BatchComposer, CancelBatchButton } = await import("../src/components/whatsapp-batch-composer"));
  ({ DraftRow } = await import("../src/components/whatsapp-draft-center"));
});

/** A chainable fake that records filters and applies a canned result. */
function fakeClient(tables: Record<string, Array<Record<string, unknown>>>, rpc: Record<string, unknown> = {}) {
  const log: string[] = [];
  const from = (table: string) => {
    let rows = [...(tables[table] ?? [])];
    const b: Record<string, unknown> = {
      select: () => b,
      eq: (column: string, value: unknown) => { log.push(`${table}.eq(${column})`); rows = rows.filter((r) => r[column] === value); return b; },
      is: (column: string, value: unknown) => { rows = rows.filter((r) => (r[column] ?? null) === value); return b; },
      in: (column: string, values: unknown[]) => { log.push(`${table}.in(${column},${values.length})`); rows = rows.filter((r) => values.includes(r[column])); return b; },
      or: (filter: string) => { log.push(`${table}.or(${filter})`); return b; },
      order: () => b, limit: (n: number) => { log.push(`${table}.limit(${n})`); rows = rows.slice(0, n); return b; },
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      then: (resolve: (value: unknown) => void) => resolve({ data: rows, error: null }),
    };
    return b;
  };
  return { log, from, schema: () => ({ rpc: async (name: string) => ({ data: rpc[name] ?? null, error: null }) }) };
}

const draft = (extra: Partial<WhatsAppDraftRow> = {}): WhatsAppDraftRow => ({
  id: "d1", sourceType: "invoice", sourceId: "s1", customerId: "c1", customerName: "Ani", recipientPhone: "6281234567890", messageText: "Halo Ani",
  status: "draft", statusNote: null, statusChangedAt: "2026-10-12T01:00:00Z", statusChangedBy: null, createdAt: "2026-10-12T01:00:00Z",
  health: { optedOut: false, customerArchived: false, phoneChanged: false }, ...extra,
});

test("source rules mirror the database: three batchable sources, onboarding never, capability per source", () => {
  assert.equal(isBatchSource("invoice"), true);
  for (const bad of ["onboarding", "sms", "", null, 5]) assert.equal(isBatchSource(bad), false, String(bad));
  assert.equal(canBatchSource("invoice", caps("finance.read")), true);
  assert.equal(canBatchSource("invoice", caps("customer.read", "membership.read")), false);
  assert.equal(canBatchSource("followup", caps("customer.read")), true);
  assert.equal(canBatchSource("renewal", caps("membership.read")), true);
  assert.equal(canBatchSource("renewal", caps("customer.manage")), false);
  assert.equal(BATCH_LIMIT, 25);
});

test("every database skip reason has plain wording and unknown reasons never leak raw codes", () => {
  for (const reason of ["recipient_opted_out", "recipient_phone_missing", "source_archived", "source_not_found", "already_in_queue", "duplicate_in_request", "invalid_message", "invalid_item"]) {
    assert.ok(SKIP_REASON_LABELS[reason], reason);
    assert.doesNotMatch(describeSkipReason(reason), /_/);
  }
  assert.equal(describeSkipReason("something_new"), "Tidak dapat dibuat");
  assert.equal(describeSkipReason(null), "Tidak dapat dibuat");
});

test("status summary counts every state once and never invents a delivered/read state", () => {
  const counts = summarizeStatuses([{ status: "draft" }, { status: "draft" }, { status: "marked_sent" }, { status: "failed" }]);
  assert.deepEqual(counts, { draft: 2, opened: 0, marked_sent: 1, failed: 1, canceled: 0 });
  assert.deepEqual(Object.keys(counts).sort(), ["canceled", "draft", "failed", "marked_sent", "opened"]);
});

test("batch history is keyset-paged, tenant-filtered and shows actor names; the log keeps order and drops unknown states", async () => {
  const rows = Array.from({ length: 21 }, (_, i) => ({ id: `b${String(i).padStart(2, "0")}`, organization_id: "org", source_type: "invoice", status: "open", draft_count: 3, existing_count: 0, skipped_count: 1, canceled_count: 0, created_by: "u1", created_at: `2026-10-${String(20 - i).padStart(2, "0")}T00:00:00Z`, canceled_by: null, canceled_at: null }));
  const client = fakeClient({ whatsapp_batches: rows, users: [{ id: "u1", full_name: "Budi", email: "b@x" }] });
  const page = await loadBatches(client as never, "org", { createdAt: "2026-10-30T00:00:00Z", id: "zz" });
  assert.equal(page.rows.length, 20);
  assert.equal(page.hasMore, true);
  assert.equal(page.rows[0].createdBy, "Budi");
  assert.ok(client.log.includes("whatsapp_batches.eq(organization_id)"));
  assert.ok(client.log.some((entry) => entry.startsWith("whatsapp_batches.or(created_at.lt.2026-10-30T00:00:00Z")));
  assert.ok(client.log.includes("whatsapp_batches.limit(21)"));
  assert.equal(await loadBatch(fakeClient({ whatsapp_batches: [] }) as never, "org", "x"), null);

  const events = fakeClient({
    whatsapp_draft_events: [
      { id: "e1", organization_id: "org", draft_id: "d1", from_status: null, to_status: "draft", note: null, actor_id: "u1", occurred_at: "t1" },
      { id: "e2", organization_id: "org", draft_id: "d1", from_status: "draft", to_status: "delivered", note: null, actor_id: "u1", occurred_at: "t2" },
      { id: "e3", organization_id: "org", draft_id: "d1", from_status: "draft", to_status: "failed", note: "gagal buka", actor_id: null, occurred_at: "t3" },
    ],
    users: [{ id: "u1", full_name: "Budi", email: "b@x" }],
  });
  const map = await loadDraftEvents(events as never, "org", ["d1"]);
  assert.deepEqual(map.get("d1")?.map((event) => [event.from, event.to, event.actor]), [[null, "draft", "Budi"], ["draft", "failed", null]], "a provider-style state is dropped, never displayed");
  assert.equal((await loadDraftEvents(events as never, "org", [])).size, 0);
  await assert.rejects(() => loadDraftEvents(events as never, "org", Array.from({ length: 101 }, (_, i) => `d${i}`)), /too_many/);
});

test("message builder: follow-up text comes from stored template + live queue; a customer outside the queue or a denied role gets a reason, not a draft", async () => {
  const client = fakeClient(
    { customers: [{ id: "c1", organization_id: "org", display_name: "Ani", deleted_at: null }] },
    {
      get_followup_retention_settings: { inactivity_threshold_days: 14, followup_template: "Halo {nama}, {dogs} sudah {days} hari. {biz}", renewal_template: "x", updated_at: "t" },
      list_overdue_customers: { groups: [{ customer_id: "c1", customer_name: "Ani", phone: "0812", pets_total: 1, pets_truncated_count: 0, pets: [{ pet_id: "p1", pet_name: "Moka", days_since: 40, has_upcoming_booking: false, anomaly_future_dated: false }] }], total_groups: 1, page: 1, page_size: 50, threshold_days: 14, filter: "default" },
    },
  );
  const ctx = { supabase: client as never, activeOrganization: { id: "org", name: "HomePaw" }, capabilities: caps("customer.read") };
  const ok = await builder.buildDraftMessage(ctx, "followup", "c1");
  assert.ok(ok.ok && ok.text === "Halo Ani, Moka sudah 40 hari. HomePaw" && ok.label === "Ani");
  const notQueued = await builder.buildDraftMessage(ctx, "followup", "c-other");
  assert.ok(!notQueued.ok && notQueued.error === builder.MESSAGE_ERRORS.notFound);
  const denied = await builder.buildDraftMessage({ ...ctx, capabilities: caps() }, "followup", "c1");
  assert.ok(!denied.ok && denied.error === builder.MESSAGE_ERRORS.noCustomers);
  assert.ok(!(await builder.buildDraftMessage({ ...ctx, capabilities: caps() }, "invoice", "x")).ok);
  assert.ok(!(await builder.buildDraftMessage({ ...ctx, capabilities: caps() }, "renewal", "x")).ok);
  const badTemplate = fakeClient({ customers: [{ id: "c1", organization_id: "org", display_name: "Ani", deleted_at: null }] }, {
    get_followup_retention_settings: { inactivity_threshold_days: 14, followup_template: "Halo {nama} {typo}", renewal_template: "x", updated_at: "t" },
    list_overdue_customers: { groups: [{ customer_id: "c1", customer_name: "Ani", phone: "0812", pets_total: 1, pets_truncated_count: 0, pets: [{ pet_id: "p1", pet_name: "Moka", days_since: 40, has_upcoming_booking: false, anomaly_future_dated: false }] }], total_groups: 1, page: 1, page_size: 50, threshold_days: 14, filter: "default" },
  });
  const refused = await builder.buildDraftMessage({ ...ctx, supabase: badTemplate as never }, "followup", "c1");
  // The follow-up builder leaves an unknown variable visible; the database then refuses the text (invalid_message), so it is never stored or sent.
  assert.ok(refused.ok && /\{typo\}/.test(refused.text), "an unknown template variable is left visible, never silently blanked");
  const sql = read("supabase/migrations/20261031120000_whatsapp_batch_log.sql");
  assert.match(sql, /v_msg ~ '\\{\[a-zA-Z_\]\+\\}'/, "the batch RPC rejects any unresolved {variable}");
});

test("composer: nothing is selected or created by default; create stays disabled until a preview exists; ineligible sources cannot be ticked", () => {
  const html = renderToStaticMarkup(<BatchComposer sourceType="invoice" candidates={[
    { id: "i1", label: "INV-1 · Ani", hint: null, disabledReason: null },
    { id: "i2", label: "INV-2 · Budi", hint: null, disabledReason: "Nomor WhatsApp tidak tersedia" },
  ]} />);
  assert.match(html, /aria-label="Batch draf WhatsApp"/);
  assert.match(html, /name="sourceType" value="invoice"/);
  assert.doesNotMatch(html, /name="sourceId"/, "no source is posted until the user ticks one");
  assert.match(html, /Pratinjau \(tidak menyimpan\)/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Buat batch draf<\/button>|disabled=""[^>]*title="Lakukan pratinjau lebih dulu"/);
  assert.match(html, /Nomor WhatsApp tidak tersedia/);
  assert.match(html, /<input type="checkbox"[^>]*disabled=""/);
  assert.match(html, /0 dipilih/);
  const empty = renderToStaticMarkup(<BatchComposer sourceType="followup" candidates={[]} />);
  assert.match(empty, /Tidak ada sumber yang dapat dipilih saat ini/);
  assert.doesNotMatch(html, /terkirim ke|delivered|dibaca/i);
});

test("cancel control needs an explicit acknowledgement and is disabled when nothing is live", () => {
  const live = renderToStaticMarkup(<CancelBatchButton batchId="b1" disabled={false} />);
  assert.match(live, /name="batchId" value="b1"/);
  assert.match(live, /yang sudah ditandai terkirim tidak berubah/);
  assert.match(live, /<button[^>]*disabled=""[^>]*>Batalkan batch<\/button>/, "disabled until the acknowledgement is ticked");
  const none = renderToStaticMarkup(<CancelBatchButton batchId="b1" disabled />);
  assert.match(none, /type="checkbox"[^>]*disabled=""/);
});

test("draft row shows the delivery log as user reports, with retries and notes, and nothing implies delivery", () => {
  const html = renderToStaticMarkup(<DraftRow draft={draft({ status: "marked_sent" })} canManageContacts={false} events={[
    { id: "e1", draftId: "d1", from: null, to: "draft", note: null, actor: "Budi", occurredAt: "2026-10-12T01:00:00Z" },
    { id: "e2", draftId: "d1", from: "draft", to: "failed", note: "WA tidak terbuka", actor: "Budi", occurredAt: "2026-10-12T01:05:00Z" },
    { id: "e3", draftId: "d1", from: "failed", to: "draft", note: null, actor: "Budi", occurredAt: "2026-10-12T01:06:00Z" },
    { id: "e4", draftId: "d1", from: "draft", to: "marked_sent", note: "dikirim manual", actor: "Budi", occurredAt: "2026-10-12T01:07:00Z" },
  ]} />);
  assert.match(html, /Riwayat \(4\) — catatan pengguna, bukan konfirmasi WhatsApp/);
  assert.match(html, /dibuat: Draf/);
  assert.match(html, /Draf → Ditandai gagal oleh pengguna/);
  assert.match(html, /“WA tidak terbuka”/);
  assert.doesNotMatch(html, /delivered|dibaca oleh|read receipt/i);
  assert.doesNotMatch(renderToStaticMarkup(<DraftRow draft={draft()} canManageContacts={false} />), /Riwayat \(/);
});

test("batch actions: ids only from the browser, server-built text, bounded, source-gated; no network path exists anywhere", () => {
  const actions = read("apps/web/src/app/whatsapp/batch-actions.ts");
  assert.doesNotMatch(actions, /formData\.get(?:All)?\("(?:phone|recipient|message|text|organization|org|customer)/);
  assert.match(actions, /buildDraftMessage\(/);
  assert.match(actions, /BATCH_LIMIT/);
  assert.match(actions, /canBatchSource\(selection\.source/);
  for (const rpc of ["preview_whatsapp_batch", "create_whatsapp_batch", "cancel_whatsapp_batch"]) assert.match(actions, new RegExp(`rpc\\("${rpc}"`));
  assert.doesNotMatch(actions, /fetch\(|api\.whatsapp|graph\.facebook|web\.whatsapp|wa\.me\/send/i);
  const sql = read("supabase/migrations/20261031120000_whatsapp_batch_log.sql");
  assert.doesNotMatch(sql, /net\.http|http_post|pg_net|graph\.facebook/i);
  assert.match(sql, /create trigger trg_whatsapp_events_no_update before update/);
  assert.doesNotMatch(sql, /grant (insert|update|delete)[^;]*whatsapp_(batches|draft_events)[^;]*authenticated/i);
  for (const page of ["apps/web/src/app/whatsapp/batches/page.tsx", "apps/web/src/app/whatsapp/batches/[batchId]/page.tsx"]) {
    assert.match(read(page), /Operro tidak mengirim|tidak mengirim apa pun|Batch hanya membuat draf/);
  }
});

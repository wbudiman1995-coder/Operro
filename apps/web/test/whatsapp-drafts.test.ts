import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  ONBOARDING_LINK_MARKER,
  WHATSAPP_STATUSES,
  WHATSAPP_STATUS_LABELS,
  allowedNextStatuses,
  blockedReason,
  invoiceDraftMessage,
  isWhatsAppSource,
  isWhatsAppStatus,
  maskPhone,
  onboardingDraftMessage,
  renderStrict,
  waUrl,
} from "../src/lib/whatsapp-drafts";
import { buildFollowupMessage, buildRenewalMessage } from "../src/lib/followup-messages";

const root = path.join(__dirname, "../../..");
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), "utf8");
const healthy = { optedOut: false, customerArchived: false, phoneChanged: false };

test("lifecycle mirrors the database: terminal states have no exits, failed can retry, nothing implies delivery", () => {
  assert.deepEqual(allowedNextStatuses("draft"), ["opened", "marked_sent", "failed", "canceled"]);
  assert.deepEqual(allowedNextStatuses("opened"), ["marked_sent", "failed", "canceled"]);
  assert.deepEqual(allowedNextStatuses("failed"), ["draft", "canceled"]);
  assert.deepEqual(allowedNextStatuses("marked_sent"), []);
  assert.deepEqual(allowedNextStatuses("canceled"), []);
  for (const status of WHATSAPP_STATUSES) assert.doesNotMatch(WHATSAPP_STATUS_LABELS[status], /terkirim ke|dikirim oleh Operro|delivered|dibaca|read/i);
  assert.match(WHATSAPP_STATUS_LABELS.opened, /belum tentu terkirim/);
  assert.match(WHATSAPP_STATUS_LABELS.marked_sent, /oleh pengguna/);
  for (const bad of ["delivered", "read", "sent", "queued", "", null, 3]) assert.equal(isWhatsAppStatus(bad), false);
  assert.equal(isWhatsAppSource("sms"), false);
});

test("opted-out, archived, missing-phone and onboarding rules", () => {
  assert.equal(blockedReason("invoice", "6281234567890", healthy), null);
  assert.match(blockedReason("invoice", "6281234567890", { ...healthy, optedOut: true }) ?? "", /berhenti menerima/);
  assert.match(blockedReason("followup", "6281234567890", { ...healthy, customerArchived: true }) ?? "", /diarsipkan/);
  assert.match(blockedReason("renewal", null, healthy) ?? "", /tidak tersedia/);
  assert.equal(blockedReason("onboarding", null, healthy), null, "an invitation legitimately has no recipient");
});

test("template variables: every placeholder must resolve or the draft is refused", () => {
  assert.equal(renderStrict("Halo {nama}", { nama: "Ani" }), "Halo Ani");
  assert.equal(renderStrict("Halo {nama} {unknown}", { nama: "Ani" }), null);
  assert.equal(renderStrict("Tanpa variabel", {}), "Tanpa variabel");
  const ok = invoiceDraftMessage({ template: "Halo {customer}, {number}: {total}. {notes}", customerName: "Ani", invoiceNumber: "INV-1", amount: 150000, currency: "IDR", notes: "" });
  assert.match(ok.text ?? "", /Halo Ani, INV-1: Rp\s?150\.000/);
  const bad = invoiceDraftMessage({ template: "Halo {customer} {typo}", customerName: "Ani", invoiceNumber: "INV-1", amount: 1, currency: "IDR", notes: "" });
  assert.equal(bad.text, null);
  assert.match(bad.blockedReason ?? "", /tidak dikenal/);
  // The existing follow-up/renewal builders keep working with their allow-lists.
  assert.match(buildFollowupMessage("Hi {nama} {dogs} {days} {biz}", { customerName: "Ani", businessName: "HP", pets: [{ name: "Moka", daysSince: 40 }] }).text ?? "", /Hi Ani Moka 40 HP/);
  assert.equal(buildFollowupMessage("x", { customerName: "Ani", businessName: "HP", pets: [] }).text, null);
  assert.equal(buildRenewalMessage("x", { customerName: "A", petLabel: null, tierName: "T", businessName: "B", amount: null, currency: "IDR", amountBlockedReason: null }).text, null);
});

test("customer-controlled text stays text: names with HTML or URL syntax are percent-encoded, not interpreted", () => {
  const url = waUrl("6281234567890", "Halo <b>Ani</b> & tim #1?x=1");
  assert.ok(url?.startsWith("https://wa.me/6281234567890?text="));
  assert.equal(new URL(url!).searchParams.get("text"), "Halo <b>Ani</b> & tim #1?x=1");
  assert.equal(url!.includes("<b>"), false);
  for (const phone of [null, "", "0812", "081234567890", "+6281234567890", "62812345678901234", "abc"]) assert.equal(waUrl(phone, "x"), null, String(phone));
});

test("onboarding drafts never carry the one-time link", () => {
  const text = onboardingDraftMessage("Halo! Daftar di {business}: {link}", "HomePaw");
  assert.equal(text, `Halo! Daftar di HomePaw: ${ONBOARDING_LINK_MARKER}`);
  assert.doesNotMatch(text ?? "", /\/join\//);
  assert.equal(onboardingDraftMessage("Halo {nama}", "HomePaw"), null, "unknown variables refused");
  assert.equal(maskPhone("6281234567890"), "6281…890");
  assert.equal(maskPhone(null), "—");
});

test("server actions never accept a phone, organization or message from the browser", () => {
  const actions = read("apps/web/src/app/whatsapp/actions.ts");
  assert.doesNotMatch(actions, /formData\.get\("(?:phone|recipient|message|text|organization)/);
  assert.doesNotMatch(actions, /(?:single\(formData,|getAll\(|get\()\s*"(?:organization|org)/i, "tenancy never comes from the form");
  assert.match(actions, /workspace\.activeOrganization/);
  assert.match(actions, /create_whatsapp_draft/);
  assert.match(actions, /sourceType === "onboarding"/, "onboarding drafts cannot be created from the center (their link is never stored)");
  const page = read("apps/web/src/app/whatsapp/page.tsx");
  assert.match(page, /Operro tidak mengirim pesan WhatsApp/);
  const migration = read("supabase/migrations/20261029140000_whatsapp_drafts.sql");
  assert.match(migration, /grant select on public\.whatsapp_drafts/);
  assert.doesNotMatch(migration, /grant (insert|update|delete)[^;]*whatsapp_drafts/i);
  assert.doesNotMatch(migration, /net\.http|http_post|pg_net|api\.whatsapp|graph\.facebook/i, "no provider call exists in the database");
  const data = read("apps/web/src/lib/whatsapp-draft-data.ts");
  assert.doesNotMatch(data, /fetch\(|api\.whatsapp|web\.whatsapp/i);
});

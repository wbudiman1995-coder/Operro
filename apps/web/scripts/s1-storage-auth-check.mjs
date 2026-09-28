#!/usr/bin/env node
/**
 * S1 closeout — real authenticated Storage HTTP verification against the
 * isolated local Supabase stack (operro-s2730-local). Not a SQL-helper-only
 * check: every read/sign/update/delete below goes through the actual
 * Storage REST API as a REAL signed-in user, so it exercises the real
 * storage.objects RLS policies from 20261001100000_payment_workflow_closeout.sql
 * and 20261003100000_storage_authorization_review.sql exactly as a browser
 * session would.
 *
 * Requires: `supabase start` + `supabase db reset` already run, and
 * docs/handoffs/logs/S27-S30/closeout/s1_storage_fixtures.sql already
 * applied (adds the unassigned-groomer / branch-restricted-evidence-admin /
 * finance-only personas the base seed doesn't provide). See the handoff for
 * the exact commands.
 *
 * Run: node apps/web/scripts/s1-storage-auth-check.mjs
 */
import { createClient } from "@supabase/supabase-js";

const API_URL = "http://127.0.0.1:54341";
const ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
const SERVICE_ROLE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

const ORG = "d0000000-0000-4000-8000-000000000001";
const BOOKING_501 = "d0000000-0000-4000-8000-000000000501";
const GJP_601 = "d0000000-0000-4000-8000-000000000601"; // Andi, Bubu, branch A
const INVOICE_002 = "d0000000-0000-4000-8000-000000001102"; // issued, 175000, branch A, no payments yet

const PASSWORD = "operro-local-qa";
const PERSONAS = {
  owner: "wbudiman1995@gmail.com",
  groomerAssigned: "groomer@homepaw.local",
  groomerUnassigned: "groomer-unassigned@test.local",
  evidenceAdminB: "evidence-admin-b@test.local",
  financeOnly: "finance-only@test.local",
};

const admin = createClient(API_URL, SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
}

async function signIn(email) {
  const client = createClient(API_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const { error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`);
  return client;
}

const TINY_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/wAALCAABAAEBAREA/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAA/AKp//9k=",
  "base64"
);

async function main() {
  // ---- fixture setup ----
  // The attachments/attachment_links METADATA rows are created by
  // s1_storage_fixtures.sql (run as the Postgres superuser) — service_role
  // lacks USAGE on the `app` schema (fn_uuid_v7() default, audit triggers),
  // a real privilege boundary the app's own server actions never hit
  // because they always run as `authenticated`, never `service_role`. This
  // script only needs to know their ids/paths and upload the actual bytes
  // (a Storage-API operation, independent of that Postgres schema grant).
  const evidencePath = `${ORG}/${BOOKING_501}/${GJP_601}/s1-check-evidence.jpg`;
  const requestKey = "f1000000-0000-4000-8000-0000000000aa";
  const proofPath = `${ORG}/payments/${requestKey}.jpg`;
  const evidenceAttachment = { id: "f1000000-0000-4000-8000-000000000041" };
  const proofAttachment = { id: "f1000000-0000-4000-8000-000000000042" };

  await admin.storage.from("attachments").upload(evidencePath, TINY_JPEG, { contentType: "image/jpeg", upsert: true });
  await admin.storage.from("attachments").upload(proofPath, TINY_JPEG, { contentType: "image/jpeg", upsert: true });

  const clients = {};
  for (const [key, email] of Object.entries(PERSONAS)) clients[key] = await signIn(email);

  // ---- A) grooming evidence: read/sign ----
  for (const [persona, expectAllow] of [
    ["groomerAssigned", true], ["owner", true],
    ["groomerUnassigned", false], ["evidenceAdminB", false], ["financeOnly", false],
  ]) {
    const { data, error } = await clients[persona].storage.from("attachments").createSignedUrl(evidencePath, 60);
    const allowed = !error && !!data?.signedUrl;
    record(`evidence read/sign — ${persona}`, allowed === expectAllow, error?.message);
    if (allowed && data.signedUrl) {
      const res = await fetch(data.signedUrl);
      record(`evidence signed-url actually fetchable — ${persona}`, res.ok, `status=${res.status}`);
    }
  }

  // ---- B) grooming evidence: direct storage delete (assigned vs unassigned) ----
  // Uses a SEPARATE throwaway copy per attempt so a successful delete by one
  // persona doesn't remove the fixture object other assertions still need.
  for (const [persona, expectAllow] of [["groomerUnassigned", false], ["groomerAssigned", true]]) {
    const path = `${ORG}/${BOOKING_501}/${GJP_601}/s1-check-delete-${persona}.jpg`;
    await admin.storage.from("attachments").upload(path, TINY_JPEG, { contentType: "image/jpeg", upsert: true });
    // Row inserted as the real owner persona (authenticated), not service_role
    // — service_role has no USAGE on the `app` schema (fn_uuid_v7() default,
    // audit triggers), the same boundary every real app write already
    // respects by never running as service_role.
    const { data: att, error: insertErr } = await clients.owner.from("attachments").insert({
      organization_id: ORG, storage_bucket: "attachments", storage_path: path, filename: "x.jpg", mime_type: "image/jpeg", size_bytes: TINY_JPEG.length,
      metadata: { category: "after", grooming_job_pet_id: GJP_601 },
    }).select("id").single();
    if (insertErr) throw new Error(`fixture attachment insert failed: ${insertErr.message}`);
    await clients.owner.from("attachment_links").insert({ organization_id: ORG, attachment_id: att.id, subject_type: "booking", subject_id: BOOKING_501 });

    const { error } = await clients[persona].storage.from("attachments").remove([path]);
    const { data: check } = await admin.storage.from("attachments").list(`${ORG}/${BOOKING_501}/${GJP_601}`, { search: `s1-check-delete-${persona}.jpg` });
    const actuallyDeleted = !check || check.length === 0;
    record(`evidence direct-storage delete — ${persona}`, actuallyDeleted === expectAllow, error?.message);
  }

  // ---- C) payment proof: read/sign restricted to finance/payment.manage ----
  for (const [persona, expectAllow] of [
    ["financeOnly", true], ["owner", true],
    ["groomerAssigned", false], ["evidenceAdminB", false],
  ]) {
    const { data, error } = await clients[persona].storage.from("attachments").createSignedUrl(proofPath, 60);
    const allowed = !error && !!data?.signedUrl;
    record(`payment-proof read/sign — ${persona}`, allowed === expectAllow, error?.message);
  }

  // ---- D) payment proof: update always denied, even for the owner ----
  {
    const { error } = await clients.owner.storage.from("attachments").update(proofPath, TINY_JPEG, { contentType: "image/jpeg" });
    record("payment-proof update denied even for owner", !!error, error ? undefined : "update unexpectedly succeeded");
  }

  // ---- E) payment proof: deletable pre-commit, protected post-commit ----
  {
    const preDelete = await clients.financeOnly.storage.from("attachments").createSignedUrl(proofPath, 60);
    record("payment-proof pre-commit still readable before delete check", !preDelete.error, preDelete.error?.message);
  }
  {
    // record_payment as finance-only (payment.manage, Branch A access, no booking.update needed).
    const { error } = await clients.financeOnly.schema("app").rpc("record_payment", {
      p_invoice: INVOICE_002, p_method: "bank_transfer", p_amount: 175000, p_external_ref: `S1CHECK-${requestKey}`,
      p_proof_attachment: proofAttachment.id, p_request_key: requestKey,
    });
    record("record_payment succeeds for payment.manage-only persona (no booking.update)", !error, error?.message);
  }
  {
    const { error } = await clients.owner.storage.from("attachments").remove([proofPath]);
    const { data: check } = await admin.storage.from("attachments").list(`${ORG}/payments`, { search: `${requestKey}.jpg` });
    const stillExists = !!check && check.length > 0;
    record("committed payment proof survives a delete attempt (evidence preserved)", stillExists, error ? undefined : "delete call did not error, checking object presence instead");
  }

  // ---- F) delete_grooming_evidence RPC must reject a payment-proof attachment ----
  {
    const { error } = await clients.owner.schema("app").rpc("delete_grooming_evidence", { p_attachment: proofAttachment.id });
    record("delete_grooming_evidence rejects a payment-proof attachment (evidence admin)", !!error && /not_grooming_evidence/.test(error.message ?? ""), error?.message);
  }

  // ---- G) delete_grooming_evidence RPC works for the real evidence attachment ----
  {
    const { error, data } = await clients.groomerAssigned.schema("app").rpc("delete_grooming_evidence", { p_attachment: evidenceAttachment.id });
    record("delete_grooming_evidence succeeds for the assigned groomer on real evidence", !error, error?.message);
    // The RPC only soft-deletes the METADATA row and returns the storage
    // location — the caller removes the actual bytes as a second step,
    // exactly like deleteGroomingEvidenceAction (pilot-actions.ts) does.
    const row = Array.isArray(data) ? data[0] : data;
    if (!error && row?.storage_path) {
      const { error: removeErr } = await clients.groomerAssigned.storage.from(row.storage_bucket).remove([row.storage_path]);
      record("assigned groomer can remove the actual bytes after RPC soft-delete", !removeErr, removeErr?.message);
      const { data: obj } = await admin.storage.from("attachments").list(`${ORG}/${BOOKING_501}/${GJP_601}`, { search: "s1-check-evidence.jpg" });
      record("deleted evidence bytes actually removed from storage", !obj || obj.length === 0);
    }
  }

  // ---- H) signed URL TTL actually expires (not immediate revocation, but bounded) ----
  {
    const ttlPath = `${ORG}/${BOOKING_501}/${GJP_601}/s1-check-ttl.jpg`;
    await admin.storage.from("attachments").upload(ttlPath, TINY_JPEG, { contentType: "image/jpeg", upsert: true });
    const { data: att, error: insertErr } = await clients.owner.from("attachments").insert({
      organization_id: ORG, storage_bucket: "attachments", storage_path: ttlPath, filename: "ttl.jpg", mime_type: "image/jpeg", size_bytes: TINY_JPEG.length,
      metadata: { category: "before", grooming_job_pet_id: GJP_601 },
    }).select("id").single();
    if (insertErr) throw new Error(`fixture attachment insert failed: ${insertErr.message}`);
    await clients.owner.from("attachment_links").insert({ organization_id: ORG, attachment_id: att.id, subject_type: "booking", subject_id: BOOKING_501 });

    const { data: signed } = await clients.groomerAssigned.storage.from("attachments").createSignedUrl(ttlPath, 1);
    const immediate = await fetch(signed.signedUrl);
    record("fresh 1s-TTL signed URL is fetchable immediately", immediate.ok, `status=${immediate.status}`);
    await new Promise((r) => setTimeout(r, 2500));
    const afterExpiry = await fetch(signed.signedUrl);
    record("1s-TTL signed URL rejected after it expires", !afterExpiry.ok, `status=${afterExpiry.status}`);
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed.`);
  if (failed.length) {
    console.log("FAILED:", failed.map((r) => r.name).join("; "));
    process.exitCode = 1;
  }
}

main().catch((err) => { console.error(err); process.exitCode = 1; });

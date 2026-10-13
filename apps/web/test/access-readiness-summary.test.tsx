import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { renderToStaticMarkup } from "react-dom/server";

import { AccessReadinessPanel } from "../src/components/access-readiness-panel";
import { describeReadinessError, FLAG_INFO, loadAccessReadiness, parseAccessReadiness } from "../src/lib/access-readiness-summary";

const root = path.resolve(import.meta.dirname, "../../..");
const org = (over: Record<string, unknown> = {}) => ({
  organization_id: "e7000000-0000-4000-8000-000000000001", name: "Alpha Ready", slug: "alpha-ready", status: "active",
  active_members: 2, suspended_members: 1, active_owners: 1, pending_invitations: 1, expired_pending_invitations: 1, accepted_invitations: 1, revoked_invitations: 1,
  flags: ["expired_pending_invitations"], ...over,
});
const summary = (orgs: unknown[] = [org()]) => ({
  generated_at: "2026-10-13T00:00:00Z", truncated: false, organizations: orgs,
  totals: { organizations: 5, suspended_workspaces: 1, without_active_owner: 3, pending_invitations: 2, expired_pending_invitations: 2, people_in_several_organizations: 1 },
});

test("the summary is parsed into numbers and flags and malformed rows are dropped", () => {
  const parsed = parseAccessReadiness([summary([org(), org({ organization_id: "x2", name: "B", flags: ["no_active_owner", "owner_invitation_pending", 7] }), { name: "no id" }])]);
  assert.ok(parsed);
  assert.equal(parsed.organizations.length, 2);
  assert.deepEqual(parsed.organizations[1].flags, ["no_active_owner", "owner_invitation_pending"], "non-string flags are ignored");
  assert.equal(parsed.totals.peopleInSeveralOrganizations, 1);
  assert.equal(parsed.totals.withoutActiveOwner, 3);
  assert.equal(parsed.truncated, false);
  assert.equal(parseAccessReadiness(null), null);
  assert.equal(parseAccessReadiness({ organizations: "x" }), null);
  assert.equal(parseAccessReadiness({ organizations: [] })!.totals.organizations, 0, "missing totals read as zero, not as a crash");
});

test("every flag the database can emit has a plain explanation and an action", () => {
  const sql = fs.readFileSync(path.join(root, "supabase/migrations/20261101150000_access_readiness.sql"), "utf8");
  const emitted = [...sql.matchAll(/then '([a-z_]+)' end/g)].map((match) => match[1]);
  assert.ok(emitted.length >= 6);
  for (const code of emitted) {
    assert.ok(FLAG_INFO[code], `${code} has an explanation`);
    assert.ok(FLAG_INFO[code].text.length > 10 && FLAG_INFO[code].action.length > 10);
  }
});

test("the panel lists only organizations that need attention, with what to do, and reveals no identity", () => {
  const readiness = parseAccessReadiness(summary([
    org({ name: "Alpha Ready", flags: [] }),
    org({ organization_id: "x2", name: "Bravo Waiting", active_owners: 0, flags: ["no_active_owner", "owner_invitation_pending"] }),
    org({ organization_id: "x3", name: "Foxtrot Lapsed", active_owners: 0, flags: ["no_active_owner", "owner_invitation_expired", "mystery_flag"] }),
  ]));
  const html = renderToStaticMarkup(<AccessReadinessPanel readiness={readiness} error={null} />);
  assert.match(html, /Kesiapan akses/);
  assert.match(html, /Bravo Waiting/);
  assert.match(html, /Foxtrot Lapsed/);
  assert.doesNotMatch(html, /Alpha Ready/, "a ready organization is not listed");
  assert.match(html, /Undangan Pemilik yang valid sedang menunggu diterima/);
  assert.match(html, /Terbitkan undangan Pemilik baru/);
  assert.match(html, /Penanda tidak dikenal: mystery_flag/, "an unknown flag stays visible");
  assert.match(html, /Orang di &gt;1 organisasi/);
  assert.match(html, /bukan bukti email undangan terkirim/);
  assert.doesNotMatch(html, /@/, "no e-mail address");
  assert.doesNotMatch(html, /\btoken\b.*[0-9a-f]{16}/);
});

test("nothing to do, a failed load and a missing function are three different states", () => {
  const clean = renderToStaticMarkup(<AccessReadinessPanel readiness={parseAccessReadiness(summary([org({ flags: [] })]))} error={null} />);
  assert.match(clean, /Tidak ada organisasi yang perlu tindakan/);
  const failed = renderToStaticMarkup(<AccessReadinessPanel readiness={null} error={describeReadinessError({ code: "XX000" })} />);
  assert.match(failed, /role="alert"/);
  assert.match(failed, /bukan tanda semuanya siap/);
  assert.doesNotMatch(failed, /Tidak ada organisasi yang perlu tindakan/, "a failed load is never shown as all clear");
  assert.match(describeReadinessError({ code: "42501" }), /hanya untuk pemilik platform/);
  assert.match(describeReadinessError({ code: "PGRST202" }), /20261101150000 belum diterapkan/);
  const truncated = renderToStaticMarkup(<AccessReadinessPanel readiness={{ ...parseAccessReadiness(summary())!, truncated: true }} error={null} />);
  assert.match(truncated, /200 organisasi pertama/);
});

test("the loader calls one argument-free RPC and keeps the error code", async () => {
  const calls: Array<{ name: string; args: unknown }> = [];
  const ok = { schema: () => ({ rpc: async (name: string, args?: unknown) => { calls.push({ name, args }); return { data: summary(), error: null }; } }) } as never;
  assert.equal((await loadAccessReadiness(ok))?.organizations.length, 1);
  assert.deepEqual(calls, [{ name: "access_readiness_summary", args: undefined }]);
  const denied = { schema: () => ({ rpc: async () => ({ data: null, error: { code: "42501", message: "not_authorized" } }) }) } as never;
  await assert.rejects(() => loadAccessReadiness(denied), (error: Error & { code?: string }) => error.code === "42501");
});

test("the platform page shows the panel, the library creates nothing, and the staging script only reads", () => {
  const page = fs.readFileSync(path.join(root, "apps/web/src/app/platform/page.tsx"), "utf8");
  assert.match(page, /<AccessReadinessPanel readiness=\{readiness\} error=\{readinessError\} \/>/);
  const lib = fs.readFileSync(path.join(root, "apps/web/src/lib/access-readiness-summary.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(lib, /issue_access_invitation|claim_access_invitation|\.insert\(|\.update\(|\.delete\(|sendMail|nodemailer/);
  const script = fs.readFileSync(path.join(root, "docs/runbooks/staging_access_checks.sql"), "utf8").replace(/--.*$/gm, "");
  assert.doesNotMatch(script, /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke)\b/i, "the post-condition script is read-only");
});

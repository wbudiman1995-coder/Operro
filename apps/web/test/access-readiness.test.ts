import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { describeInvitationError } from "../src/lib/invitation-errors";

const root = path.resolve(import.meta.dirname, "../../..");
const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");

test("every database refusal of an invitation claim maps to a distinct, actionable message", () => {
  const cases: Array<[{ code?: string; message?: string }, RegExp]> = [
    [{ code: "42501", message: "wrong_or_unverified_email" }, /email penerima undangan yang sudah diverifikasi/],
    [{ code: "22023", message: "membership_already_exists" }, /tidak mengaktifkan kembali atau mengubah akses/],
    [{ code: "22023", message: "organization_unavailable" }, /Workspace ini sedang tidak aktif/],
    [{ code: "22023", message: "invitation_unavailable" }, /kedaluwarsa, atau sudah digunakan/],
    [{ code: "22023", message: "invalid_invitation" }, /kedaluwarsa, atau sudah digunakan/],
    [{ code: "PGRST202", message: "Could not find the function" }, /belum siap di server ini/],
    [{ code: "42883", message: "function does not exist" }, /belum siap di server ini/],
  ];
  const texts = new Set<string>();
  for (const [error, expected] of cases) {
    const text = describeInvitationError(error);
    assert.match(text, expected, JSON.stringify(error));
    texts.add(text);
  }
  assert.ok(texts.size >= 5, "different causes do not collapse into one message");
});

test("a transient or unknown failure is never reported as a bad link", () => {
  for (const error of [{ code: "57014", message: "canceling statement due to statement timeout" }, { message: "fetch failed" }, {}, { code: "XX000", message: "relation public.memberships" }]) {
    const text = describeInvitationError(error);
    assert.match(text, /gangguan sementara/);
    assert.match(text, /belum tentu bermasalah/);
    assert.doesNotMatch(text, /kedaluwarsa|sudah digunakan|relation|public\.|timeout|fetch/i, "no raw database or network text");
  }
});

test("the accept form uses the mapping, keeps the token out of logs and URLs, and offers sign-in on the invited e-mail only", () => {
  const form = read("apps/web/src/components/accept-invitation-form.tsx");
  assert.match(form, /describeInvitationError\(error\)/);
  assert.doesNotMatch(form, /console\.(log|error|warn)|localStorage|sessionStorage|searchParams|window\.location/, "the token is not logged, stored or re-exposed");
  assert.match(form, /rpc\("claim_access_invitation", \{ p_token: token \}\)/);
  assert.doesNotMatch(form, /p_org|organization_id|p_role|role_name/i, "the browser never says which organization or role to join");
  const page = read("apps/web/src/app/accept/[token]/page.tsx");
  assert.match(page, /alamat email yang menerima link ini/);
});

test("the migration lineage has no policy that lets a client read invitation tokens or write memberships", () => {
  const access = read("supabase/migrations/20261019100000_platform_org_access.sql");
  assert.match(access, /revoke all on public\.platform_access_invitations from anon, authenticated/);
  assert.match(access, /revoke insert, update, delete on public\.role_permissions from authenticated/);
  assert.match(access, /token_hash text not null/);
  assert.doesNotMatch(access, /\btoken text\b/, "no plain token column exists");
});

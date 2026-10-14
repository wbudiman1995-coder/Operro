import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../../..");
const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");

test("QC closeout: invitations create or use a password account and business owners can add only Admins", () => {
  const form = read("apps/web/src/components/accept-invitation-form.tsx");
  const migration = read("supabase/migrations/20261101200000_qc_finish_access_and_pets.sql");
  assert.match(form, /signUp/);
  assert.match(form, /signInWithPassword/);
  assert.match(form, /pending_access_invitation_email/);
  assert.doesNotMatch(form, /GoogleSignInButton|signInWithOAuth/);
  assert.match(migration, /p_role = 'Admin' and app\.is_business_owner\(p_org\)/);
});

test("invitation history supports audited revocation and normal login requires active access", () => {
  const migration = read("supabase/migrations/20261101230000_invitation_revocation_and_login_gate.sql");
  const management = read("apps/web/src/components/access-management.tsx");
  const actions = read("apps/web/src/app/platform/actions.ts");
  const login = read("apps/web/src/components/login-form.tsx");
  const authContext = read("apps/web/src/lib/auth-context.ts");
  const callback = read("apps/web/src/app/auth/callback/route.ts");
  const claim = read("supabase/migrations/20261019100000_platform_org_access.sql");

  assert.match(migration, /create or replace function app\.revoke_access_invitation/);
  assert.match(migration, /set status = 'revoked'/);
  assert.doesNotMatch(migration, /delete from public\.platform_access_invitations/);
  assert.match(migration, /v_invitation\.role_name = 'Admin' and app\.is_business_owner\(p_org\)/);
  assert.match(management, /Cabut undangan/);
  assert.match(actions, /rpc\("revoke_access_invitation"/);
  assert.match(login, /rpc\("can_access_operro"\)/);
  assert.match(login, /auth\.signOut\(\)/);
  assert.match(authContext, /!isOperroOwner && organizations\.length === 0/);
  assert.match(claim, /lower\(v_user\.email\)<>v_inv\.email/);
  assert.match(claim, /au\.email_confirmed_at is not null/);
  assert.match(callback, /claim_access_invitation/);
  assert.match(callback, /login\?notice=account-confirmed/);
  assert.match(callback, /auth\.signOut\(\)/);
});

test("QC closeout: catalog table owns service editing, including categories and added pet types", () => {
  const matrix = read("apps/web/src/components/catalog-price-matrix.tsx");
  const page = read("apps/web/src/app/catalog/page.tsx");
  assert.match(matrix, /name="category"/);
  assert.match(matrix, /name="isActive"/);
  assert.match(matrix, /SpeciesPricingFields/);
  assert.match(page, /Tambah baris layanan/);
  assert.doesNotMatch(page, /ServiceManager/);
});

test("QC closeout: an archived groomer has a dedicated read-only booking history", () => {
  const manager = read("apps/web/src/components/resource-manager.tsx");
  const history = read("apps/web/src/app/team/history/[resourceId]/page.tsx");
  assert.match(manager, /team\/history/);
  assert.match(history, /grooming_job_pets/);
  assert.match(history, /baca-saja/);
});

test("QC closeout: the published checklist contains no unchecked QC items", () => {
  const checklist = read("docs/QC_1-4_CLOSEOUT.md");
  assert.doesNotMatch(checklist, /- \[ \]/);
  for (const section of ["Sign-in, workspace, and permissions", "Platform owner controls", "Team", "Catalog, branches, and navigation"]) assert.match(checklist, new RegExp(section));
});

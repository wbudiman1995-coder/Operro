import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.join(__dirname, "../../..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

test("QC navigation separates manager operations from a groomer's personal schedule", () => {
  const desktop = read("apps/web/src/components/workspace-shell.tsx");
  const mobile = read("apps/web/src/components/workspace-mobile-menu.tsx");
  for (const source of [desktop, mobile]) {
    assert.match(source, /Operasional[\s\S]*hideFromGroomer: true/);
    assert.match(source, /Jadwal saya[\s\S]*groomerOnly: true/);
  }
});

test("QC business owner controls are enforced in SQL, with a guarded destructive platform operation", () => {
  const migration = read("supabase/migrations/20261101190000_qc_completion.sql");
  assert.match(migration, /elsif app\.is_business_owner\(p_org\) then v_actor := 'owner'/);
  assert.match(migration, /create function app\.create_branch/);
  assert.match(migration, /create function app\.delete_operro_organization/);
  assert.match(migration, /'HAPUS ' \|\| v_slug/);
});

test("QC groomer access uses a one-time code without email invitation", () => {
  const migration = read("supabase/migrations/20261101190000_qc_completion.sql");
  const access = read("apps/web/src/components/access-management.tsx");
  const portal = read("apps/web/src/components/groomer-code-access.tsx");
  const actions = read("apps/web/src/app/platform/actions.ts");
  assert.match(migration, /create table public\.groomer_access_codes/);
  assert.match(migration, /create function app\.claim_groomer_access_code/);
  assert.match(portal, /signInAnonymously/);
  assert.match(access, /Groomer memakai kode pribadi tanpa email/);
  assert.match(actions, /\["Pemilik", "Admin", "Bantuan Operro"\]\.includes\(role\)/);
});

test("QC suspension state exposes the platform-recorded reason instead of an empty workspace", () => {
  const organizations = read("apps/web/src/app/organizations/page.tsx");
  const empty = read("apps/web/src/components/no-organization-state.tsx");
  assert.match(organizations, /loadAccessibleOrganizations\(supabase, context\.user\.id, true\)/);
  assert.match(empty, /Akses workspace ditangguhkan/);
  assert.match(empty, /Alasan:/);
});

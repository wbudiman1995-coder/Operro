import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.join(__dirname, "../../..");
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("catalog does not offer the HomePaw-specific starter to tenant users", () => {
  const page = read("apps/web/src/app/catalog/page.tsx");
  assert.doesNotMatch(page, /HomepawServiceStarter/);
  assert.match(page, /CatalogPriceMatrix/);
});

test("organization preparation creates the internal slug automatically and provisions an active workspace", () => {
  const actions = read("apps/web/src/app/platform/actions.ts");
  const form = read("apps/web/src/components/access-management.tsx");
  const migration = read("supabase/migrations/20261101180000_active_organization_provisioning.sql");
  assert.match(actions, /baseSlug/);
  assert.match(actions, /attempt <= 100/);
  assert.doesNotMatch(form.slice(form.indexOf("export function OrganizationPreparationForm"), form.indexOf("export function AccessInvitationForm")), /name="slug"/);
  assert.match(migration, /values\(p_name,p_slug,'active','grooming'/);
  assert.match(migration, /values\(v_org,'active',now\(\),now\(\)\+interval '30 days'\)/);
});

test("saved landing preference invalidates the /start redirect and invitation terminology does not imply a Vercel account", () => {
  const preferences = read("apps/web/src/app/settings/preferences/actions.ts");
  const invite = read("apps/web/src/components/accept-invitation-form.tsx");
  assert.match(preferences, /revalidatePath\("\/start"\)/);
  assert.match(invite, /Aktifkan akses Operro/);
  assert.doesNotMatch(invite, />Buat akun</);
});

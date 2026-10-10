import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  EVIDENCE_RETENTION_DEFAULT,
  landingHref,
  parseEvidenceRetentionDays,
  parseLandingChoice,
  readEvidenceRetentionDays,
} from "../src/lib/preferences";

const root = path.join(__dirname, "../../..");
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("landing choice comes from a closed map: unknown, external and path-like values never become a route", () => {
  assert.equal(parseLandingChoice(""), null);
  assert.equal(parseLandingChoice("finance"), "finance");
  for (const bad of ["/finance", "https://evil.example", "../admin", "Finance", " finance", "payroll", 5, null, undefined]) {
    assert.equal(parseLandingChoice(bad), undefined, String(bad));
  }
  assert.equal(landingHref("schedule"), "/schedule");
  for (const bad of ["//evil.example", "javascript:alert(1)", null, undefined, 3, "payroll"]) assert.equal(landingHref(bad), "/dashboard");
});

test("evidence retention accepts only whole days inside the database bounds", () => {
  assert.equal(parseEvidenceRetentionDays("30"), 30);
  assert.equal(parseEvidenceRetentionDays("1825"), 1825);
  for (const bad of ["29", "1826", "1e3", "30.5", "-30", "", "abc", " ", "0030x", null, 90]) assert.equal(parseEvidenceRetentionDays(bad), undefined, String(bad));
  assert.equal(readEvidenceRetentionDays({ evidence_retention_days: 90 }), 90);
  for (const bad of [null, "malformed", [], {}, { evidence_retention_days: "90" }, { evidence_retention_days: 5 }, { evidence_retention_days: 90.5 }]) {
    assert.equal(readEvidenceRetentionDays(bad), EVIDENCE_RETENTION_DEFAULT, JSON.stringify(bad));
  }
});

test("organization-owned and user-owned writes are separate RPCs; neither accepts tenancy or user ids from the browser", () => {
  const storageActions = read("apps/web/src/app/settings/storage/actions.ts");
  const prefActions = read("apps/web/src/app/settings/preferences/actions.ts");
  const retention = storageActions.slice(storageActions.indexOf("saveEvidenceRetentionAction"));
  assert.match(retention, /set_evidence_retention_days/);
  assert.doesNotMatch(retention, /organization_id|organizationId|p_org|userId/);
  assert.match(prefActions, /set_my_landing_page/);
  assert.doesNotMatch(prefActions, /organization_id|organizationId|p_org|p_user|userId/);
  const migration = read("supabase/migrations/20261029120000_settings_and_preferences.sql");
  assert.match(migration, /app\.is_business_owner_member\(v_org\)/);
  assert.equal((migration.match(/security (definer|invoker)/g) ?? []).length, 4);
  assert.equal((migration.match(/set search_path = ''/g) ?? []).length, 4);
  assert.match(migration, /revoke all on function[\s\S]*from public, anon, authenticated/);
});

test("post-login and org switch go through /start so the saved default is applied with live capabilities", () => {
  assert.match(read("apps/web/src/app/page.tsx"), /"\/start"/);
  assert.match(read("apps/web/src/components/organization-switcher.tsx"), /router\.replace\("\/start"\)/);
  const start = read("apps/web/src/app/start/page.tsx");
  assert.match(start, /my_landing_page/);
  assert.match(start, /error \? "\/dashboard"/);
});

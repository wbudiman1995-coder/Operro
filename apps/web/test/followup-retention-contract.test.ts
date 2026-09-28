import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.join(__dirname, "../../..");
const migration = fs.readFileSync(path.join(root, "supabase/migrations/20261002090000_retention_renewal_followups.sql"), "utf8");
const gates = fs.readFileSync(path.join(root, "run_all_gates.sh"), "utf8");
const capabilities = fs.readFileSync(path.join(root, "apps/web/src/lib/authorization.ts"), "utf8");
const followupMessages = fs.readFileSync(path.join(root, "apps/web/src/lib/followup-messages.ts"), "utf8");
const followupActions = fs.readFileSync(path.join(root, "apps/web/src/app/followups/actions.ts"), "utf8");
const followupsPage = fs.readFileSync(path.join(root, "apps/web/src/app/followups/page.tsx"), "utf8");
const overdueQueue = fs.readFileSync(path.join(root, "apps/web/src/components/overdue-queue.tsx"), "utf8");
const renewalQueue = fs.readFileSync(path.join(root, "apps/web/src/components/renewal-queue.tsx"), "utf8");
const settingsPanel = fs.readFileSync(path.join(root, "apps/web/src/components/followup-settings-panel.tsx"), "utf8");
const membershipsPage = fs.readFileSync(path.join(root, "apps/web/src/app/programs/memberships/page.tsx"), "utf8");
const membershipFilterList = fs.readFileSync(path.join(root, "apps/web/src/components/membership-filter-list.tsx"), "utf8");
const membershipManager = fs.readFileSync(path.join(root, "apps/web/src/components/membership-manager.tsx"), "utf8");
const customer360 = fs.readFileSync(path.join(root, "apps/web/src/components/customer-360.tsx"), "utf8");

const stampFn = migration.slice(migration.indexOf("function app.tg_gjp_stamp_completed_at"), migration.indexOf("SECTION 2"));
const overdueFn = migration.slice(migration.indexOf("function app.list_overdue_customers"), migration.indexOf("revoke all on function app.list_overdue_customers"));
const renewalFn = migration.slice(migration.indexOf("function app.list_renewal_queue"), migration.indexOf("revoke all on function app.list_renewal_queue"));
const updateSettingsFn = migration.slice(migration.indexOf("function app.update_followup_retention_settings"), migration.indexOf("revoke all on function app.update_followup_retention_settings"));
const validatePlaceholdersFn = migration.slice(migration.indexOf("function app.fn_validate_template_placeholders"), migration.indexOf("function app.update_followup_retention_settings"));

test("S35: run_all_gates.sh's migration lineage includes the new migration (would otherwise hard-fail GATE 1)", () => {
  assert.match(gates, /supabase\/migrations\/20261002090000_retention_renewal_followups\.sql/);
});

test("S35: settings.manage is exposed through the TS capability allow-list (the DB permission already existed)", () => {
  assert.match(capabilities, /"settings\.manage"/);
});

test("S35: grooming_job_pets.completed_at is stamped exactly on the transition into 'complete', not on every later edit", () => {
  assert.match(migration, /alter table public\.grooming_job_pets add column completed_at timestamptz/);
  assert.match(stampFn, /new\.status = 'complete' and \(tg_op = 'INSERT' or old\.status is distinct from 'complete'\)/);
  assert.match(stampFn, /new\.completed_at := now\(\)/);
  assert.match(stampFn, /elsif new\.status <> 'complete' then\s*\n\s*new\.completed_at := null/);
  assert.match(migration, /update public\.grooming_job_pets\s*\n\s*set completed_at = updated_at\s*\n\s*where status = 'complete' and completed_at is null/);
});

test("S35: the organizations audit trigger attempt was reverted (broke the seed script) in favor of an explicit audit_log insert scoped to the one RPC", () => {
  assert.doesNotMatch(migration, /create trigger trg_organizations_audit/);
  assert.match(updateSettingsFn, /insert into app\.audit_log \(organization_id, actor_id, action, entity_table, entity_id, diff\)/);
  assert.match(updateSettingsFn, /'organizations', v_org/);
});

test("S35: followup_retention settings read has a documented 14-day fallback for orgs with no explicit value, and existing orgs were backfilled to 30", () => {
  assert.match(migration, /coalesce\(\(o\.settings -> 'followup_retention' ->> 'inactivity_threshold_days'\)::integer, 14\)/);
  assert.match(migration, /'followup_retention', jsonb_build_object\('inactivity_threshold_days', 30\)\)\s*\n\s*where settings -> 'followup_retention' -> 'inactivity_threshold_days' is null/);
});

test("S35: settings write is guarded (settings.manage, updated_at concurrency, range/placeholder validation) and merges only its own key", () => {
  assert.match(updateSettingsFn, /assert_tenant_authorized\(v_org, null, 'settings\.manage'\)/);
  assert.match(updateSettingsFn, /v_row\.updated_at is distinct from p_expected_updated_at/);
  assert.match(updateSettingsFn, /raise exception 'stale_settings_write' using errcode = '40001'/);
  assert.match(updateSettingsFn, /p_inactivity_threshold_days < 1 or p_inactivity_threshold_days > 365/);
  assert.match(updateSettingsFn, /settings = settings \|\| jsonb_build_object\('followup_retention'/);
  assert.match(validatePlaceholdersFn, /return 'unknown_placeholder:' \|\| array_to_string\(v_unknown, ','\)/);
});

test("S35: list_overdue_customers keys last-groomed off the pet's own status, never the parent booking's overall status", () => {
  assert.match(overdueFn, /gjp\.status = 'complete' and gjp\.deleted_at is null/);
  assert.doesNotMatch(overdueFn, /b\.status = 'completed'/);
  assert.match(overdueFn, /b\.status not in \('canceled', 'no_show'\)/);
});

test("S35: list_overdue_customers computes calendar-day inactivity in Asia/Jakarta, not a UTC/elapsed-hours subtraction", () => {
  assert.match(overdueFn, /\(now\(\) at time zone 'Asia\/Jakarta'\)::date - \(lv\.last_at at time zone 'Asia\/Jakarta'\)::date/);
});

test("S35: list_overdue_customers enforces branch access server-side (not merely a UI filter) and rejects an inaccessible p_branch", () => {
  assert.match(overdueFn, /if p_branch is not null and not app\.has_branch\(p_branch\) then/);
  assert.match(overdueFn, /raise exception 'branch_not_accessible'/);
  assert.match(overdueFn, /v_all_branches or app\.has_branch\(b\.branch_id\)/);
});

test("S35: list_overdue_customers paginates by customer (25 default, 100 max), never truncates a large single group silently", () => {
  assert.match(overdueFn, /v_page_size := least\(100, greatest\(1, coalesce\(p_page_size, 25\)\)\)/);
  assert.match(overdueFn, /pets_truncated_count/);
  assert.match(overdueFn, /filter \(where rp\.rn <= 20\)/);
});

test("S35: list_renewal_queue never touches packages.price -- amounts stay on the existing preview RPC only", () => {
  assert.doesNotMatch(renewalFn, /packages\.price|pk\.price/);
  assert.match(renewalFn, /assert_tenant_authorized\(v_org, 'membership', 'membership\.read'\)/);
});

test("S35: list_renewal_queue derives held/available/consumed from the ledger and reservations, never inferring consumed as total-minus-available", () => {
  assert.match(renewalFn, /sum\(-delta\) as consumed_count/);
  assert.match(renewalFn, /greatest\(0, cp\.sessions_remaining - coalesce\(r\.reserved_count, 0\)\) as available_count/);
  assert.match(renewalFn, /no_available_sessions/);
  assert.match(renewalFn, /all_reserved/);
});

test("S35: list_renewal_queue distinguishes one-off tokens (recurrence_interval='none') from recurring memberships and excludes tokens by default", () => {
  assert.match(renewalFn, /pk\.recurrence_interval <> 'none'\) as is_recurring/);
  assert.match(renewalFn, /p_include_tokens or pk\.recurrence_interval <> 'none'/);
});

test("S35: list_renewal_queue's actionable/historical views key off status, and null expires_at never counts as expired", () => {
  assert.match(renewalFn, /when 'historical' then cp\.status = 'canceled'/);
  assert.match(renewalFn, /when 'actionable' then cp\.status <> 'canceled'/);
  assert.match(renewalFn, /e\.expires_at is not null and e\.expires_at < now\(\)\) as is_expired/);
});

test("S35: /followups persists tab/search/branch/filter/view/page as URL parameters (reload and Back both work without client JS for navigation)", () => {
  assert.match(followupsPage, /searchParams: Promise<FollowupsSearchParams>/);
  assert.match(followupsPage, /function buildHref/);
  assert.match(followupsPage, /OVERDUE_FILTERS\.some\(\(f\) => f\.value === params\.filter\)/);
  assert.match(followupsPage, /RENEWAL_VIEWS\.some\(\(v\) => v\.value === params\.view\)/);
});

test("S35: the overdue queue reuses buildWhatsAppUrl (customer-360.tsx) rather than reimplementing wa.me link construction", () => {
  assert.match(overdueQueue, /import \{ buildWhatsAppUrl \} from "@\/components\/customer-360"/);
  assert.match(renewalQueue, /import \{ buildWhatsAppUrl \} from "@\/components\/customer-360"/);
  assert.doesNotMatch(overdueQueue, /wa\.me\/\$\{/);
});

test("S35: the renewal draft reuses previewPackageRenewalAction (no second pricing RPC/path introduced)", () => {
  assert.match(renewalQueue, /import \{ previewPackageRenewalAction, type PackageRenewalPreview \} from "@\/app\/pilot-actions"/);
  assert.match(renewalQueue, /await previewPackageRenewalAction\(id\)/);
});

test("S35: a combined renewal draft is blocked (not silently partial-summed) when any selected membership's preview is blocked/errored/pending", () => {
  assert.match(renewalQueue, /const canCombine = errored\.length === 0 && !pending && currencies\.size <= 1 && oks\.length === selected\.length/);
  assert.match(renewalQueue, /Beberapa paket terpilih tidak dapat diperpanjang/);
});

test("S35: known placeholders are the single source of truth on both the client editor and the server RPC", () => {
  assert.match(followupMessages, /KNOWN_FOLLOWUP_PLACEHOLDERS = \["nama", "dogs", "days", "inactive_period", "biz"\]/);
  assert.match(followupMessages, /KNOWN_RENEWAL_PLACEHOLDERS = \["nama", "dogs", "tier", "amount", "due_day", "biz"\]/);
  assert.match(validatePlaceholdersFn, /regexp_matches\(p_template, '\\\{\(\[a-zA-Z_\]\+\)\\\}', 'g'\)/);
});

test("S35: buildFollowupMessage does not claim every pet was groomed on the same date when per-pet days differ", () => {
  assert.match(followupMessages, /Rincian per hewan:/);
  assert.match(followupMessages, /const sameDay = input\.pets\.every/);
});

test("S35: buildRenewalMessage never fabricates an amount or a due date -- both are explicit optional/blocked, never invented", () => {
  assert.match(followupMessages, /if \(input\.amountBlockedReason\)/);
  assert.match(followupMessages, /if \(input\.amount === null\)/);
  assert.match(followupMessages, /due_day: input\.dueDay \?\? ""/);
});

test("S35: the settings panel submits the currently-loaded updated_at (optimistic concurrency) and both templates' supported placeholders are shown", () => {
  assert.match(settingsPanel, /name="expectedUpdatedAt" value=\{settings\.updatedAt\}/);
  assert.match(settingsPanel, /KNOWN_FOLLOWUP_PLACEHOLDERS\.map/);
  assert.match(settingsPanel, /KNOWN_RENEWAL_PLACEHOLDERS\.map/);
});

test("S35: the settings action re-validates threshold range and placeholders on the server, not only in the client component", () => {
  assert.match(followupActions, /threshold < 1 \|\| threshold > 365/);
  assert.match(followupActions, /findUnknownPlaceholders\(followupTemplate, KNOWN_FOLLOWUP_PLACEHOLDERS\)/);
  assert.match(followupActions, /findUnknownPlaceholders\(renewalTemplate, KNOWN_RENEWAL_PLACEHOLDERS\)/);
  assert.match(followupActions, /loadCapabilities\(context\.supabase\)\)\["settings\.manage"\]/);
});

test("S35: /programs/memberships?membershipId= is validated, reauthorized via existing RLS-scoped rows, and sanitizes the return path against open redirect", () => {
  assert.match(membershipsPage, /UUID\.test\(params\.membershipId\)/);
  assert.match(membershipsPage, /function sanitizeReturnTo/);
  assert.match(membershipsPage, /\/\^\\\/\[\^\/\\s\]\[\^\\s\]\*\$\//);
  assert.match(membershipsPage, /rows\.some\(\(row\) => row\.id === requestedId\)/);
  assert.match(membershipsPage, /tidak ditemukan atau Anda tidak memiliki akses/);
});

test("S35: the focused membership deep link reuses MembershipManager unmodified (new autoExpand/returnTo props only, no forked renewal action)", () => {
  assert.match(membershipFilterList, /focusMembershipId\?: string \| null; returnTo\?: string \| null/);
  assert.match(membershipManager, /autoExpand\?: boolean; returnTo\?: string \| null/);
  const renewActionCount = (membershipManager.match(/renewCustomerPackageAction/g) ?? []).length;
  assert.ok(renewActionCount <= 2, "expected renewCustomerPackageAction imported+used exactly once each, not duplicated for a focus-mode variant");
});

test("S35: the deep-linked focus row's own effect defers its setState into the transition callback (avoids this repo's react-hooks/set-state-in-effect hard error)", () => {
  const effectStart = membershipManager.indexOf("if (!autoExpand) return;");
  assert.ok(effectStart >= 0, "expected the autoExpand effect guard");
  const effectBody = membershipManager.slice(effectStart, membershipManager.indexOf("}, []);", effectStart));
  assert.doesNotMatch(effectBody, /^\s*setPreviewError\(/m);
  assert.match(effectBody, /startPreview\(async \(\) => \{/);
});

test("S35: buildWhatsAppUrl already handles 0/62/+62/international/malformed numbers correctly (reused, not reimplemented) and copy actions are never recorded as delivery proof", () => {
  assert.match(customer360, /digits\.startsWith\("0"\) \? `62\$\{digits\.slice\(1\)\}` : digits/);
  assert.match(overdueQueue, /bukan bukti pesan sudah terkirim atau dibaca/);
  assert.match(renewalQueue, /bukan invoice/);
});

/**
 * Found live in the browser as the seeded groomer role (booking.read/update/complete only,
 * no membership.read): visiting the renewal tab called loadRenewalQueue straight away, which
 * throws on the RPC's 42501 denial, crashing the whole page into Next.js's generic error
 * boundary instead of an explicit restricted state -- exactly the class of failure
 * authorization.ts's own header comment warns against ("renders an explicit restricted state
 * instead of a zero or an empty list"), just inverted (a denial crashing instead of a denial
 * masquerading as empty). Fixed by checking the capability BEFORE calling the loader.
 */
test("S35: /followups checks booking.read/membership.read up front and renders an explicit restricted state, rather than letting the RPC's authorization denial crash the page", () => {
  const overdueGate = followupsPage.indexOf('tab === "overdue" && !workspace.capabilities["booking.read"]');
  const renewalGate = followupsPage.indexOf('tab === "renewal" && !workspace.capabilities["membership.read"]');
  assert.ok(overdueGate >= 0, "expected an explicit booking.read gate before the overdue loader");
  assert.ok(renewalGate >= 0, "expected an explicit membership.read gate before the renewal loader");
  const overdueLoaderCall = followupsPage.indexOf("loadOverdueQueue(workspace.supabase");
  const renewalLoaderCall = followupsPage.indexOf("loadRenewalQueue(workspace.supabase");
  assert.ok(overdueGate < overdueLoaderCall, "the booking.read gate must run before loadOverdueQueue is ever called");
  assert.ok(renewalGate < renewalLoaderCall, "the membership.read gate must run before loadRenewalQueue is ever called");
});

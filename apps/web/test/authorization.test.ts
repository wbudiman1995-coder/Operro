import assert from "node:assert/strict";
import test from "node:test";

import {
  type BranchAccess,
  CAPABILITY_KEYS,
  filterAccessibleBranches,
  isBranchAccessible,
} from "../src/lib/authorization";
import type { CapabilityMap } from "../src/lib/authorization";
import {
  CUSTOMER_360_TAB_CAPABILITY,
  groupTotalsByCurrency,
  isCustomer360TabPermitted,
  visibleCustomer360Tabs,
} from "../src/lib/customer-360";

function capabilities(overrides: Partial<CapabilityMap> = {}): CapabilityMap {
  const base = Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, false])) as CapabilityMap;
  return { ...base, ...overrides };
}

const BRANCH_A = "018f3e10-7b1a-7c11-8c2a-9a4de6e41601";
const BRANCH_B = "018f3e10-7b1a-7c11-8c2a-9a4de6e41602";

// ---------- branch visibility (correction 3) ----------

test("a membership with explicit grants sees only those branches", () => {
  const access: BranchAccess = { all: false, ids: new Set([BRANCH_A]) };
  const branches = [{ id: BRANCH_A }, { id: BRANCH_B }];
  assert.deepEqual(filterAccessibleBranches(branches, access), [{ id: BRANCH_A }]);
});

test("branches.all sees every organization branch", () => {
  const access: BranchAccess = { all: true, ids: new Set() };
  const branches = [{ id: BRANCH_A }, { id: BRANCH_B }];
  assert.equal(filterAccessibleBranches(branches, access).length, 2);
  assert.equal(isBranchAccessible(access, BRANCH_B), true);
});

test("an inaccessible branch cannot be selected through a query parameter", () => {
  // This is the guard the schedule page relies on: the branch id arrives from the URL,
  // and the organization-scoped branches read alone would have returned it.
  const access: BranchAccess = { all: false, ids: new Set([BRANCH_A]) };
  assert.equal(isBranchAccessible(access, BRANCH_B), false);
  const branches = [{ id: BRANCH_A }, { id: BRANCH_B }];
  const requested = isBranchAccessible(access, BRANCH_B) ? branches.find((b) => b.id === BRANCH_B) : undefined;
  assert.equal(requested, undefined);
  // Falls back to an accessible branch rather than honoring the request.
  assert.equal(filterAccessibleBranches(branches, access)[0].id, BRANCH_A);
});

test("a membership with no branch grants sees nothing", () => {
  const access: BranchAccess = { all: false, ids: new Set() };
  assert.deepEqual(filterAccessibleBranches([{ id: BRANCH_A }], access), []);
  assert.equal(isBranchAccessible(access, BRANCH_A), false);
});

// ---------- capability-aware presentation (correction 2) ----------

test("each permission-bearing tab declares its required capability", () => {
  assert.equal(CUSTOMER_360_TAB_CAPABILITY.bookings, "booking.read");
  assert.equal(CUSTOMER_360_TAB_CAPABILITY.invoices, "finance.read");
  assert.equal(CUSTOMER_360_TAB_CAPABILITY.packages, "membership.read");
  assert.equal(CUSTOMER_360_TAB_CAPABILITY.pets, null);
  assert.equal(CUSTOMER_360_TAB_CAPABILITY.notes, null);
  assert.equal(CUSTOMER_360_TAB_CAPABILITY.history, null);
});

test("unauthorized tabs are not offered", () => {
  const visible = visibleCustomer360Tabs(capabilities());
  assert.deepEqual(visible, ["pets", "notes", "history"]);
  assert.equal(visible.includes("invoices"), false);
});

test("granting a capability reveals exactly its tab", () => {
  assert.deepEqual(visibleCustomer360Tabs(capabilities({ "finance.read": true })), ["pets", "invoices", "notes", "history"]);
  assert.deepEqual(visibleCustomer360Tabs(capabilities({ "booking.read": true })), ["pets", "bookings", "notes", "history"]);
  assert.deepEqual(visibleCustomer360Tabs(capabilities({ "membership.read": true })), ["pets", "packages", "notes", "history"]);
});

test("a tab reached by editing the query string is still denied", () => {
  // The page renders a restricted notice for this case rather than an empty list.
  assert.equal(isCustomer360TabPermitted("invoices", capabilities()), false);
  assert.equal(isCustomer360TabPermitted("invoices", capabilities({ "finance.read": true })), true);
});

test("all capabilities default to denied", () => {
  const map = capabilities();
  for (const key of CAPABILITY_KEYS) assert.equal(map[key], false);
});

// ---------- currency grouping (correction 7) ----------

test("totals are grouped per currency and never added across currencies", () => {
  const totals = groupTotalsByCurrency([
    { amount: 100_000, currency: "IDR" },
    { amount: 50_000, currency: "IDR" },
    { amount: 25, currency: "USD" },
  ]);
  assert.equal(totals.length, 2);
  assert.deepEqual(totals.find((entry) => entry.currency === "IDR"), { currency: "IDR", amount: 150_000 });
  assert.deepEqual(totals.find((entry) => entry.currency === "USD"), { currency: "USD", amount: 25 });
  // The bug being guarded against: 150000 + 25 reported as one IDR figure.
  assert.equal(totals.some((entry) => entry.amount === 150_025), false);
});

test("numeric strings from the database are coerced", () => {
  assert.deepEqual(groupTotalsByCurrency([{ amount: "1500.50", currency: "USD" }]), [{ currency: "USD", amount: 1500.5 }]);
});

test("a missing currency is labelled rather than merged into another", () => {
  const totals = groupTotalsByCurrency([
    { amount: 10, currency: null },
    { amount: 20, currency: "IDR" },
  ]);
  assert.equal(totals.length, 2);
  assert.ok(totals.some((entry) => entry.currency === "UNKNOWN" && entry.amount === 10));
});

test("no payments yields no currency rows, which is distinct from restricted", () => {
  assert.deepEqual(groupTotalsByCurrency([]), []);
});

test("currency rows are ordered by amount descending", () => {
  const totals = groupTotalsByCurrency([
    { amount: 5, currency: "USD" },
    { amount: 900, currency: "IDR" },
  ]);
  assert.equal(totals[0].currency, "IDR");
});

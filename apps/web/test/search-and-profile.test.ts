import assert from "node:assert/strict";
import test from "node:test";

import { ageLabelFromBirthdate, readCustomFields, readMedicalFlags, sizeBandForWeight } from "../src/lib/grooming-profile";
import { SEARCH_MIN_TERM_LENGTH, escapeLikePattern, mergeHitsById, normalizeSearchTerm } from "../src/lib/search";

test("requires a minimum term length", () => {
  assert.equal(normalizeSearchTerm("a"), null);
  assert.equal(normalizeSearchTerm(" "), null);
  assert.equal(normalizeSearchTerm(""), null);
  assert.equal(normalizeSearchTerm("bu"), "bu");
  assert.equal(SEARCH_MIN_TERM_LENGTH, 2);
});

test("trims surrounding whitespace and caps length", () => {
  assert.equal(normalizeSearchTerm("  budi  "), "budi");
  assert.equal(normalizeSearchTerm("x".repeat(200))?.length, 64);
});

test("rejects non-string input", () => {
  assert.equal(normalizeSearchTerm(null), null);
  assert.equal(normalizeSearchTerm(42), null);
  assert.equal(normalizeSearchTerm(["budi"]), null);
});

test("escapes LIKE metacharacters so a query cannot widen its own match", () => {
  // Unescaped, a bare "%" would match every row in the table.
  assert.equal(escapeLikePattern("%"), "\\%");
  assert.equal(escapeLikePattern("_"), "\\_");
  assert.equal(escapeLikePattern("50%_off"), "50\\%\\_off");
  assert.equal(escapeLikePattern("back\\slash"), "back\\\\slash");
  assert.equal(escapeLikePattern("budi"), "budi");
});

// ---------- filter-injection safety (correction 5) ----------

/**
 * These characters are the reason customer search no longer builds a PostgREST `.or()`
 * string. In `.or()` syntax a comma separates filter terms and parentheses group them, so
 * a term containing them restructures the filter even though LIKE escaping is applied.
 * `.ilike()` passes the pattern as one bound value, so these are inert.
 */
const HOSTILE_TERMS = [
  "budi,jane",
  "budi(jane)",
  "budi)",
  "a,b,c",
  "\"budi\"",
  "'budi'",
  "50%",
  "a_b",
  "back\\slash",
  "display_name.eq.admin",
  "**",
];

test("hostile terms survive normalization without being rejected outright", () => {
  for (const term of HOSTILE_TERMS) {
    assert.equal(normalizeSearchTerm(term), term.trim(), `term should normalize: ${term}`);
  }
});

test("LIKE metacharacters are escaped and no others are introduced", () => {
  assert.equal(escapeLikePattern("50%"), "50\\%");
  assert.equal(escapeLikePattern("a_b"), "a\\_b");
  assert.equal(escapeLikePattern("back\\slash"), "back\\\\slash");
  assert.equal(escapeLikePattern("100%_x\\y"), "100\\%\\_x\\\\y");
});

test("PostgREST structural characters pass through as ordinary text", () => {
  // Commas, parentheses and quotes are filter *syntax* in .or(). They are left as-is here
  // because they are now sent as a bound value to .ilike(), where they carry no meaning.
  for (const term of ["budi,jane", "budi(jane)", "budi)", '"budi"', "'budi'", "a,b,c"]) {
    assert.equal(escapeLikePattern(term), term, `term should pass through unchanged: ${term}`);
  }
});

test("an injected filter fragment stays a literal search term", () => {
  const injected = "x,display_name.ilike.*";
  // The comma and dots survive as text; the underscore is escaped because it is a LIKE
  // wildcard. Neither can change the structure of the query.
  assert.equal(escapeLikePattern(injected), "x,display\\_name.ilike.*");
  assert.equal(normalizeSearchTerm(injected), injected);
});

test("a single character is rejected before any query is built", () => {
  assert.equal(normalizeSearchTerm("*"), null);
  assert.equal(normalizeSearchTerm("%"), null);
});

test("deduplicates customers matched by both name and phone", () => {
  const byName = [{ id: "c1", title: "Budi", subtitle: "0812", href: "/customers/c1" }];
  const byPhone = [
    { id: "c1", title: "Budi", subtitle: "0812", href: "/customers/c1" },
    { id: "c2", title: "Budiman", subtitle: "0813", href: "/customers/c2" },
  ];
  const merged = mergeHitsById(byName, byPhone);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map((hit) => hit.id), ["c1", "c2"]);
});

test("merge preserves first-seen ordering and tolerates empty inputs", () => {
  assert.deepEqual(mergeHitsById([], []), []);
  const merged = mergeHitsById([{ id: "b", title: "B", subtitle: null, href: "/b" }], [{ id: "a", title: "A", subtitle: null, href: "/a" }]);
  assert.deepEqual(merged.map((hit) => hit.id), ["b", "a"]);
});

test("derives grooming size bands from weight", () => {
  assert.equal(sizeBandForWeight(4), "S");
  assert.equal(sizeBandForWeight(10), "S");
  assert.equal(sizeBandForWeight(10.1), "M");
  assert.equal(sizeBandForWeight(25), "M");
  assert.equal(sizeBandForWeight(30), "L");
  assert.equal(sizeBandForWeight(40), "L");
  assert.equal(sizeBandForWeight(55), "XL");
});

test("returns no size band for missing or invalid weight", () => {
  assert.equal(sizeBandForWeight(null), null);
  assert.equal(sizeBandForWeight(0), null);
  assert.equal(sizeBandForWeight(-3), null);
  assert.equal(sizeBandForWeight(Number.NaN), null);
});

test("renders age from a birthdate", () => {
  const now = new Date("2026-08-02T00:00:00Z");
  assert.equal(ageLabelFromBirthdate("2026-05-02", now), "3 bulan");
  assert.equal(ageLabelFromBirthdate("2024-08-02", now), "2 tahun");
  assert.equal(ageLabelFromBirthdate("2024-02-02", now), "2 tahun 6 bulan");
  // Exact anniversaries must not round down; an average-month divisor reported
  // "1 tahun 11 bulan" here.
  assert.equal(ageLabelFromBirthdate("2025-08-02", now), "1 tahun");
  assert.equal(ageLabelFromBirthdate("2016-08-02", now), "10 tahun");
  // One day before the anniversary is still the previous month.
  assert.equal(ageLabelFromBirthdate("2024-08-03", now), "1 tahun 11 bulan");
  assert.equal(ageLabelFromBirthdate("2026-08-02", now), "0 bulan");
});

test("rejects unusable birthdates including future dates", () => {
  const now = new Date("2026-08-02T00:00:00Z");
  assert.equal(ageLabelFromBirthdate(null, now), null);
  assert.equal(ageLabelFromBirthdate("not-a-date", now), null);
  assert.equal(ageLabelFromBirthdate("2027-01-01", now), null);
});

test("surfaces only scalar metadata as custom fields", () => {
  const fields = readCustomFields({ coat: "double", visits: 4, vip: true, blank: "  ", nested: { a: 1 }, list: [1, 2] });
  assert.deepEqual(fields, [
    { label: "coat", value: "double" },
    { label: "visits", value: "4" },
    { label: "vip", value: "Ya" },
  ]);
});

test("tolerates non-object metadata", () => {
  assert.deepEqual(readCustomFields(null), []);
  assert.deepEqual(readCustomFields("string"), []);
  assert.deepEqual(readCustomFields([1, 2]), []);
});

test("reads medical flags from both object and array shapes", () => {
  assert.deepEqual(readMedicalFlags({ allergy: true, skin: "sensitive", none: false }), ["allergy", "skin: sensitive"]);
  assert.deepEqual(readMedicalFlags(["kutu", " jamur "]), ["kutu", "jamur"]);
  assert.deepEqual(readMedicalFlags(null), []);
});

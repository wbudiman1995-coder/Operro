import assert from "node:assert/strict";
import test from "node:test";

import { isValidLayoutPayload } from "../src/lib/size-bands";

const base = { upper_kg: 5, upper_inclusive: false };
const payload = (label: string) => [{ ...base, label }];

test("catalog action accepts valid labels from 1 to 40 trimmed characters", () => {
  assert.equal(isValidLayoutPayload(payload("X")), true);
  assert.equal(isValidLayoutPayload(payload("a".repeat(40))), true);
});

test("catalog action rejects empty and whitespace-only labels", () => {
  assert.equal(isValidLayoutPayload(payload("")), false);
  assert.equal(isValidLayoutPayload(payload(" \t\n")), false);
});

test("catalog action rejects a 41-character trimmed label", () => {
  assert.equal(isValidLayoutPayload(payload("a".repeat(41))), false);
});

test("catalog action allows surrounding whitespace on an otherwise valid label", () => {
  assert.equal(isValidLayoutPayload(payload("  XS  ")), true);
  assert.equal(isValidLayoutPayload(payload(`  ${"a".repeat(40)}  `)), true);
});

test("catalog action preserves the remaining payload guards", () => {
  assert.equal(isValidLayoutPayload([]), false);
  assert.equal(isValidLayoutPayload(Array.from({ length: 13 }, () => ({ ...base, label: "X" }))), false);
  assert.equal(isValidLayoutPayload([{ ...base, label: "X", upper_kg: Number.POSITIVE_INFINITY }]), false);
  assert.equal(isValidLayoutPayload([{ ...base, label: "X", upper_inclusive: "false" }]), false);
  assert.equal(isValidLayoutPayload([{ ...base, label: "X", id: "not-a-uuid" }]), false);
  assert.equal(isValidLayoutPayload([{ ...base, label: "X", id: "00000000-0000-4000-8000-000000000001" }]), true);
});

import assert from "node:assert/strict";
import test from "node:test";

import { canonicalRegionNames, districtsForRegency } from "../src/lib/indonesia-regions";

test("official Jakarta hierarchy accepts a valid address and rejects a district from another city", () => {
  assert.deepEqual(canonicalRegionNames({
    province: "Daerah Khusus Ibukota Jakarta", kabupatenKota: "Kota Administrasi Jakarta Selatan", kecamatan: "Kebayoran Baru",
  }), {
    province: "Daerah Khusus Ibukota Jakarta", kabupatenKota: "Kota Administrasi Jakarta Selatan", kecamatan: "Kebayoran Baru",
  });
  assert.equal(canonicalRegionNames({
    province: "Daerah Khusus Ibukota Jakarta", kabupatenKota: "Kota Administrasi Jakarta Selatan", kecamatan: "Menteng",
  }), null);
  assert.ok(districtsForRegency("31.74").some((district) => district.name === "Kebayoran Baru"));
});

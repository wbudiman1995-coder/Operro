import assert from "node:assert/strict";
import test from "node:test";
import { parseBookingChat } from "../src/lib/booking-chat-parser";

test("parses a HomePaw booking chat into one customer and multiple pets", () => {
  const parsed = parseBookingChat(`Nama Owner: Cynthia Tan\nWhatsApp: 0812-3456-7890\nAlamat lengkap: Jl. Mawar 10\nKota: Jakarta Selatan\nKecamatan: Kebayoran Baru\nGmaps link: https://www.google.com/maps/@-6.2431,106.7991,17z\nNama anabul: Milo dan Mochi\nBreed: Poodle dan Persian\nUmur: 3 tahun dan 2 tahun\nBerat: 6 kg dan 4,5 kg\nWarna Bulu: Putih dan Cream\nSpecial note: Takut blower dan Kucing`);
  assert.equal(parsed.customerName, "Cynthia Tan");
  assert.equal(parsed.phone, "+6281234567890");
  assert.equal(parsed.pets.length, 2);
  assert.deepEqual(parsed.pets.map((pet) => pet.name), ["Milo", "Mochi"]);
  assert.equal(parsed.pets[1].species, "cat");
  assert.equal(parsed.pets[1].weightKg, 4.5);
  assert.equal(parsed.latitude, -6.2431);
});

test("shares a single pet field value across every parsed pet", () => {
  const parsed = parseBookingChat("Owner: Andi\nNama anabul: A, B & C\nBreed: Pomeranian\nCatatan: Friendly");
  assert.equal(parsed.pets.length, 3);
  assert.deepEqual(parsed.pets.map((pet) => pet.breed), ["Pomeranian", "Pomeranian", "Pomeranian"]);
});

test("caps imports at ten pets and tolerates unrelated chat lines", () => {
  const parsed = parseBookingChat(`Halo admin\nNama customer: Dewi\nNama pet: ${Array.from({ length: 12 }, (_, index) => `Pet${index + 1}`).join(", ")}\nTerima kasih`);
  assert.equal(parsed.pets.length, 10);
  assert.equal(parsed.customerName, "Dewi");
});

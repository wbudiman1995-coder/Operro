/** Optional, org-scoped starter values transcribed from the owner's reference images.
 * Newer printed price list wins where it differs from the older admin grid.
 * Existing service rows are never overwritten by importing this template.
 */
export const HOMEPAW_STARTER_SERVICES = [
  { name: "Basic Grooming", category: "Basic Grooming", prices: [99000, 120000, 170000, 230000, 269000, 120000], durations: [60, 60, 90, 120, 120, 60] },
  { name: "Botak", category: "Styling", prices: [60000, 60000, 70000, 80000, 80000, 60000], durations: [30, 30, 30, 30, 30, 30] },
  { name: "Styling", category: "Styling", prices: [100000, 100000, 120000, 140000, 140000, 100000], durations: [60, 60, 60, 60, 60, 60] },
  { name: "Dematting", category: "Special Charges", prices: [50000, 50000, 50000, 50000, 50000, 50000], durations: [30, 30, 30, 30, 30, 30] },
  { name: "Deshedding", category: "Special Charges", prices: [50000, 50000, 50000, 50000, 50000, 50000], durations: [30, 30, 30, 30, 30, 30] },
  { name: "Anti Fungal", category: "Special Charges", prices: [50000, 50000, 55000, 60000, 60000, 50000], durations: [0, 0, 0, 0, 0, 0] },
  { name: "Anti Kutu", category: "Special Charges", prices: [25000, 25000, 30000, 35000, 35000, 25000], durations: [0, 0, 0, 0, 0, 0] },
  { name: "Premium Whitening Shampoo", category: "Special Charges", prices: [50000, 50000, 75000, 100000, 100000, 50000], durations: [0, 0, 0, 0, 0, 0] },
  { name: "Whitening", category: "Special Charges", prices: [15000, 15000, 20000, 25000, 30000, 15000], durations: [0, 0, 0, 0, 0, 0] },
  { name: "Parfume", category: "Special Charges", prices: [0, 0, 0, 0, 0, 0], durations: [0, 0, 0, 0, 0, 0] },
] as const;

export const HOMEPAW_MEMBERSHIP_TIERS = [
  { key: "weekly", name: "Paw Prime", frequency: "1x/minggu", visitIntervalDays: 7, sessions: 4, discountPercent: 15, recurrenceInterval: "month", validityDays: 31 },
  { key: "monthly", name: "Paw Basic", frequency: "1x/bulan", visitIntervalDays: 30, sessions: 1, discountPercent: 5, recurrenceInterval: "month", validityDays: 31 },
  { key: "biweekly", name: "Paw Essential", frequency: "1x/2 minggu", visitIntervalDays: 14, sessions: 2, discountPercent: 10, recurrenceInterval: "month", validityDays: 31 },
] as const;

export function starterServiceRow(organizationId: string, item: (typeof HOMEPAW_STARTER_SERVICES)[number]) {
  const [xs, s, m, l, xl, cat] = item.prices;
  const [dxs, ds, dm, dl, dxl, dcat] = item.durations;
  return {
    organization_id: organizationId, name: item.name, category: item.category, currency: "IDR",
    base_price: xs, price_extra_small: xs, price_small: s, price_medium: m,
    price_large: l, price_extra_large: xl, price_cat: cat,
    duration_minutes: dxs, duration_extra_small: dxs, duration_small: ds,
    duration_medium: dm, duration_large: dl, duration_extra_large: dxl, duration_cat: dcat,
    additional_duration_minutes: 0, required_photos: item.name === "Basic Grooming" ? 2 : 0,
    fulfillment_modes: ["home", "in_store"], is_active: true,
    metadata: { created_from: "homepaw_starter_template" },
  };
}

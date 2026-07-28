/**
 * Feature keys.
 *
 * Features are the fine-grained, data-driven capabilities within a module
 * (migration 0003). Because they are configurable per plan/organization, the
 * type stays open (branded string) while well-known keys are enumerated for
 * autocomplete. Unknown-at-compile-time keys remain valid at runtime — the
 * database `features` catalog is the authority.
 */
import type { Brand } from "../ids.js";

export type FeatureKey = Brand<string, "FeatureKey">;

export const FEATURES = {
  HOME_SERVICE_ETA: "scheduling.home_service_eta",
  ROUTE_OPTIMIZATION: "scheduling.route_optimization",
  ONLINE_BOOKING: "scheduling.online_booking",
  LOYALTY: "membership.loyalty",
  WALLET: "membership.wallet",
  PACKAGES: "membership.packages",
  MULTI_CURRENCY: "finance.multi_currency",
} as const satisfies Record<string, string>;

/** Cast an arbitrary feature string to a FeatureKey at a trust boundary. */
export const toFeatureKey = (value: string): FeatureKey => value as FeatureKey;

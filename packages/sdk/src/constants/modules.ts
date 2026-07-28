/**
 * Module keys — mirror the `modules` catalog (migrations 0003 / 0011).
 * A module is the coarse capability gate; disabling one hides its whole
 * domain regardless of permissions.
 */
export const MODULES = {
  SCHEDULING: "scheduling",
  CRM: "crm",
  INVENTORY: "inventory",
  FINANCE: "finance",
  PAYROLL: "payroll",
  POS: "pos",
  REPORTS: "reports",
  MARKETING: "marketing",
  NOTIFICATIONS: "notifications",
  MEMBERSHIP: "membership",
} as const;

export type ModuleKey = (typeof MODULES)[keyof typeof MODULES];

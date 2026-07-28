/**
 * Permission keys — the single source of truth for the strings the database
 * permission catalog stores (migrations 0002 / 0011). Application code
 * references PERMISSIONS.BOOKING_CREATE, never the raw literal (Rule 54).
 */
export const PERMISSIONS = {
  // identity / config
  USERS_MANAGE: "users.manage",
  ROLES_MANAGE: "roles.manage",
  BRANCHES_MANAGE: "branches.manage",
  BRANCHES_ALL: "branches.all",
  SETTINGS_MANAGE: "settings.manage",
  REPORTS_VIEW: "reports.view",
  // customer
  CUSTOMER_READ: "customer.read",
  CUSTOMER_MANAGE: "customer.manage",
  // booking
  BOOKING_READ: "booking.read",
  BOOKING_CREATE: "booking.create",
  BOOKING_UPDATE: "booking.update",
  BOOKING_DELETE: "booking.delete",
  BOOKING_CANCEL: "booking.cancel",
  BOOKING_COMPLETE: "booking.complete",
  // catalog / resources
  RESOURCE_MANAGE: "resource.manage",
  SERVICE_MANAGE: "service.manage",
  PRODUCT_MANAGE: "product.manage",
  // inventory
  INVENTORY_READ: "inventory.read",
  INVENTORY_ADJUST: "inventory.adjust",
  INVENTORY_MANAGE: "inventory.manage",
  // sales / finance
  ORDER_READ: "order.read",
  ORDER_MANAGE: "order.manage",
  FINANCE_READ: "finance.read",
  INVOICE_ISSUE: "invoice.issue",
  PAYMENT_MANAGE: "payment.manage",
  EXPENSE_MANAGE: "expense.manage",
  FINANCE_MANAGE: "finance.manage",
  // payroll
  PAYROLL_READ: "payroll.read",
  PAYROLL_MANAGE: "payroll.manage",
  PAYROLL_APPROVE: "payroll.approve",
  // customer programs
  MEMBERSHIP_READ: "membership.read",
  MEMBERSHIP_MANAGE: "membership.manage",
  // operations
  TASK_MANAGE: "task.manage",
  SOP_MANAGE: "sop.manage",
} as const;

export type PermissionKey = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

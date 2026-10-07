# DeepSeek outsourcing queue

Upload `Operro-DeepSeek-Base-8bef156.zip` to DeepSeek. Ask it to read `00_COMMON_INSTRUCTIONS.md`, then give it exactly one numbered prompt. Send the returned patch/files and handoff back to Codex for review. Do not send the next prompt until Codex supplies a refreshed source bundle or confirms that the next task is independent.

The queue covers every incomplete section in the 44-section audit. Each prompt contains at most two owner-facing features or one architectural foundation.

Recommended order:

1. `01_CUSTOMER_CODE.md`
2. `02_CRM_BULK_EDIT.md`
3. `03_CUSTOMER_PET_EDITING.md`
4. `04_PET_PROFILE_COUNTER.md`
5. `05_DASHBOARD_ANALYTICS.md`
6. `06_CONFIG_PREFERENCES.md`
7. `07_DYNAMIC_SIZE_FOUNDATION.md`
8. `08_DYNAMIC_SIZE_PRICING_BOOKING.md`
9. `09_DYNAMIC_SIZE_PACKAGE_PAYROLL.md`
10. `10_CUSTOM_FIELDS_FOUNDATION.md`
11. `11_CUSTOM_FIELDS_INTEGRATION.md`
12. `12_FINANCE_OPERATIONS.md`
13. `13_AUDIT_RECONCILIATION.md`
14. `14_ORG_BACKUP.md`
15. `15_WHATSAPP_CENTER.md`
16. `16_ACCESS_STORAGE_MAINTENANCE.md`
17. `17_RELIABILITY_RECOVERY.md`

Prompts 8–9 require prompt 7 to be reviewed and integrated. Prompt 11 requires prompt 10. All prompts should use the newest Codex-approved bundle, not silently stack patches on the original snapshot.

The current Operro platform owner is intentionally a superuser. `wbudiman1995@gmail.com` may identify business owners, enter all workspaces (including suspended businesses), and inspect/change a business Admin checklist. Tenant Admins may not manage that checklist. The `Bantuan Operro` support role must remain unable to access payroll, finance reporting, or access management. This policy supersedes older handoffs that excluded the platform owner.


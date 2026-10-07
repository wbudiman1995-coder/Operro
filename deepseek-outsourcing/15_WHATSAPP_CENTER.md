# Assignment 15 — WhatsApp draft center and delivery log (#34)

Implement at most two features, without automatically sending messages:

1. A unified tenant-scoped queue of invoice, follow-up, renewal, and onboarding WhatsApp drafts generated from existing templates and existing `wa.me` behavior.
2. An auditable manual delivery-status log (draft/opened/marked-sent/failed/canceled) with actor/time, explicitly labeled as user-reported rather than provider-confirmed.

Do not integrate an unofficial WhatsApp API, scrape WhatsApp Web, or claim delivery confirmation. Reuse current templates and phone normalization. Require relevant source-record read permissions and a narrow messaging capability for status writes. Test opt-out/missing phone, template variables, duplicate clicks/idempotency, cross-tenant records, archived source records, and audit history.


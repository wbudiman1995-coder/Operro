# Official WhatsApp provider: setup and decisions (parity #34)

Status in this repository: **boundary only, disabled, nothing sends.** Operro creates drafts that a person opens in WhatsApp and reports on. No code path sends a message, receives a webhook or stores a delivered or read state. This runbook lists what must be decided and set up outside the repository before an official provider could be enabled, and what the code already prepares.

## What exists now

| Piece | Where | Behavior |
|---|---|---|
| Disabled provider and pure helpers | `apps/web/src/lib/whatsapp-provider.ts` | `getWhatsAppProvider()` returns a provider whose `sendTemplate` always throws. Helpers validate a Meta template-message request, verify a webhook signature against a secret passed in, answer the verification handshake and normalize status events (recipient numbers are dropped). The module reads no environment variable and makes no request. A test fails if any other application file calls it to send. |
| Platform gate | `public.platform_flags` row `whatsapp_provider_available` (migration `20261101120000`) | Seeded `false`. No function and no application code can change it. Turning it on is an operator act after the decisions below. |
| Organization preparation | `/settings/whatsapp-provider`, `app.set_whatsapp_provider_settings` | Business owner only. Stores a provider choice, two numeric identifiers (phone-number id, business-account id) and a dated attestation that customers consented. Never stores a token, secret, password or URL. Enabling is refused by the database while the platform gate is closed, and the page offers only a disabled control. |
| Existing draft contract | `whatsapp_drafts`, `whatsapp_draft_events` | Statuses after `draft` stay user reports. No `delivered` or `read` status exists and none is added until a provider delivers them. |

## Decisions the owner (and the platform owner) must take

1. **Provider and account.** The official Meta WhatsApp Business Cloud API, or another provider with its own official API. Unofficial senders, scrapers and "WhatsApp Web automation" are not acceptable and are not built.
2. **Business verification.** A verified Meta business, a WhatsApp Business Account (WABA), and a phone number owned by the business (not a personal number). The phone-number id and WABA id are the two values the settings page records.
3. **Message templates.** Business-initiated messages need templates approved by Meta (language, category, variables). Decide which Operro messages become templates (invoice reminder, follow-up, renewal) and who owns their wording. The builder supports body parameters only.
4. **Customer consent.** Meta requires opt-in. Decide the consent wording, where it is collected (registration form, in person), where it is stored, and how a customer opts out. The Pusat WhatsApp already skips customers who opted out; the settings page records only the owner's attestation, not each customer's consent.
5. **Credentials.** The access token and app secret live only in the hosting provider's secret store (for example Vercel environment variables), never in the database, the repository, a log or the browser. Decide who holds them, how they rotate and who can read them.
6. **Webhook receiver and service identity.** Provider status reaches Operro only by webhook. A webhook has no signed-in user, so it needs an identity of its own. This repository has none today. The model proposed in `docs/agent-work/FINAL-PARITY-OPERATIONS-DESIGN.md` (decision D7) is a dedicated Supabase Auth user registered by the platform owner and limited to narrow RPCs, never the service-role key in the web app. The platform owner must decide this once for both webhooks and the cleanup runner.
7. **Staging.** A staging WABA or the provider's test number, with a staging Supabase project and a staging deployment, and a written test plan (below). No production number is used for testing.

## Setup checklist (for the person doing it; none of this was done)

1. Create or confirm the Meta business and complete business verification.
2. Create the WABA, add the number, set the display name, and note the phone-number id and WABA id.
3. Create and submit message templates; wait for approval.
4. Create a system user and a long-lived token with the minimum permissions; store it only in the secret store. Store the app secret the same way.
5. Choose a webhook verify token (random, 32+ characters) and store it in the secret store.
6. Deploy a webhook endpoint (a separate, reviewed change) that: answers the verification handshake with `answerMetaChallenge`, rejects every POST whose `X-Hub-Signature-256` fails `verifyMetaSignature` on the raw body, parses with `parseMetaStatusEvents`, and records events through an RPC that only the registered service identity may call. Return 200 quickly and process idempotently, because Meta retries.
7. Review and apply the migration that adds the event table and the new draft statuses (they do not exist yet), with role tests.
8. A platform-owner operator statement sets `whatsapp_provider_available` to `true` only for the staging project first.

## Staging test plan (to run before any production use)

| # | Check | Expected |
|---|---|---|
| 1 | Webhook handshake with the right and a wrong verify token | Right: challenge echoed. Wrong: 403. |
| 2 | POST with a valid signature, a tampered body, and no signature | Valid: accepted. The others: rejected with no database write. |
| 3 | Send one approved template to a test number | One message; a `sent` then `delivered` then `read` event recorded once each, even if Meta retries. |
| 4 | Send to a number that blocked the business | A `failed` event with an error code and no raw provider text stored. |
| 5 | Customer who opted out | No message is created. |
| 6 | Disable the organization's provider setting | No further sends from that organization; webhooks for old messages still record. |
| 7 | Rotate the token and the app secret | Old values stop working; no code or database change needed. |
| 8 | Cross-tenant | An event for organization A's message is never visible to organization B. |

## What this runbook does not claim

No provider account exists, no webhook is deployed, no message has been sent, and no delivered or read status can appear in Operro. Until the steps above are done and the platform gate is opened by an operator, the Pusat WhatsApp wording stays: statuses are a person's report.

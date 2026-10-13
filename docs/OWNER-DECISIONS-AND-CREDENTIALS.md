# Owner decisions and credentials needed next

Short list. Each item says what is blocked until it is answered. Numbers match the design document (`docs/agent-work/FINAL-PARITY-OPERATIONS-DESIGN.md`).

## Decisions (no credential needed)

| # | Decision | Blocks | Recommended default |
|---|---|---|---|
| D1 | Accept the ROI rule: customers created in the period, cash collected in the same period, per source and currency, against manually recorded spend. Or require a longer attribution window later. Also who may record spend (default `finance.manage` with all-branch access). | Calling parity row #1 closed | Accept as is; treat as a simple return, not campaign ROI. |
| D2 | Cash mappings: which account receives each payment method per branch, where expenses and payroll are paid from, the cutover date and each account's opening balance. | Trusting the cash-on-hand figure (#31) | Map cash and bank transfer first; leave others unmapped and watch the "not in balance" list. |
| D3 | WhatsApp: official provider and account, who holds credentials, customer consent wording and collection, whether webhooks are wanted. | #34 beyond Partial | Meta WhatsApp Cloud API, staging number first. |
| D4 | Restore drills: who runs them, on which disposable database, and whether a self-service importer is ever wanted (not proposed). | Closing #38 | Quarterly drill by the platform owner using kind C. |
| D5 | Source labels: keep as suggestions (recommended) or move to a closed list with a plan for existing free text. | Nothing; behavior is already safe | Keep suggestions. |
| D6 | Run the hosted real-mail invitation and multi-organization QC. | #41 beyond Partial | Run `STAGING_ACCESS_QC.md` on staging. |
| D7 | Scheduler (Vercel Cron or Supabase scheduled function) and service identity (a dedicated Auth user registered by the platform owner, never the service-role key in the web app), cadence, per-run limit, alert channel. | #43 (Blocked) | Dedicated runner user with a registry kill switch, weekly cadence, one organization per run. |
| D8 | Who performs and signs recovery drills, target cadence, and the staging or disposable project to use. | #44 beyond Partial | Quarterly; record every drill. |

## Credentials and access you must provide (to people or systems, never to this repository)

None are needed to review or merge this branch. For the hosted steps above:

1. A **staging** Supabase project and a **staging** Vercel deployment (never production) for D6 and D4.
2. Three or four mailboxes you control for the access QC (owner, admin, helper, stranger).
3. For D3 only: Meta business verification, a WhatsApp Business Account and number, approved templates, an access token and app secret held in the hosting provider's secret store, and a webhook verify token. Do not paste these into chat, code or the database.
4. For D7 only: the runner account's e-mail and password in the hosting secret store.

Nothing in this batch contacted any provider, used a secret, created a real record or enabled an integration.

# Cost-controlled parity execution

Base branch: `codex/parity-orchestration` at `d4ee76d4882ca4b4c73524c4fea175f9a669f81b`.

This directory is the dispatch and integration contract for external coding agents. The current repository is not yet delegated to an external account: these documents make the work small, reviewable, and safe to dispatch when the chosen DeepSeek or Claude chat is available.

## Roles

| Owner | Responsibility | Must not do |
|---|---|---|
| DeepSeek | Small, isolated application/database slices with focused tests. | Deploy, merge, alter a remote Supabase project, create real invoices/invitations, or expand the assigned scope. |
| Claude | Cross-module design and the resulting high-risk implementation after Codex accepts that design. | Rebuild unrelated systems, silently alter historical migrations, or assume production data access. |
| Codex | Prepare sanitized bundles; allocate migration versions; inspect every patch; run migration, RLS, typecheck, lint, build, and browser gates; integrate or reject work. | Treat an agent's statement that work is complete as proof, or stack unreviewed patches. |

## Dispatch status

The first two dispatches were intentionally independent:

1. **DeepSeek — persistent customer code:** completed, reviewed, and integrated as `7f12316`; its migration is `20261022110000_customer_codes.sql`.
2. **Claude — dynamic size-band design:** completed and accepted. The response is [CLAUDE-DYNAMIC-SIZE-DESIGN-RESPONSE.md](CLAUDE-DYNAMIC-SIZE-DESIGN-RESPONSE.md).
3. **DeepSeek — CRM bulk edit:** reviewed, corrected, integrated, and validated on `codex/parity-orchestration`; live browser QC remains.

The next dispatch is **Claude — dynamic size bands, Bundle 1 DB foundation**. Use [CLAUDE-DYNAMIC-SIZE-BUNDLE-1.md](CLAUDE-DYNAMIC-SIZE-BUNDLE-1.md) and the refreshed `Operro-Claude-Dynamic-Size-Bundle-1-d4ee76d.zip`. Migration slots `20261023100000` through `20261023130000` are reserved for this bundle.

Do not begin Bundle 2 until Codex has reviewed and integrated Bundle 1 from its exact returned branch.

## Ordered delivery queue

| Order | Owner | Scope | Dependency |
|---:|---|---|---|
| 0 | Codex | Review current tree, allocate migration versions, prepare bundles. | Current baseline |
| 1 | DeepSeek | Persistent customer code. | None |
| 2 | Codex | Review/integrate customer code; regenerate bundle. | 1 |
| 3 | DeepSeek | CRM bulk edit, using persisted customer code only if it adds real value. | 2 |
| 4 | Claude | Dynamic-size implementation from the accepted design. | Claude design + Codex review |
| 5 | Codex | Migration/upgrade/RLS/browser integration for dynamic sizes. | 4 |
| 6 | DeepSeek | Customer 360 and standalone pet editing. | 5, because pet size must use the stable band model |
| 7 | DeepSeek | Business settings and personal preferences. | 6 |
| 8 | DeepSeek | Dashboard comparison/cards and audit labels/review UI. | 7 |
| 9 | Claude | Finance operations and reconciliation design, then implementation as separately approved tasks. | 5 |
| 10 | Claude | Backup/restore, storage accounting, and recovery architecture. | 9 design review |
| 11 | Codex | Multi-org, permission, production, and browser QC; release reconciliation. | All accepted work |

## Acceptance rule for every returned patch

Codex accepts a patch only after all applicable checks pass from the exact branch that will be integrated:

1. `git apply --check` or a clean branch diff against the declared base.
2. New migrations are forward-only, chronologically allocated, and added to `run_all_gates.sh`.
3. Fresh PostgreSQL 16 migration and populated-upgrade evidence for data/schema changes.
4. Explicit tenant/branch authorization and cross-tenant denial evidence for access-sensitive changes.
5. Focused tests plus web typecheck, lint, and production build.
6. Browser verification for user-facing changes, including a lower-permission role where relevant.
7. An honest handoff listing what was not run or verified.

## Cost controls

- Send one assignment per chat, not an omnibus backlog.
- Send a curated source manifest, never credentials, `.env*`, `node_modules`, production dumps, or full unrelated logs.
- Use DeepSeek for low-risk bounded patches and Claude for architecture/high-coupling work only.
- Require Claude to design before implementing high-risk database work.
- Keep generated patches out of the base branch until Codex review.
- Do not run two tasks that introduce migrations at the same time.

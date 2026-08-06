# creat-web v1 Corrected Master Execution Plan v3

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans`. No application task may begin until the general review gate is satisfied.

**Goal:** Execute the fully corrected `creat-web v1` design without modifying Quick I Ching.

**Status:** blocked pending independent review of the complete corrected design/plan stack and owner approval.

## 1. Binding reading order

Read and apply in this exact order:

1. The five original specifications under `docs/specs/`.
2. `docs/specs/creat-web-v1-gemini-review-resolution.md`.
3. `docs/specs/creat-web-v1-auth-critical-clarifications.md`.
4. `docs/specs/creat-web-v1-second-review-resolution.md`.
5. `docs/superpowers/plans/2026-08-06-creat-web-master-execution-plan.md`.
6. `docs/superpowers/plans/2026-08-06-creat-web-execution-preflight.md`.
7. `docs/superpowers/plans/2026-08-06-creat-web-gemini-review-corrections.md`.
8. `docs/superpowers/plans/2026-08-06-creat-web-second-review-corrections.md`.
9. The current phase plan.

Precedence, highest first:

```text
second-review execution corrections
second-review design resolution
critical authentication clarifications
Gemini review execution corrections
Gemini review design resolution
original execution preflight
phase plan
original master execution plan
original specifications
```

## 2. Phase order

1. Foundation
2. Authentication and retained account subject
3. SEO, homepage and legal foundation
4. Commerce and Waffo one-time payment
5. Credit ledger
6. Subscriptions and refunds
7. Security, operations and release

## 3. Mandatory corrected invariants

- Quick I Ching is read-only.
- Better Auth user is the active authentication identity; retained records use non-authentication `account_subjects.id`.
- Magic Link and any destructive email action use non-consuming GET plus explicit protected POST.
- Better Auth response cookies are returned intact after verification.
- Disabled providers have no eager environment validation or client construction.
- Waffo display amounts normalize to reviewed `BIGINT` minor units.
- Known processed webhook events persist only allowlisted normalized facts and no raw body.
- Exceptional raw webhook retention is encrypted, purpose-limited, time-bounded and purged by an observable idempotent job.
- Invalid-signature bodies are not retained.
- Credit expiry never expires active reservation allocations.
- A valid reservation may commit after its source grant expiry.
- Releasing a reservation after grant expiry cannot recreate available balance; released units expire atomically or through a uniquely chained job.
- Non-production emits no canonical or sitemap and uses layered noindex/access control.
- Analytics makes zero third-party requests before consent and on forced-disabled sensitive routes.
- `past_due` access uses a persisted grace deadline and never grants renewal credits without successful payment.
- Production has no successful no-op fulfillment.

## 4. General code-start gate

No application code until all are true:

- [ ] An independent reviewer reads the complete binding stack in the order above, not merely the five original specs.
- [ ] The independent verdict is `PLAN SUITE READY FOR OWNER APPROVAL`, or all listed `BLOCKING`/`IMPORTANT` findings are resolved.
- [ ] The owner explicitly approves the corrected design and plan suite.
- [ ] The assistant states exactly: **“设计已经定稿，现在可以开始写代码。”**

## 5. Waffo-specific gate

Before Waffo adapter implementation, additionally require the isolated test-account contract: exact event names, signature format, environment/store identities, sanitized fixtures, amount representation and capability matrix.

This does not block Foundation, Authentication or SEO after the general gate passes.

## 6. Verification target

After implementation exists, fresh evidence must include:

```bash
bun install --frozen-lockfile
bun run format:check
bun run lint
bun run typecheck
bun run test:unit
bun run test:integration
bun run test:contract
bun run test:build-matrix
bun run build
bun run test:e2e
bun run verify:architecture
bun run verify:secrets
bun run verify:release
```

Additional required evidence:

- webhook sanitization, encrypted retention and purge concurrency tests;
- credit expiry/reservation race suite repeated against real PostgreSQL;
- staging noindex/no-canonical behavior;
- zero analytics network requests before consent;
- Waffo test-mode one-time and subscription end-to-end flows before those phases are approved.

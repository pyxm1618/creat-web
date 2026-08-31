# Commerce and Credits Architecture Refactor Implementation Plan

> For agentic workers: use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Preserve current Commerce and Credits behavior while separating orchestration from handlers, narrowing Credits application responsibilities, and making the Commerce-to-Credits integration dependency one-way.

**Architecture:** Commerce workers own queue lifecycle, batch accounting, and dispatch. Concrete event, command, webhook-inbox, and fulfillment handlers retain their existing business operations. Credits keeps credit-service.ts as a compatibility facade over focused services and shared internal mutation/invariant helpers. The Credits Commerce adapter moves under platform/credits/integration/commerce; the runtime remains the composition root.

**Tech Stack:** TypeScript, Next.js, Drizzle ORM, PostgreSQL, Bun, Vitest, ESLint, Prettier.

## Global Constraints

- No schema, migration, database meaning, HTTP contract, status semantics, provider contract, webhook verification boundary, transaction boundary, locking semantics, invariant, idempotency format, lease, retry/backoff, dead-letter, refund rule, subscription state machine, fulfillment behavior, expiry behavior, security-event meaning, or product-configuration behavior may change.
- Do not refactor processRefundEvent, processSubscriptionEvent, Waffo adapter, checkout, webhook ingestion, runtime env loading, route registry, credit finalization worker, cron/reconcile routes, AnalyticsClient, dead-letter inspection, UI, DTOs, config count, or unrelated fan-in.
- Keep processProviderEvent responsible for unsupported-event handling, applied-event idempotency insertion, transaction creation, and dispatch.
- Keep runCommerceWorker responsible for batch limit, remaining capacity, queue order, claimed-count aggregation, and its current onClaimed contract.
- Keep credit-service.ts as a thin re-export facade. Preserve all existing public function signatures and idempotency strings.
- Do not edit migrations, lockfiles, generated artifacts, or unrelated files.

## Preflight

**Files:**

- Read only: current git state, package scripts, Commerce/Credits source, tests, and verification scripts.
- Create: docs/superpowers/plans/2026-08-09-commerce-credits-architecture-refactor.md

- [ ] Confirm the worktree is clean. Record branch, HEAD, and remote before code changes.
- [ ] Run the pinned dependency and baseline checks:

~~~bash
bun install --frozen-lockfile
bun run format:check
bun run lint
bun run typecheck
bun run test:unit
~~~

- [ ] Check whether TEST_DATABASE_URL is set without printing its value. Use the existing integration database workflow when available; report database-gated commands as environment-blocked when it is absent.

## Phase 1: Separate Commerce event and worker orchestration

**Files:**

- Create: src/platform/commerce/application/process-one-time-payment-event.ts
- Modify: src/platform/commerce/application/process-provider-event.ts
- Create: src/platform/commerce/application/run-webhook-inbox-worker.ts
- Create: src/platform/commerce/application/run-fulfillment-worker.ts
- Modify: src/platform/commerce/application/run-commerce-worker.ts
- Create: src/platform/commerce/application/execute-subscription-cancel.ts
- Create: src/platform/commerce/application/execute-subscription-resume.ts
- Create: src/platform/commerce/application/execute-refund-request.ts
- Create: src/platform/commerce/application/execute-commerce-command.ts
- Modify: src/platform/commerce/application/run-commerce-command-worker.ts
- Test only when needed: existing Commerce integration tests or a focused regression test using their database fixtures.

**Interfaces:**

- processOneTimePaymentEvent(tx, event, payloadHash) accepts the existing Commerce transaction type and one-time provider event union and performs the exact current order locking, validation, payment projection, order transition, and fulfillment enqueue.
- runWebhookInboxWorker({ database, owner, now, limit }) returns { claimed, processed } and owns only webhook claim/process/complete/retry/dead-letter behavior.
- runFulfillmentWorker({ database, fulfillment, owner, now, limit }) returns { claimed, processed } and owns only fulfillment claim/fulfill/complete/retry/dead-letter behavior.
- executeSubscriptionCancel, executeSubscriptionResume, and executeRefundRequest accept the existing claimed command row plus database/provider dependencies and perform the current provider call and projection update.
- executeCommerceCommand dispatches existing command types to those concrete handlers and preserves the current unsupported-command error.
- runCommerceWorker and runCommerceCommandWorker retain their current exported signatures and return values.

- [ ] Add or adjust a focused regression import for the new event-handler boundary before implementing it. Run the focused test and confirm the expected missing-handler failure.
- [ ] Move the one-time branch and only its private parsing/locking helpers into process-one-time-payment-event.ts. Leave unsupported-event return, applied-event insertion, the transaction boundary, subscription dispatch, and refund dispatch in process-provider-event.ts.
- [ ] Run the Commerce event regression tests:

~~~bash
bunx vitest run --config vitest.integration.config.ts \
  tests/integration/commerce/event-application-idempotency.test.ts \
  tests/integration/commerce/webhook-ledger.test.ts \
  tests/integration/commerce/subscriptions-refunds.test.ts \
  tests/integration/commerce/refund-semantic-idempotency.test.ts \
  tests/integration/commerce/subscription-ordering.test.ts
~~~

- [ ] Extract webhook and fulfillment queue lifecycles into explicit workers without changing any statement, constant, update predicate, retry state, security event, or queue order. Make the top-level worker calculate capacity and aggregate helper results only.
- [ ] Extract command execution into the three named handlers plus executeCommerceCommand. Keep claim, completion, retry, dead-letter, reconciliation, and authSecurityEvents writes in run-commerce-command-worker.ts.
- [ ] Run the focused lifecycle tests and Phase 1 gates:

~~~bash
bunx vitest run --config vitest.integration.config.ts \
  tests/integration/commerce/job-leases.test.ts \
  tests/integration/commerce/subscriptions-refunds.test.ts \
  tests/integration/commerce/refund-reconciliation.test.ts \
  tests/integration/commerce/webhook-retention-workers.test.ts
bun run format:check
bun run lint
bun run typecheck
bun run test:unit
bun run test:integration
bun run test:contract
bun run verify:architecture
bun run verify:commerce
bun run verify:credits
~~~

- [ ] Inspect git diff --check, git status --short, git diff --name-only, and the full diff for unchanged constants, idempotency strings, query predicates, and schema/migration/lockfile/generated-artifact changes.
- [ ] Commit only Phase 1:

~~~bash
git add src/platform/commerce/application tests/integration/commerce
git diff --cached --check
git commit -m "refactor(commerce): separate event and worker orchestration"
~~~

## Phase 2: Split Credits application lifecycle services

**Files:**

- Create: src/platform/credits/application/grant-service.ts
- Create: src/platform/credits/application/balance-query.ts
- Create: src/platform/credits/application/reservation-service.ts
- Create: src/platform/credits/application/grant-lifecycle.ts
- Create: src/platform/credits/application/finalization-service.ts
- Create: src/platform/credits/application/internal/credit-support.ts
- Modify: src/platform/credits/application/credit-service.ts into a re-export facade only.
- Do not modify: database schema/migrations, domain allocation/invariants/types, mutation-lock implementation, finalization worker, reconciliation worker, or expiry routes except for necessary import-path-only changes.

**Interfaces:**

- grant-service.ts exports grantCredits unchanged.
- balance-query.ts exports getCreditBalance, getGrantQuantityProjections, and their current result types.
- reservation-service.ts exports reserveCredits, commitReservation, releaseReservation, and expireReservations unchanged.
- grant-lifecycle.ts exports expireGrants and revokeSourceCredits unchanged.
- finalization-service.ts exports enqueueCreditFinalization and withCreditReservation unchanged.
- application/internal/credit-support.ts owns only shared query/projection/record/invariant helpers and types; it does not create a repository, queue framework, or locking abstraction.
- credit-service.ts re-exports every existing function and public type so current imports continue to compile.

- [ ] Add representative direct-service imports to a Credits regression test before creating the modules. Run the focused test and confirm the expected missing-module failure.
- [ ] Move grant and balance/query code verbatim into focused modules; move only shared private helpers into application/internal/credit-support.ts. Preserve validation, query ordering, lock, transaction, ledger entry, idempotency, and invariant behavior.
- [ ] Move reservation allocation and terminal transition code into reservation-service.ts, including expired-source release handling and terminal-correlation checks. Move expiry/revoke code into grant-lifecycle.ts. Move finalization queue/orchestration code into finalization-service.ts.
- [ ] Replace credit-service.ts with explicit re-exports and run the full Credits regression suite:

~~~bash
bunx vitest run --config vitest.integration.config.ts \
  tests/integration/credits/ledger.test.ts \
  tests/integration/credits/credit-invariant.test.ts \
  tests/integration/credits/expiry-boundary.test.ts \
  tests/integration/credits/expiry-reservation-race.test.ts \
  tests/integration/credits/reconciliation.test.ts \
  tests/integration/credits/reconciliation-batch.test.ts \
  tests/integration/credits/finalization.test.ts
bun run format:check
bun run lint
bun run typecheck
bun run test:unit
bun run test:integration
bun run test:contract
bun run verify:architecture
bun run verify:commerce
bun run verify:credits
bun run verify:credit-races
~~~

- [ ] Inspect the complete diff for schema/migration/lockfile changes and exact preservation of credit idempotency strings, allocation ordering, locking, terminal transitions, expiry/revoke policy.
- [ ] Commit only Phase 2:

~~~bash
git add src/platform/credits/application tests/integration/credits
git diff --cached --check
git commit -m "refactor(credits): split application lifecycle services"
~~~

## Phase 3: Isolate the Commerce-Credits integration boundary

**Files:**

- Create: src/platform/credits/integration/commerce/credit-fulfillment.ts
- Modify: src/platform/commerce/commerce-runtime.ts to load the adapter from the Credits integration boundary while remaining the composition root.
- Modify: src/config/credits.config.ts to import only the adapter definition type from the Credits integration boundary.
- Modify: src/config/fulfillment.config.ts only if a type-only Commerce port import is needed; preserve the registry behavior.
- Modify: scripts/verify-credits.ts and tests/integration/credits/order-fulfillment.test.ts for the moved internal adapter path.
- Delete after all imports are updated: src/platform/commerce/fulfillment/credit-order-fulfillment.ts and src/platform/credits/application/commerce-handlers.ts.

**Interfaces:**

- src/platform/commerce/application/order-fulfillment.ts remains the Commerce fulfillment port/registry contract.
- credit-fulfillment.ts exports the existing CreditOrderFulfillmentDefinition, createCreditOrderFulfillment, createCreditRefundReversal, and createCreditFulfillmentHandlers behavior from the Credits integration boundary.
- The adapter may read Commerce facts and write Commerce reconciliation/refund projection as before, but Commerce application/domain code must not import Credits application or Credits integration implementation.
- getCommerceRuntime remains the explicit composition root and returns the same runtime shape.

- [ ] Add a dependency-boundary regression assertion before moving files: the current import scan must show the known reverse imports, so the assertion fails before the adapter move.
- [ ] Move the existing credit fulfillment and refund reversal implementation, including product/payment/order/subscription-period validation and reconciliation behavior, into platform/credits/integration/commerce/credit-fulfillment.ts without changing SQL, status values, correlation IDs, or idempotency keys.
- [ ] Update only composition/config/test verification import paths, delete the two old reverse-boundary modules, and verify direction:

~~~bash
rg -n "platform/credits/(application|integration)|platform/credits/application/commerce-handlers|platform/commerce/fulfillment/credit-order-fulfillment" src/platform/commerce src/config scripts tests/integration/credits
~~~

- [ ] Run the Phase 3 integration and boundary gates:

~~~bash
bunx vitest run --config vitest.integration.config.ts \
  tests/integration/credits/order-fulfillment.test.ts \
  tests/integration/commerce/subscriptions-refunds.test.ts \
  tests/integration/commerce/refund-reconciliation.test.ts
bun run format:check
bun run lint
bun run typecheck
bun run test:unit
bun run test:integration
bun run test:contract
bun run verify:architecture
bun run verify:commerce
bun run verify:credits
~~~

- [ ] Inspect git diff --check, git status --short, and the complete diff for only the three requested concerns.
- [ ] Commit only Phase 3:

~~~bash
git add src/platform/commerce src/platform/credits/integration src/config scripts/verify-credits.ts tests/integration/credits/order-fulfillment.test.ts
git diff --cached --check
git commit -m "refactor(platform): isolate commerce-credit integration"
~~~

## Final verification and handoff

- [ ] Run all requested gates and the full verification command when the environment permits:

~~~bash
bun run format:check
bun run lint
bun run typecheck
bun run test:unit
bun run test:integration
bun run test:contract
bun run verify:architecture
bun run verify:commerce
bun run verify:credits
bun run verify
~~~

- [ ] Run git diff HEAD~3..HEAD --check, git status --short --branch, and a tracked-file diff audit. Confirm no migrations, lockfile changes, generated artifacts, unrelated formatting, business constant edits, or idempotency-string edits.
- [ ] Push the three verified commits to the current tracked branch only if all required gates are green:

~~~bash
git push origin HEAD
~~~

- [ ] Report each Phase, compatibility answers, files added/deleted, before/after dependency direction, every executed command with PASS/FAIL or environment-blocked reason, and unrelated smells left out of scope.

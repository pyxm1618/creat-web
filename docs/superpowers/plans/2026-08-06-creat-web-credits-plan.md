# creat-web Credit Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a provider-independent, immutable, concurrency-safe credit ledger with grants, deterministic allocation, reservations, commit/release, expiry, revocation, reconciliation, and one-time-purchase fulfillment.

**Architecture:** Credits are stored as source-linked grants/lots plus immutable ledger entries. Long-running product work reserves specific grant allocations transactionally, then commits or releases in a later transaction. User-visible balance is derived/reconciled from ledger/grant state; no direct balance update API exists.

**Tech Stack:** PostgreSQL/Drizzle, TypeScript domain services, durable jobs, Vitest, Playwright.

## Global Constraints

- Execute only after the commerce/one-time plan exit gate passes.
- Credit code may depend on normalized commerce source facts but may not import Waffo SDK/provider code.
- Every mutation is source/correlation/idempotency keyed and writes immutable ledger history.
- Direct `UPDATE user SET credits = ...` or equivalent mutable balance field is forbidden.
- Reserve/commit/release operations are transactional and concurrency tested against real PostgreSQL.
- Long-running product work never holds a database transaction open.
- Allocation is deterministic: earliest expiry first, then oldest grant, then stable grant ID.
- Expiry/revocation never deletes historical consumption.
- Refund reversal touches only unused units from the originating grant(s); it never silently steals unrelated credits.
- Partial-refund reversal requires an explicit reviewed conversion policy; otherwise it blocks for operator decision.

---

## File Map

- `src/platform/credits/domain/types.ts` — credit type, source, entry and reservation types.
- `src/platform/credits/domain/allocation.ts` — deterministic pure allocation.
- `src/platform/credits/domain/invariants.ts` — transition/invariant checks.
- `src/platform/credits/application/grant-credits.ts` — idempotent grants.
- `src/platform/credits/application/reserve-credits.ts` — transactional reservation.
- `src/platform/credits/application/commit-reservation.ts` — consume reserved units.
- `src/platform/credits/application/release-reservation.ts` — release reserved units.
- `src/platform/credits/application/expire-credits.ts` — durable expiry.
- `src/platform/credits/application/revoke-source-credits.ts` — refund/adjustment reversal.
- `src/platform/credits/application/get-credit-balance.ts` — owner-scoped projection.
- `src/platform/credits/application/reconcile-credit-ledger.ts` — audit verification.
- `src/platform/credits/infrastructure/credit-repository.ts` — PostgreSQL transactions/locks.
- `src/platform/database/credit-schema.ts` — grants, entries, reservations, allocations.
- `src/platform/commerce/fulfillment/credit-order-fulfillment.ts` — one-time order to grant mapping.
- `src/app/(account)/account/credits/page.tsx` — owner-visible balance/history.
- `scripts/credit-expiry-worker.ts`, `scripts/reconcile-credits.ts` — operations.
- `tests/unit/credits/*`, `tests/integration/credits/*`, `tests/e2e/credits.spec.ts`.

### Task 1: Define credit domain types and deterministic allocation

**Files:**
- Create: `src/platform/credits/domain/types.ts`
- Create: `src/platform/credits/domain/allocation.ts`
- Create: `src/platform/credits/domain/invariants.ts`
- Create: `tests/unit/credits/allocation.test.ts`
- Create: `tests/unit/credits/invariants.test.ts`

**Interfaces:**
- Produces: `CreditType`, `CreditSource`, `CreditGrant`, `CreditReservation`, `CreditLedgerEntry`.
- Produces: `allocateCredits(grants, amount, now): CreditAllocation[]`.

- [ ] **Step 1: Write failing deterministic allocation tests**

```ts
import { expect, it } from "vitest";
import { allocateCredits } from "@/platform/credits/domain/allocation";

it("allocates earliest-expiring then oldest grants", () => {
  const grants = [
    { id: "old-no-expiry", available: 5, grantedAt: new Date("2026-01-01"), expiresAt: null },
    { id: "later-expiry", available: 5, grantedAt: new Date("2026-02-01"), expiresAt: new Date("2026-10-01") },
    { id: "earlier-expiry", available: 3, grantedAt: new Date("2026-03-01"), expiresAt: new Date("2026-09-01") },
  ];
  expect(allocateCredits(grants, 6, new Date("2026-08-01"))).toEqual([
    { grantId: "earlier-expiry", quantity: 3 },
    { grantId: "later-expiry", quantity: 3 },
  ]);
});

it("rejects insufficient eligible balance", () => {
  expect(() => allocateCredits([{ id: "g", available: 1, grantedAt: new Date(), expiresAt: null }], 2, new Date())).toThrow("insufficient credits");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun run test:unit -- tests/unit/credits`

Expected: FAIL.

- [ ] **Step 3: Implement types and pure allocator**

```ts
export type CreditSource =
  | { type: "order"; id: string }
  | { type: "subscription_period"; id: string }
  | { type: "compensation"; id: string }
  | { type: "promotion"; id: string }
  | { type: "admin_adjustment"; id: string };

export type CreditEntryType =
  | "grant"
  | "reserve"
  | "release"
  | "consume"
  | "expire"
  | "revoke"
  | "adjust_positive"
  | "adjust_negative";

export type CreditAllocation = { grantId: string; quantity: number };
```

`allocateCredits` filters expired/inactive/zero grants, sorts by non-null earliest expiry, then grant time, then ID, and returns integer positive allocations exactly summing to requested amount.

- [ ] **Step 4: Run tests and commit**

Run: `bun run test:unit -- tests/unit/credits`

Expected: PASS.

```bash
git add src/platform/credits/domain tests/unit/credits
git commit -m "feat: define deterministic credit allocation domain"
```

### Task 2: Create credit persistence schema and hard constraints

**Files:**
- Create: `src/platform/database/credit-schema.ts`
- Modify: `src/platform/database/schema.ts`
- Create: migration under `drizzle/`
- Create: `tests/integration/credits/schema.test.ts`
- Create: `tests/integration/credits/constraints.test.ts`

**Interfaces:**
- Produces tables: `credit_grants`, `credit_ledger_entries`, `credit_reservations`, `credit_reservation_allocations`.

- [ ] **Step 1: Write failing database-constraint tests**

Tests assert:

- duplicate `(credit_type, source_type, source_id)` grant fails;
- duplicate reservation purpose key for same user/credit type fails;
- negative/zero grant and entry quantities fail;
- allocation quantity cannot exceed reserved quantity in application transaction;
- reservation status is restricted to `active | committed | released | expired`;
- ledger entry rows cannot be updated/deleted through repository APIs.

- [ ] **Step 2: Run to verify failure**

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" bun run test:integration -- tests/integration/credits/schema.test.ts tests/integration/credits/constraints.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement schema**

Required records:

```text
credit_grants:
  id, user_id, credit_type, source_type, source_id, quantity,
  granted_at, expires_at, state(active|exhausted|expired|revoked),
  idempotency_key, metadata_json
  UNIQUE(credit_type, source_type, source_id)
  UNIQUE(idempotency_key)
  CHECK(quantity > 0)

credit_ledger_entries:
  id, user_id, credit_type, grant_id nullable, reservation_id nullable,
  entry_type, quantity, source_type, source_id, correlation_id,
  actor_type, created_at, metadata_json
  UNIQUE(entry_type, correlation_id, grant_id)
  CHECK(quantity > 0)

credit_reservations:
  id, user_id, credit_type, purpose_type, purpose_id,
  quantity, status, created_at, expires_at, committed_at, released_at,
  idempotency_key
  UNIQUE(user_id, credit_type, purpose_type, purpose_id)
  UNIQUE(idempotency_key)
  CHECK(quantity > 0)

credit_reservation_allocations:
  reservation_id, grant_id, quantity
  PRIMARY KEY(reservation_id, grant_id)
  CHECK(quantity > 0)
```

Do not store a mutable account balance column.

- [ ] **Step 4: Generate/apply migration and run tests**

Run:

```bash
bun run db:generate
DATABASE_URL="$TEST_DATABASE_URL" bun run db:migrate
TEST_DATABASE_URL="$TEST_DATABASE_URL" bun run test:integration -- tests/integration/credits
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/platform/database/credit-schema.ts src/platform/database/schema.ts drizzle tests/integration/credits
git commit -m "feat: add immutable credit ledger persistence"
```

### Task 3: Implement idempotent credit grants and balance projection

**Files:**
- Create: `src/platform/credits/infrastructure/credit-repository.ts`
- Create: `src/platform/credits/application/grant-credits.ts`
- Create: `src/platform/credits/application/get-credit-balance.ts`
- Create: `tests/integration/credits/grant-balance.test.ts`

**Interfaces:**
- Produces: `grantCredits(input): Promise<CreditGrant>`.
- Produces: `getCreditBalance({ userId, creditType, now }): Promise<{ available; reserved; consumed; expired; revoked }>`.

- [ ] **Step 1: Write failing grant/balance tests**

Tests assert same source/idempotency key returns the existing grant, conflicting quantity for same source is rejected, grant plus ledger entry commit atomically, expired grants are excluded from available balance, and cross-user reads are impossible through owner-scoped API.

- [ ] **Step 2: Run to verify failure**

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" bun run test:integration -- tests/integration/credits/grant-balance.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement grant transaction**

```ts
export type GrantCreditsInput = {
  userId: string;
  creditType: string;
  quantity: number;
  source: CreditSource;
  idempotencyKey: string;
  expiresAt: Date | null;
  actor: "system" | "operator";
};
```

Within one transaction:

1. validate positive integer quantity;
2. insert or load grant by unique source/idempotency key;
3. if existing details conflict, throw `credit grant conflict`;
4. insert one `grant` ledger entry keyed to grant ID;
5. return the persisted grant.

Balance query sums ledger semantics and active reservations by credit type; it never trusts a cached balance without reconciliation.

- [ ] **Step 4: Run tests repeatedly and commit**

Run:

```bash
for i in 1 2 3; do TEST_DATABASE_URL="$TEST_DATABASE_URL" bun run test:integration -- tests/integration/credits/grant-balance.test.ts || exit 1; done
```

Expected: PASS.

```bash
git add src/platform/credits/infrastructure src/platform/credits/application/grant-credits.ts src/platform/credits/application/get-credit-balance.ts tests/integration/credits/grant-balance.test.ts
git commit -m "feat: grant and project credits idempotently"
```

### Task 4: Implement concurrency-safe reservation and exact allocations

**Files:**
- Create: `src/platform/credits/application/reserve-credits.ts`
- Create: `tests/integration/credits/reservation-concurrency.test.ts`
- Create: `tests/integration/credits/reservation-idempotency.test.ts`

**Interfaces:**
- Produces: `reserveCredits(input): Promise<CreditReservationWithAllocations>`.

- [ ] **Step 1: Write failing concurrent reservation tests**

Seed one user with 5 credits. Launch two concurrent reservations of 4 credits using different purpose IDs. Assert exactly one succeeds, one receives `insufficient credits`, total active allocation is 4, and available balance is 1. Also assert repeating the successful purpose returns the same reservation without new ledger entries.

- [ ] **Step 2: Run to verify failure**

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" bun run test:integration -- tests/integration/credits/reservation-concurrency.test.ts tests/integration/credits/reservation-idempotency.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement transactional reservation**

```ts
export type ReserveCreditsInput = {
  userId: string;
  creditType: string;
  quantity: number;
  purpose: { type: string; id: string };
  idempotencyKey: string;
  expiresAt: Date;
};
```

Transaction algorithm:

1. return existing reservation by unique purpose/idempotency key after conflict comparison;
2. acquire a per-user/per-credit-type PostgreSQL advisory transaction lock or lock all eligible grants in deterministic order;
3. compute available units subtracting active allocations;
4. allocate earliest-expiring first;
5. insert reservation and allocation rows;
6. insert one `reserve` ledger entry per allocated grant;
7. commit before product work begins.

Document and test the selected lock key derivation; hash collisions must not mix users/credit types.

- [ ] **Step 4: Run high-contention test**

Run:

```bash
for i in $(seq 1 20); do TEST_DATABASE_URL="$TEST_DATABASE_URL" bun run test:integration -- tests/integration/credits/reservation-concurrency.test.ts || exit 1; done
```

Expected: all iterations PASS.

- [ ] **Step 5: Commit**

```bash
git add src/platform/credits/application/reserve-credits.ts tests/integration/credits/reservation-concurrency.test.ts tests/integration/credits/reservation-idempotency.test.ts
git commit -m "feat: reserve credits safely under concurrency"
```

### Task 5: Implement commit and release as idempotent terminal operations

**Files:**
- Create: `src/platform/credits/application/commit-reservation.ts`
- Create: `src/platform/credits/application/release-reservation.ts`
- Create: `tests/integration/credits/reservation-terminal.test.ts`

**Interfaces:**
- Produces: `commitReservation({ reservationId, correlationId }): Promise<void>`.
- Produces: `releaseReservation({ reservationId, correlationId, reason }): Promise<void>`.

- [ ] **Step 1: Write failing terminal-state tests**

Tests assert:

- commit writes `consume` entries matching preserved grant allocations;
- release writes `release` entries matching allocations;
- duplicate commit/release is idempotent;
- commit after release and release after commit fail closed;
- partial terminal operation is not allowed;
- transaction rollback leaves reservation active and no partial entries.

- [ ] **Step 2: Run to verify failure**

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" bun run test:integration -- tests/integration/credits/reservation-terminal.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement locked terminal transitions**

Both operations lock the reservation and allocations, verify status, insert exact per-grant ledger entries, update terminal timestamps/status, and return success on an exact duplicate correlation. They never recalculate allocation at terminal time.

- [ ] **Step 4: Run tests and commit**

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" bun run test:integration -- tests/integration/credits/reservation-terminal.test.ts`

Expected: PASS.

```bash
git add src/platform/credits/application/commit-reservation.ts src/platform/credits/application/release-reservation.ts tests/integration/credits/reservation-terminal.test.ts
git commit -m "feat: commit and release credit reservations exactly"
```

### Task 6: Add generic product-work consumption helper

**Files:**
- Create: `src/platform/credits/application/with-credit-reservation.ts`
- Create: `tests/unit/credits/with-credit-reservation.test.ts`
- Create: `tests/integration/credits/product-work-flow.test.ts`

**Interfaces:**
- Produces: `withCreditReservation(input, work): Promise<TResult>`.

- [ ] **Step 1: Write failing success/failure/timeout tests**

Tests assert:

- successful work commits after result persistence callback succeeds;
- thrown work releases reservation;
- timeout releases reservation;
- result persistence failure releases rather than consumes;
- retry with same purpose reuses reservation semantics without double consume.

- [ ] **Step 2: Run to verify failure**

Run:

```bash
bun run test:unit -- tests/unit/credits/with-credit-reservation.test.ts
TEST_DATABASE_URL="$TEST_DATABASE_URL" bun run test:integration -- tests/integration/credits/product-work-flow.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement helper without open transaction around work**

```ts
export async function withCreditReservation<TResult>(
  input: ReserveCreditsInput & { timeoutMs: number },
  work: (reservationId: string, signal: AbortSignal) => Promise<TResult>,
  deps: CreditWorkDependencies,
): Promise<TResult> {
  const reservation = await deps.reserve(input);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const result = await work(reservation.id, controller.signal);
    await deps.commit({ reservationId: reservation.id, correlationId: `commit:${input.purpose.type}:${input.purpose.id}` });
    return result;
  } catch (error) {
    await deps.release({ reservationId: reservation.id, correlationId: `release:${input.purpose.type}:${input.purpose.id}`, reason: "work_failed" });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
```

The product-specific work must persist its successful result before returning; document this contract in the interface.

- [ ] **Step 4: Run tests and commit**

Run:

```bash
bun run test:unit -- tests/unit/credits/with-credit-reservation.test.ts
TEST_DATABASE_URL="$TEST_DATABASE_URL" bun run test:integration -- tests/integration/credits/product-work-flow.test.ts
```

Expected: PASS.

```bash
git add src/platform/credits/application/with-credit-reservation.ts tests/unit/credits/with-credit-reservation.test.ts tests/integration/credits/product-work-flow.test.ts
git commit -m "feat: add reliable credit-backed work helper"
```

### Task 7: Implement expiry jobs and stale-reservation recovery

**Files:**
- Create: `src/platform/credits/application/expire-credits.ts`
- Create: `src/platform/credits/application/expire-reservations.ts`
- Create: `scripts/credit-expiry-worker.ts`
- Create: `tests/integration/credits/expiry.test.ts`

**Interfaces:**
- Produces: `expireDueCredits(now, batchSize): Promise<ExpiryReport>`.
- Produces: `expireStaleReservations(now, batchSize): Promise<ExpiryReport>`.

- [ ] **Step 1: Write failing expiry tests**

Tests assert unreserved expired units create one expiry entry, consumed units remain historical, active reservation units are not double-expired, stale reservations release first according to policy, and repeated job runs create no additional entries.

- [ ] **Step 2: Run to verify failure**

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" bun run test:integration -- tests/integration/credits/expiry.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement leased, idempotent expiry**

Use bounded batches and row locks. Expiry correlation key is `expire:<grantId>:<expiresAtISO>`. Stale reservation expiration uses the existing release path with correlation `reservation-expire:<reservationId>`.

- [ ] **Step 4: Run tests twice and commit**

Run:

```bash
TEST_DATABASE_URL="$TEST_DATABASE_URL" bun run test:integration -- tests/integration/credits/expiry.test.ts
TEST_DATABASE_URL="$TEST_DATABASE_URL" bun run test:integration -- tests/integration/credits/expiry.test.ts
```

Expected: PASS both times.

```bash
git add src/platform/credits/application/expire-credits.ts src/platform/credits/application/expire-reservations.ts scripts/credit-expiry-worker.ts tests/integration/credits/expiry.test.ts
git commit -m "feat: expire credits and stale reservations safely"
```

### Task 8: Implement source-linked revocation and refund policy outcomes

**Files:**
- Create: `src/platform/credits/application/revoke-source-credits.ts`
- Create: `src/platform/credits/domain/refund-reversal-policy.ts`
- Create: `tests/unit/credits/refund-reversal-policy.test.ts`
- Create: `tests/integration/credits/revocation.test.ts`

**Interfaces:**
- Produces: `revokeSourceCredits({ source, quantity?, correlationId }): Promise<RevocationResult>`.
- Produces: `RevocationResult = { revokedUnused; unrecoveredConsumed; operatorReviewRequired }`.

- [ ] **Step 1: Write failing reversal tests**

Tests assert:

- full refund revokes only unused units from originating order grant;
- consumed history is preserved and reported as unrecovered;
- unrelated grants remain untouched;
- partial refund with exact configured conversion revokes the exact units;
- partial refund without conversion returns `operatorReviewRequired=true` and changes no credits;
- repeated refund event is idempotent.

- [ ] **Step 2: Run to verify failure**

Run:

```bash
bun run test:unit -- tests/unit/credits/refund-reversal-policy.test.ts
TEST_DATABASE_URL="$TEST_DATABASE_URL" bun run test:integration -- tests/integration/credits/revocation.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement source-bounded revocation**

Lock originating grants, calculate unused/unreserved revocable units, create `revoke` entries, update grant state if exhausted/revoked, and return consumed shortfall. Never select grants outside the supplied source.

- [ ] **Step 4: Run tests and commit**

Run:

```bash
bun run test:unit -- tests/unit/credits/refund-reversal-policy.test.ts
TEST_DATABASE_URL="$TEST_DATABASE_URL" bun run test:integration -- tests/integration/credits/revocation.test.ts
```

Expected: PASS.

```bash
git add src/platform/credits/application/revoke-source-credits.ts src/platform/credits/domain/refund-reversal-policy.ts tests/unit/credits/refund-reversal-policy.test.ts tests/integration/credits/revocation.test.ts
git commit -m "feat: reverse source credits without stealing unrelated balance"
```

### Task 9: Connect one-time paid-order fulfillment to credit grants

**Files:**
- Create: `src/platform/commerce/fulfillment/credit-order-fulfillment.ts`
- Modify: `src/config/products.config.ts`
- Modify: `scripts/commerce-worker.ts`
- Create: `tests/integration/credits/order-fulfillment.test.ts`
- Modify: `tests/e2e/credits.spec.ts`

**Interfaces:**
- Implements: `OrderFulfillment.fulfill(command)` for products with fulfillment `{ type: "credits", creditType, quantity, expiresInDays? }`.

- [ ] **Step 1: Write failing fulfillment tests**

Tests create a paid-order fulfillment job and assert exactly one grant/source ledger entry, duplicate job/retry no duplicate grant, wrong product/version/amount blocks fulfillment, expiration policy uses the product snapshot, and failed grant transaction leaves job retryable.

- [ ] **Step 2: Run to verify failure**

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" bun run test:integration -- tests/integration/credits/order-fulfillment.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement credit fulfillment**

```ts
export class CreditOrderFulfillment implements OrderFulfillment {
  async fulfill(command: PaidOrderFulfillmentCommand): Promise<void> {
    if (command.fulfillment.type !== "credits") throw new Error("unsupported fulfillment");
    await grantCredits({
      userId: command.userId,
      creditType: command.fulfillment.creditType,
      quantity: command.fulfillment.quantity,
      source: { type: "order", id: command.orderId },
      idempotencyKey: `order-credit:${command.orderId}:${command.productVersion}`,
      expiresAt: command.fulfillment.expiresAt,
      actor: "system",
    });
  }
}
```

Product snapshot—not current mutable config—supplies quantity/type/expiry meaning.

- [ ] **Step 4: Run integration/E2E and commit**

Run:

```bash
TEST_DATABASE_URL="$TEST_DATABASE_URL" bun run test:integration -- tests/integration/credits/order-fulfillment.test.ts
bun run test:e2e -- tests/e2e/commerce.spec.ts tests/e2e/credits.spec.ts
```

Expected: PASS; paid order grants once, declined/processing order grants none.

```bash
git add src/platform/commerce/fulfillment/credit-order-fulfillment.ts src/config/products.config.ts scripts/commerce-worker.ts tests/integration/credits/order-fulfillment.test.ts tests/e2e/credits.spec.ts
git commit -m "feat: fulfill paid orders with source-linked credits"
```

### Task 10: Add credit account UI, reconciliation and fault verification

**Files:**
- Create: `src/app/(account)/account/credits/page.tsx`
- Create: `src/platform/credits/application/reconcile-credit-ledger.ts`
- Create: `scripts/reconcile-credits.ts`
- Create: `tests/integration/credits/reconciliation.test.ts`
- Create: `tests/integration/credits/fault-injection.test.ts`
- Create: `docs/runbooks/credit-incidents.md`
- Modify: `scripts/verify-release.ts`

**Interfaces:**
- Produces: `reconcileCreditLedger({ userId?, creditType? }): Promise<CreditReconciliationReport>`.

- [ ] **Step 1: Write failing reconciliation/fault tests**

Tests detect orphan ledger entry, allocation/quantity mismatch, active reservation past expiry, duplicated source, and derived balance mismatch. Fault tests cover database interruption during grant/reserve/commit/revoke and worker crash during expiry.

- [ ] **Step 2: Run to verify failure**

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" bun run test:integration -- tests/integration/credits/reconciliation.test.ts tests/integration/credits/fault-injection.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement read-only reconciliation and owner UI**

Reconciliation reports discrepancies and stable IDs; it does not directly patch balance. Repairs use the same domain operations with explicit operator correlation IDs. Account page displays available/reserved, grant source label, expiry, and recent consumption without provider payloads or other users' data.

- [ ] **Step 4: Add release checks**

Release verification fails if credits are enabled without configured credit types, product fulfillment snapshots, expiry policy, refund reversal policy, reservation timeout, expiry worker schedule, reconciliation command, owner authorization tests, or legal disclosure.

- [ ] **Step 5: Run full credit gate**

```bash
bun run format:check
bun run lint
bun run typecheck
bun run test:unit
TEST_DATABASE_URL="$TEST_DATABASE_URL" bun run test:integration
bun run build
bun run test:e2e -- tests/e2e/commerce.spec.ts tests/e2e/credits.spec.ts
bun run verify:release
```

Expected: all commands exit `0`.

- [ ] **Step 6: Commit**

```bash
git add src/app/'(account)'/account/credits src/platform/credits/application/reconcile-credit-ledger.ts scripts/reconcile-credits.ts tests/integration/credits/reconciliation.test.ts tests/integration/credits/fault-injection.test.ts docs/runbooks/credit-incidents.md scripts/verify-release.ts
git commit -m "test: reconcile and operate the credit ledger"
```

## Credit Ledger Exit Gate

Before requesting review, prove:

- no mutable balance column/API exists;
- every change has a source-linked immutable ledger entry;
- grants are idempotent and conflicting duplicates fail;
- 20 repeated concurrent reservation runs never overspend;
- reservations preserve exact per-grant allocations;
- commit/release are idempotent terminal operations;
- failed/timed-out product work releases rather than consumes;
- expiry and stale-reservation jobs are repeatable and non-destructive;
- refund revocation affects only unused originating units and reports consumed shortfall;
- one-time paid orders grant credits exactly once from product snapshot;
- balance/history pages are owner-scoped;
- reconciliation detects inconsistencies without direct patches;
- full CI/integration/E2E gates pass.

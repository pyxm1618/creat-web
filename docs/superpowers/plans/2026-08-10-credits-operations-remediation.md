# Credits Integrity and Operations Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Protect credit conservation with correct renewal expiry, an append-only ledger, durable reconciliation incidents, atomic delivery obligations, and enforceable architecture/release guards.

**Architecture:** Credits remains the owner of its ledger and reservation lifecycle. PostgreSQL provides the immutable-ledger backstop, reconciliation persists bounded incident state in the same transaction as cursor advancement, and delivery persistence shares a transaction with creation of the finalization obligation.

**Tech Stack:** TypeScript 5.9, Drizzle ORM 0.45, PostgreSQL, Vitest, ESLint 9, Bun 1.3.14.

## Global Constraints

- Credits may be granted only by an idempotent source identity.
- Reservation allocation, ledger totals, and terminal status must conserve quantity under concurrency.
- Production code cannot update or delete credit ledger entries.
- Commerce application/domain/provider code cannot import Credits concrete implementations.
- Do not weaken `bun audit`, release verification, or secret verification to obtain a passing result.
- Follow red-green-refactor for every behavior change.

---

### Task 1: Subscription-period-based Credit Expiry

**Files:**
- Modify: `src/platform/credits/integration/commerce/credit-fulfillment.ts`
- Modify: `tests/integration/credits/order-fulfillment.test.ts`

**Interfaces:**
- One-time source base: `orders.paidAt`
- Subscription source base: matched `subscriptionPeriods.periodStart`
- Source identity remains `{ type: "subscription_period", id: period.id }`

- [ ] **Step 1: Add a failing renewal-expiry integration test**

```ts
const periodStart = new Date("2026-09-08T10:00:00Z");
await fulfill(subscriptionPaymentInput);
const [grant] = await database.db
  .select()
  .from(creditGrants)
  .where(eq(creditGrants.sourceId, period.id));
expect(grant?.expiresAt).toEqual(new Date("2026-10-08T10:00:00Z"));
```

Seed the subscription order with an earlier `paidAt`, a renewal period with the stated start, and a definition with `expiresAfterDays: 30`.

- [ ] **Step 2: Run the test and observe expiry based on the original order payment**

```bash
bunx vitest run --config vitest.integration.config.ts tests/integration/credits/order-fulfillment.test.ts
```

Expected: the grant expiry equals the first order payment plus 30 days instead of the renewal period plus 30 days.

- [ ] **Step 3: Return source and expiry base from payment-source resolution**

```ts
type CreditSourceFact = Readonly<{
  source: { readonly type: "order" | "subscription_period"; readonly id: string };
  grantBase: Date;
}>;
```

For a subscription payment, select exactly one period by payment id and return its id and `periodStart`; for one-time payments return the order id and non-null `paidAt`. Reject missing or ambiguous rows instead of using `new Date()`.

- [ ] **Step 4: Run Credits integration, verification, and type checks**

```bash
bunx vitest run --config vitest.integration.config.ts tests/integration/credits/order-fulfillment.test.ts
bun run verify:credits
bun run typecheck
```

Expected: all commands exit `0`.

- [ ] **Step 5: Commit renewal expiry**

```bash
git add src/platform/credits/integration/commerce/credit-fulfillment.ts tests/integration/credits/order-fulfillment.test.ts
git commit -m "fix(credits): expire renewal grants by period"
```

### Task 2: Credit Integrity Migration and Durable Reconciliation Incidents

**Files:**
- Modify: `src/platform/database/credit-schema.ts`
- Create: `drizzle/0009_production_readiness.sql`
- Create: `drizzle/meta/0009_snapshot.json`
- Modify: `drizzle/meta/_journal.json`
- Modify: `src/platform/credits/application/reconcile-credit-ledger.ts`
- Modify: `src/platform/observability/operational-snapshot.ts`
- Modify: `src/platform/observability/alerts.ts`
- Modify: `scripts/verify-migrations.ts`
- Modify: `tests/integration/credits/schema-constraints.test.ts`
- Modify: `tests/integration/credits/reconciliation-batch.test.ts`
- Modify: `tests/integration/operations/health-alerts.test.ts`
- Modify: `docs/operations/credits-runbook.md`

**Interfaces:**
- Table: `credit_reconciliation_incidents`
- Stable unique identity: `(code, entityId)`
- Fields: `detail`, `status`, `occurrences`, `firstDetectedAt`, `lastDetectedAt`, `resolvedAt`
- Status values: `open | resolved`
- Trigger function: `reject_credit_ledger_mutation()`
- Trigger: `credit_ledger_entries_append_only` before update or delete
- Trigger error text: `credit ledger entries are append only`

- [ ] **Step 1: Add failing ledger-mutation, incident-persistence, and alert tests**

```ts
await expect(
  database.db.update(creditLedgerEntries).set({ quantity: 2 }).where(eq(creditLedgerEntries.id, entry.id)),
).rejects.toThrow("credit ledger entries are append only");
await expect(
  database.db.delete(creditLedgerEntries).where(eq(creditLedgerEntries.id, entry.id)),
).rejects.toThrow("credit ledger entries are append only");

const batch = await reconcileCreditLedgerBatch(database.db, { limit: 10, now });
expect(batch.issues).toContainEqual(expect.objectContaining({ code: "GRANT_LEDGER_MISMATCH" }));
expect(await openIncidentCount()).toBe(1);
await reconcileCreditLedgerBatch(database.db, { limit: 10, now: later });
expect(await openIncidentCount()).toBe(1);
expect((await loadIncident()).occurrences).toBe(2);
```

Repair the corrupt fixture, scan the entity again, and assert status resolved. Insert an open incident in the operations test and assert the snapshot produces the existing critical `reconciliation_mismatch` alert without serializing entity ids. The corruption fixture disables only the named append-only trigger and re-enables it in `finally`.

- [ ] **Step 2: Run constraint, reconciliation, and health tests and verify all three protections are absent**

```bash
bunx vitest run --config vitest.integration.config.ts tests/integration/credits/schema-constraints.test.ts tests/integration/credits/reconciliation-batch.test.ts tests/integration/operations/health-alerts.test.ts
```

Expected: direct ledger mutations succeed and incident-table imports or persistence assertions fail.

- [ ] **Step 3: Define the incident table, persist results, and add the append-only trigger**

```ts
export const creditReconciliationIncidents = pgTable(
  "credit_reconciliation_incidents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    code: text("code").notNull(),
    entityId: text("entity_id").notNull(),
    detail: text("detail").notNull(),
    status: text("status").default("open").notNull(),
    occurrences: integer("occurrences").default(1).notNull(),
    firstDetectedAt: timestamp("first_detected_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
    lastDetectedAt: timestamp("last_detected_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [uniqueIndex("credit_reconciliation_incident_uq").on(table.code, table.entityId)],
);
```

Within the reconciliation transaction, mark incidents for processed entity ids resolved, then upsert current issues as open with updated detail/time and `occurrences + 1`. Save the cursor only after those writes. Count open credit incidents in the operational snapshot and add them to reconciliation mismatch evaluation without exposing code/entity/detail in alert output.

Generate the named migration with `bunx drizzle-kit generate --name production_readiness`, then append:

```sql
CREATE FUNCTION "reject_credit_ledger_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'credit ledger entries are append only';
END;
$$;

CREATE TRIGGER "credit_ledger_entries_append_only"
BEFORE UPDATE OR DELETE ON "credit_ledger_entries"
FOR EACH ROW EXECUTE FUNCTION "reject_credit_ledger_mutation"();
```

Extend migration verification to require both objects.

- [ ] **Step 4: Run constraint, reconciliation, operations, migration, Credits, and type checks**

```bash
bunx vitest run --config vitest.integration.config.ts tests/integration/credits/schema-constraints.test.ts tests/integration/credits/reconciliation-batch.test.ts tests/integration/operations/health-alerts.test.ts
bun run db:verify
bun run verify:credits
bun run typecheck
```

Expected: all commands exit `0`, direct application update/delete fails, and open incidents survive process boundaries.

- [ ] **Step 5: Commit the integrity migration and incident pipeline**

```bash
git add src/platform/database/credit-schema.ts src/platform/credits/application/reconcile-credit-ledger.ts src/platform/observability/operational-snapshot.ts src/platform/observability/alerts.ts scripts/verify-migrations.ts tests/integration/credits/schema-constraints.test.ts tests/integration/credits/reconciliation-batch.test.ts tests/integration/operations/health-alerts.test.ts docs/operations/credits-runbook.md drizzle
git commit -m "fix(credits): persist integrity incidents"
```

### Task 3: Atomic Delivery and Finalization Obligation

**Files:**
- Modify: `src/platform/database/client.ts`
- Modify: `src/platform/credits/application/finalization-service.ts`
- Modify: `src/platform/credits/application/execute-credit-backed-work.ts`
- Modify: `tests/integration/credits/finalization.test.ts`

**Interfaces:**
- Produces: `DatabaseTransaction`
- `persistDelivery(result, reservation, tx)` must persist a database-backed delivery using the supplied transaction.
- The finalization job is inserted in the same transaction as delivery persistence and exists before direct commit is attempted.

- [ ] **Step 1: Add a failing rollback and crash-window test**

```ts
await expect(
  executeCreditBackedWork(database.db, reserveInput, {
    work: async () => result,
    persistDelivery: async (_result, reservation, tx) => {
      await tx.insert(platformMeta).values({ key: `delivery:${reservation.id}`, value: "stored" });
      throw new Error("delivery transaction failed");
    },
  }),
).rejects.toThrow("delivery transaction failed");
expect(await deliveryRows()).toHaveLength(0);
expect(await finalizationRows()).toHaveLength(0);
```

Add a successful delivery plus injected commit failure and assert both delivery and pending finalization rows exist exactly once; the recovery worker commits without repeating work or delivery.

- [ ] **Step 2: Run finalization tests and verify callback lacks a transaction and job is inserted too late**

```bash
bunx vitest run --config vitest.integration.config.ts tests/integration/credits/finalization.test.ts
```

Expected: the callback signature or atomic row assertions fail.

- [ ] **Step 3: Export the transaction type and insert the obligation with delivery**

```ts
export type DatabaseTransaction = Parameters<Parameters<DatabaseClient["transaction"]>[0]>[0];

const delivery = await database.transaction(async (tx) => {
  const stored = await callbacks.persistDelivery(result, reservation, tx);
  await enqueueCreditFinalization(tx, {
    reservationId: reservation.id,
    deliveryReference: stored.deliveryReference,
  });
  return stored;
});
```

After this transaction commits, try the existing idempotent reservation commit. On success mark the queued job completed; on failure return `finalizationPending: true` because the recovery obligation already exists. Apply the same transaction contract to `withCreditReservation` so the alternate exported helper cannot reopen the crash window.

- [ ] **Step 4: Run finalization, Credits, race, and type checks**

```bash
bunx vitest run --config vitest.integration.config.ts tests/integration/credits/finalization.test.ts
bun run verify:credits
bun run verify:credit-races
bun run typecheck
```

Expected: all commands exit `0`.

- [ ] **Step 5: Commit atomic finalization**

```bash
git add src/platform/database/client.ts src/platform/credits/application/finalization-service.ts src/platform/credits/application/execute-credit-backed-work.ts tests/integration/credits/finalization.test.ts
git commit -m "fix(credits): persist finalization obligations"
```

### Task 4: Credit Finalization Lease Fencing

**Files:**
- Modify: `src/platform/credits/application/finalization-worker.ts`
- Modify: `tests/integration/credits/finalization.test.ts`

**Interfaces:**
- Completion/failure predicate: id, `processing` state, and current lease owner.
- Dead-letter security event is inserted only after the fenced failure update succeeds.

- [ ] **Step 1: Add a failing reclaimed-job test**

```ts
await reclaimFinalizationJob(job.id, "new-owner");
releaseOldFinalizer();
expect(await loadFinalizationJob(job.id)).toMatchObject({
  state: "processing",
  leaseOwner: "new-owner",
});
expect(await finalizationDeadLetterEvents()).toHaveLength(0);
```

- [ ] **Step 2: Run the test and observe stale counters or side effects**

```bash
bunx vitest run --config vitest.integration.config.ts tests/integration/credits/finalization.test.ts
```

Expected: the stale worker increments completion/deferred or inserts a dead-letter event despite losing ownership.

- [ ] **Step 3: Require fenced updates to return a row before counting or emitting side effects**

```ts
const [owned] = await tx
  .update(creditFinalizationJobs)
  .set(nextState)
  .where(and(
    eq(creditFinalizationJobs.id, job.id),
    eq(creditFinalizationJobs.state, "processing"),
    eq(creditFinalizationJobs.leaseOwner, input.owner),
  ))
  .returning({ id: creditFinalizationJobs.id });
if (!owned) return;
```

- [ ] **Step 4: Run finalization and race verification**

```bash
bunx vitest run --config vitest.integration.config.ts tests/integration/credits/finalization.test.ts
bun run verify:credit-races
bun run typecheck
```

Expected: all commands exit `0`.

- [ ] **Step 5: Commit finalization fencing**

```bash
git add src/platform/credits/application/finalization-worker.ts tests/integration/credits/finalization.test.ts
git commit -m "fix(credits): fence finalization leases"
```

### Task 5: Enforce Architecture, Secret, and Release Guards

**Files:**
- Modify: `eslint.config.mjs`
- Replace: `tests/unit/commerce/credits-boundary.test.ts`
- Modify: `scripts/verify-secrets.ts`
- Modify: `tests/unit/security/secret-scan.test.ts`
- Modify: `scripts/verify-release.ts`
- Modify: `docs/providers/waffo-contract-2026-08-08.md`

**Interfaces:**
- ESLint-protected paths: `src/platform/commerce/application/**`, `domain/**`, and `providers/**`
- Forbidden group: `@/platform/credits/*` and `@/platform/credits/**`
- Secret scan roots: `src`, `scripts`, `.github`, `tests`, `docs`, and `drizzle`

- [ ] **Step 1: Add failing behavior tests for future illegal imports and expanded scan roots**

```ts
const [result] = await eslint.lintText(
  'import { grantCredits } from "@/platform/credits/application/credit-service";',
  { filePath: "src/platform/commerce/application/future-handler.ts" },
);
expect(result?.messages.some((message) => message.ruleId === "no-restricted-imports")).toBe(true);
```

Run the secret verifier against a temporary fixture under each newly scanned root and assert a non-empty secret assignment exits non-zero. Add a release-verifier fixture showing commerce-enabled account deletion coordination must be present.

- [ ] **Step 2: Run architecture, secret, and release tests and observe missing coverage**

```bash
bunx vitest run --config vitest.config.ts tests/unit/commerce/credits-boundary.test.ts tests/unit/security/secret-scan.test.ts
bun run verify:architecture
bun run verify:release
```

Expected: lintText reports no restricted-import error or the verifier skips a new root.

- [ ] **Step 3: Add the narrow ESLint override and expand existing verifiers**

```js
{
  files: [
    "src/platform/commerce/application/**/*.{ts,tsx}",
    "src/platform/commerce/domain/**/*.{ts,tsx}",
    "src/platform/commerce/providers/**/*.{ts,tsx}",
  ],
  rules: {
    "no-restricted-imports": ["error", {
      patterns: [{
        group: ["@/platform/credits/*", "@/platform/credits/**"],
        message: "Commerce core must depend on its fulfillment port, not Credits implementations.",
      }],
    }],
  },
}
```

Retain the current platform-to-product restriction in the combined rule configuration. Expand scan roots without excluding the new plan or migration files; test fixtures use quoted/fake values so they do not create repository findings. Update Waffo documentation with the verified `String!` payment lookup and the repository-versus-live activation boundary.

- [ ] **Step 4: Run all guard checks**

```bash
bunx vitest run --config vitest.config.ts tests/unit/commerce/credits-boundary.test.ts tests/unit/security/secret-scan.test.ts
bun run verify:architecture
bun run verify:secrets
bun run verify:release
bun run lint
```

Expected: all commands exit `0`.

- [ ] **Step 5: Commit release guards**

```bash
git add eslint.config.mjs tests/unit/commerce/credits-boundary.test.ts scripts/verify-secrets.ts tests/unit/security/secret-scan.test.ts scripts/verify-release.ts docs/providers/waffo-contract-2026-08-08.md
git commit -m "fix(release): enforce production boundaries"
```

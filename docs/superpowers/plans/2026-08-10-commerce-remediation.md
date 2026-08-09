# Commerce Durability and Refund Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make provider events losslessly durable, bind refunds to the correct payment, preserve subscription-period behavior, fence worker leases, and reconcile missed provider state.

**Architecture:** A single exhaustive event codec owns the webhook inbox format. Financial projections continue inside the existing applied-event transaction, but signed identity mismatches and uncertain provider states become durable reconciliation records instead of mutations. Queue handlers retain at-least-once delivery with owner-fenced acknowledgements.

**Tech Stack:** Next.js 16, TypeScript 5.9, Waffo Pancake SDK 0.16.0, Drizzle ORM 0.45, PostgreSQL, Vitest, Playwright.

## Global Constraints

- Verify Waffo raw bodies before normalization and use signed `event.id` for idempotency.
- Store money as integer minor units in application/database code and display amounts only at the provider adapter.
- Never release refund capacity while provider settlement remains unresolved.
- Keep `processProviderEvent` transaction and applied-event insertion atomic.
- Keep Commerce application/domain/provider code independent of Credits concrete implementations.
- Follow red-green-refactor for every behavior change.

---

### Task 1: Exhaustive Versioned Provider-event Codec

**Files:**
- Modify: `src/platform/commerce/application/event-json.ts`
- Modify: `src/platform/commerce/application/ingest-provider-webhook.ts`
- Modify: `src/platform/commerce/application/run-webhook-inbox-worker.ts`
- Test: `tests/unit/commerce/event-json.test.ts`
- Test: `tests/integration/commerce/webhook-ledger.test.ts`

**Interfaces:**
- Produces: `serializeNormalizedProviderEvent(event: NormalizedProviderEvent): Record<string, unknown>`
- Preserves: `parseNormalizedProviderEvent(value: unknown): NormalizedProviderEvent`
- Wire version: numeric `version: 1`

- [ ] **Step 1: Add failing table-driven round-trip tests for every event type**

```ts
for (const event of fixtures) {
  const encoded = serializeNormalizedProviderEvent(event);
  expect(() => JSON.stringify(encoded)).not.toThrow();
  expect(parseNormalizedProviderEvent(JSON.parse(JSON.stringify(encoded)))).toEqual(event);
}
```

Fixtures contain all three one-time variants, seven subscription variants, both refund variants, and the unsupported signed-event variant. Subscription fixtures include amount, period dates, merchant/store ids; refund fixtures include `externalRefundReference` and `merchantOrderReference`.

- [ ] **Step 2: Run the codec and inbox tests and observe subscription serialization/parsing failure**

```bash
bunx vitest run --config vitest.config.ts tests/unit/commerce/event-json.test.ts
bunx vitest run --config vitest.integration.config.ts tests/integration/commerce/webhook-ledger.test.ts
```

Expected: `bigint` JSON serialization or missing subscription parser cases fail.

- [ ] **Step 3: Implement one explicit codec for the discriminated union**

```ts
type EventJsonV1 = {
  readonly version: 1;
  readonly type: NormalizedProviderEvent["type"];
  readonly eventId: string;
  readonly environment: CommerceEnvironment;
  readonly occurredAt: string;
  readonly amount?: { readonly currency: string; readonly minor: string };
} & Record<string, unknown>;

function assertNever(value: never): never {
  throw new Error(`unsupported normalized provider event: ${JSON.stringify(value)}`);
}
```

Each switch case copies only its declared fields, converts every date with `toISOString()`, converts every minor value with `toString()`, and preserves optional provider references. Parsing validates `version === 1`, reconstructs dates and bigint values, and rejects malformed data. Remove the private serializer from webhook ingestion and call the exported codec.

- [ ] **Step 4: Run codec, inbox, type, and Commerce verification**

```bash
bunx vitest run --config vitest.config.ts tests/unit/commerce/event-json.test.ts
bunx vitest run --config vitest.integration.config.ts tests/integration/commerce/webhook-ledger.test.ts
bun run typecheck
bun run verify:commerce
```

Expected: all commands exit `0`.

- [ ] **Step 5: Commit the codec**

```bash
git add src/platform/commerce/application/event-json.ts src/platform/commerce/application/ingest-provider-webhook.ts src/platform/commerce/application/run-webhook-inbox-worker.ts tests/unit/commerce/event-json.test.ts tests/integration/commerce/webhook-ledger.test.ts
git commit -m "fix(commerce): make webhook events lossless"
```

### Task 2: Bounded Invalid-webhook Diagnostics

**Files:**
- Modify: `src/platform/commerce/application/ingest-provider-webhook.ts`
- Modify: `src/platform/commerce/application/purge-webhook-payloads.ts`
- Modify: `src/app/api/internal/jobs/commerce/route.ts`
- Test: `tests/integration/commerce/webhook-retention-workers.test.ts`
- Test: `tests/integration/commerce/webhook-purge-concurrency.test.ts`

**Interfaces:**
- Invalid diagnostic identity: `invalid:${environment}:${UTC-minute}`
- Rejected-row retention: 24 hours
- Produces: `purgeRejectedWebhookDiagnostics(database, { now, limit }): Promise<number>`

- [ ] **Step 1: Add failing cardinality and retention tests**

```ts
await ingestInvalidPayload(bodyA, now);
await ingestInvalidPayload(bodyB, new Date(now.getTime() + 20_000));
expect(await rejectedRowCount()).toBe(1);
expect(
  await purgeRejectedWebhookDiagnostics(database.db, {
    now: new Date(now.getTime() + 24 * 60 * 60 * 1000 + 1),
  }),
).toBe(1);
expect(await rejectedRowCount()).toBe(0);
```

- [ ] **Step 2: Run retention tests and confirm two unique hashes currently create two permanent rows**

```bash
bunx vitest run --config vitest.integration.config.ts tests/integration/commerce/webhook-retention-workers.test.ts tests/integration/commerce/webhook-purge-concurrency.test.ts
```

Expected: cardinality or deletion assertions fail.

- [ ] **Step 3: Bucket invalid diagnostics and delete expired rejected rows**

```ts
function invalidDiagnosticId(environment: CommerceEnvironment, now: Date): string {
  return `invalid:${environment}:${now.toISOString().slice(0, 16)}`;
}
```

Insert invalid-signature rows with this provider event id and matching deterministic dedup hash; retain only payload hash/size and signature outcome. The purge function deletes rows where `signatureValid = false`, `state = 'rejected'`, and `receivedAt <= cutoff` under `FOR UPDATE SKIP LOCKED`. Invoke it from the existing bounded Commerce maintenance route.

- [ ] **Step 4: Run retention, security, and type checks**

```bash
bunx vitest run --config vitest.integration.config.ts tests/integration/commerce/webhook-retention-workers.test.ts tests/integration/commerce/webhook-purge-concurrency.test.ts
bun run verify:security
bun run typecheck
```

Expected: all commands exit `0` and no raw invalid body is stored.

- [ ] **Step 5: Commit invalid-webhook retention**

```bash
git add src/platform/commerce/application/ingest-provider-webhook.ts src/platform/commerce/application/purge-webhook-payloads.ts src/app/api/internal/jobs/commerce/route.ts tests/integration/commerce/webhook-retention-workers.test.ts tests/integration/commerce/webhook-purge-concurrency.test.ts
git commit -m "fix(commerce): bound invalid webhook records"
```

### Task 3: Payment-bound Refund Events and Provider-originated Refund Rows

**Files:**
- Modify: `src/platform/commerce/application/process-refund-event.ts`
- Modify: `src/platform/database/subscription-schema.ts`
- Test: `tests/integration/commerce/refund-semantic-idempotency.test.ts`
- Test: `tests/integration/commerce/subscriptions-refunds.test.ts`
- Test: `tests/integration/commerce/event-application-idempotency.test.ts`

**Interfaces:**
- A matched `externalRefundReference` is valid only when `matched.paymentId === eventPayment.id`.
- Provider-originated idempotency key: `provider-refund:${environment}:${eventId}`
- Full cumulative subscription refund updates `subscriptionPeriods.state` to `refunded` and leaves the subscription order aggregate paid.

- [ ] **Step 1: Add failing adversarial refund tests**

```ts
await processProviderEvent(database.db, {
  ...refundSucceededForPaymentB,
  externalRefundReference: refundCreatedForPaymentA.externalRefundReference,
}, payloadHash);
expect(await paymentProjection(paymentA.id)).toEqual(beforeA);
expect(await paymentProjection(paymentB.id)).toEqual(beforeB);
expect(await reconciliationCount(paymentB.id)).toBe(1);
```

Add a provider-originated full refund with no local refund row and assert one deterministic succeeded refund row, one reversal job, and replay safety. Add `period 1 refunded -> period 2 payment_succeeded` and assert the order remains usable, period 1 is refunded, and period 2 is paid.

- [ ] **Step 2: Run refund integration tests and observe cross-payment mutation, missing row, or renewal failure**

```bash
bunx vitest run --config vitest.integration.config.ts tests/integration/commerce/refund-semantic-idempotency.test.ts tests/integration/commerce/subscriptions-refunds.test.ts tests/integration/commerce/event-application-idempotency.test.ts
```

Expected: at least the payment-binding, provider-originated-row, and later-renewal assertions fail.

- [ ] **Step 3: Validate identity before mutation and materialize unknown refunds**

```ts
if (matched && matched.paymentId !== payment.id) {
  await recordRefundReconciliation(tx, {
    paymentId: payment.id,
    event,
    reason: "external_refund_reference_payment_mismatch",
  });
  return;
}
```

When no local row matches, insert a refund using the deterministic provider idempotency key, event amount, succeeded state, and event reference before updating payment totals. For subscription products, locate the unique period by payment id and set its state to `refunded` on a full payment refund; update order refund status only for one-time products. Enqueue source-bounded reversal only when cumulative refunded minor equals captured minor.

- [ ] **Step 4: Run refund, subscription, Commerce, and Credits integration checks**

```bash
bunx vitest run --config vitest.integration.config.ts tests/integration/commerce/refund-semantic-idempotency.test.ts tests/integration/commerce/subscriptions-refunds.test.ts tests/integration/commerce/event-application-idempotency.test.ts
bun run verify:commerce
bun run verify:credits
bun run typecheck
```

Expected: all commands exit `0`.

- [ ] **Step 5: Commit refund identity and period behavior**

```bash
git add src/platform/commerce/application/process-refund-event.ts src/platform/database/subscription-schema.ts tests/integration/commerce/refund-semantic-idempotency.test.ts tests/integration/commerce/subscriptions-refunds.test.ts tests/integration/commerce/event-application-idempotency.test.ts
git commit -m "fix(commerce): bind refunds to payments"
```

### Task 4: Preserve Capacity for Unresolved Refunds

**Files:**
- Modify: `src/platform/commerce/application/commerce-commands.ts`
- Modify: `src/platform/commerce/application/execute-refund-request.ts`
- Modify: `src/platform/commerce/application/reconcile-stale-refunds.ts`
- Test: `tests/integration/commerce/refund-reconciliation.test.ts`
- Test: `tests/integration/commerce/subscriptions-refunds.test.ts`

**Interfaces:**
- Capacity-reserving states: `pending | processing | reconciliation_required`
- Stale states scanned: `pending | processing`
- Provider `failed` result becomes local `failed`; provider `pending | processing | succeeded` remains unresolved until authoritative event/reconciliation.

- [ ] **Step 1: Add failing capacity and stale-pending tests**

```ts
await seedRefund({ paymentId, amountMinor: 700n, status: "reconciliation_required" });
await expect(enqueueRefundRequest(database.db, requestFor(400n))).rejects.toThrow(
  "refundable amount exceeded",
);
await seedRefund({ paymentId, amountMinor: 100n, status: "pending", updatedAt: staleAt });
expect(await reconcileStaleRefunds(database.db, { now })).toBe(1);
```

- [ ] **Step 2: Run refund reconciliation tests and verify unresolved capacity is currently released**

```bash
bunx vitest run --config vitest.integration.config.ts tests/integration/commerce/refund-reconciliation.test.ts tests/integration/commerce/subscriptions-refunds.test.ts
```

Expected: the over-refund request is accepted or stale pending remains pending.

- [ ] **Step 3: Count all unresolved rows and reconcile both stale states**

```ts
inArray(refunds.status, ["pending", "processing", "reconciliation_required"])
```

Change stale selection and conditional update predicates to accept pending or processing. Keep `reversalStatus` unchanged for a refund that never succeeded; set it to reconciliation-required only when entitlement state is genuinely uncertain. Record the former state and provider reference in the reconciliation run.

- [ ] **Step 4: Run focused and full Commerce verification**

```bash
bunx vitest run --config vitest.integration.config.ts tests/integration/commerce/refund-reconciliation.test.ts tests/integration/commerce/subscriptions-refunds.test.ts
bun run verify:commerce
bun run typecheck
```

Expected: all commands exit `0`.

- [ ] **Step 5: Commit refund-capacity handling**

```bash
git add src/platform/commerce/application/commerce-commands.ts src/platform/commerce/application/execute-refund-request.ts src/platform/commerce/application/reconcile-stale-refunds.ts tests/integration/commerce/refund-reconciliation.test.ts tests/integration/commerce/subscriptions-refunds.test.ts
git commit -m "fix(commerce): retain uncertain refund capacity"
```

### Task 5: Stable Browser Operation Keys

**Files:**
- Create: `src/components/account/operation-key.ts`
- Modify: `src/components/account/billing-actions.tsx`
- Test: `tests/unit/commerce/operation-key.test.ts`

**Interfaces:**
- Produces: `createOperationKeyState(createKey?: () => string)` with `keyFor(fingerprint: string)` and `complete(fingerprint: string)`.
- Reuses a key for the same failed/lost-response fingerprint and rotates only after terminal success or a changed fingerprint.

- [ ] **Step 1: Add a failing pure behavior test**

```ts
const state = createOperationKeyState(() => keys.shift()!);
expect(state.keyFor("refund:p1:10.00:USD:duplicate")).toBe("key-1");
expect(state.keyFor("refund:p1:10.00:USD:duplicate")).toBe("key-1");
expect(state.keyFor("refund:p1:20.00:USD:duplicate")).toBe("key-2");
state.complete("refund:p1:20.00:USD:duplicate");
expect(state.keyFor("refund:p1:20.00:USD:duplicate")).toBe("key-3");
```

- [ ] **Step 2: Run the unit test and verify the helper is absent**

```bash
bunx vitest run --config vitest.config.ts tests/unit/commerce/operation-key.test.ts
```

Expected: import or behavior failure.

- [ ] **Step 3: Implement the tracker and use one tracker per billing action component**

```ts
export function createOperationKeyState(createKey = () => crypto.randomUUID()) {
  let current: { fingerprint: string; key: string } | undefined;
  return {
    keyFor(fingerprint: string) {
      if (!current || current.fingerprint !== fingerprint) current = { fingerprint, key: createKey() };
      return current.key;
    },
    complete(fingerprint: string) {
      if (current?.fingerprint === fingerprint) current = undefined;
    },
  };
}
```

Keep the tracker in `useRef`. Build refund fingerprints from payment id, normalized amount/currency, and reason; build subscription fingerprints from command and subscription id. Call `complete` only after a terminal accepted response.

- [ ] **Step 4: Run unit, type, and lint checks**

```bash
bunx vitest run --config vitest.config.ts tests/unit/commerce/operation-key.test.ts
bun run typecheck
bun run lint
```

Expected: all commands exit `0`.

- [ ] **Step 5: Commit stable operation keys**

```bash
git add src/components/account/operation-key.ts src/components/account/billing-actions.tsx tests/unit/commerce/operation-key.test.ts
git commit -m "fix(commerce): reuse retry operation keys"
```

### Task 6: Owner-fenced Worker Completion and Queue Fairness

**Files:**
- Modify: `src/platform/commerce/application/run-webhook-inbox-worker.ts`
- Modify: `src/platform/commerce/application/run-commerce-command-worker.ts`
- Modify: `src/platform/commerce/application/run-fulfillment-worker.ts`
- Modify: `src/platform/commerce/application/run-commerce-worker.ts`
- Test: `tests/integration/commerce/job-leases.test.ts`

**Interfaces:**
- Ack/nack predicate: `id AND state = 'processing' AND leaseOwner = owner`
- Queue allocation: each non-zero batch reserves at least one slot for inbox, command, and fulfillment when `limit >= 3`.

- [ ] **Step 1: Add failing stale-worker and sustained-backlog tests**

```ts
await reclaimWithOwner(job.id, "new-owner");
releaseOldHandler();
expect(await loadJob(job.id)).toMatchObject({ state: "processing", leaseOwner: "new-owner" });
expect(await securityEventCount("dead_letter_created")).toBe(0);
```

Seed more inbox rows than the aggregate limit plus one command and one fulfillment job; assert a single aggregate run claims all three queue classes.

- [ ] **Step 2: Run lease tests and observe stale acknowledgements or starvation**

```bash
bunx vitest run --config vitest.integration.config.ts tests/integration/commerce/job-leases.test.ts
```

Expected: a stale worker changes the reclaimed row, or the inbox consumes the whole limit.

- [ ] **Step 3: Fence every terminal update and reserve queue capacity**

```ts
const [owned] = await tx
  .update(jobTable)
  .set(nextState)
  .where(and(eq(jobTable.id, job.id), eq(jobTable.state, "processing"), eq(jobTable.leaseOwner, input.owner)))
  .returning({ id: jobTable.id });
if (!owned) return;
```

Insert dead-letter/security/reconciliation side effects only after the fenced update returns a row. In the aggregate worker allocate one third to inbox, one third to commands, and the remainder to fulfillment; spill unused inbox capacity into commands and unused command capacity into fulfillment.

- [ ] **Step 4: Run lease, Commerce, race, and type checks**

```bash
bunx vitest run --config vitest.integration.config.ts tests/integration/commerce/job-leases.test.ts
bun run verify:commerce
bun run verify:credit-races
bun run typecheck
```

Expected: all commands exit `0`.

- [ ] **Step 5: Commit lease fencing and fairness**

```bash
git add src/platform/commerce/application/run-webhook-inbox-worker.ts src/platform/commerce/application/run-commerce-command-worker.ts src/platform/commerce/application/run-fulfillment-worker.ts src/platform/commerce/application/run-commerce-worker.ts tests/integration/commerce/job-leases.test.ts
git commit -m "fix(commerce): fence worker leases"
```

### Task 7: Provider Payment Reconciliation and Waffo Query Contract

**Files:**
- Modify: `src/platform/commerce/domain/events.ts`
- Modify: `src/platform/commerce/application/payment-provider.ts`
- Create: `src/platform/commerce/application/reconcile-stale-payments.ts`
- Modify: `src/platform/commerce/providers/waffo/adapter.ts`
- Modify: `src/app/api/internal/jobs/reconcile/route.ts`
- Modify: `tests/contract/waffo-contract.test.ts`
- Test: `tests/integration/commerce/payment-reconciliation.test.ts`
- Modify: `docs/providers/waffo-contract-2026-08-08.md`

**Interfaces:**
- Waffo filter variables use `String!` for merchant references and payment ids.
- `NormalizedPaymentSnapshot` includes model, amount, provider payment/order ids, merchant reference, occurred time, and subscription-period dates when applicable.
- Reconciliation event id: `payment-reconciliation:${environment}:${externalPaymentId}:${status}`

- [ ] **Step 1: Add failing Waffo contract and missed-webhook tests**

```ts
expect(graphqlBody.query).toContain("$paymentId: String!");
expect(snapshot).toMatchObject({
  model: "one_time",
  amount: { currency: "USD", minor: 2900n },
  merchantOrderReference: order.id,
});
```

Seed a stale checkout-created order, return a succeeded provider snapshot from a fake provider, run reconciliation twice, and assert exactly one succeeded payment and one fulfillment job. Repeat for a subscription snapshot with period dates.

- [ ] **Step 2: Run contract and reconciliation tests and verify missing snapshot fields/service**

```bash
bunx vitest run --config vitest.contract.config.ts tests/contract/waffo-contract.test.ts
bunx vitest run --config vitest.integration.config.ts tests/integration/commerce/payment-reconciliation.test.ts
```

Expected: the contract exposes `ID!`, amount/model fields are absent, and the reconciliation service cannot be imported.

- [ ] **Step 3: Query authoritative fields and feed snapshots through applied-event processing**

```graphql
query ($reference: String!) {
  payments(filter: { orderMerchantExternalId: { eq: $reference } }) {
    id orderId status orderMerchantExternalId createdAt
    snapshotAmountDetails { currency total }
    onetimeOrder { id }
    subscriptionOrder { id currentPeriodStart currentPeriodEnd }
  }
}
```

Reject ambiguous/malformed responses. The reconciler scans bounded stale checkout-created orders under `SKIP LOCKED`, queries by the local order id, converts a terminal snapshot into the matching normalized one-time/subscription event, and calls `processProviderEvent` with a deterministic snapshot hash. Pending/null results remain untouched; provider errors propagate so the job route reports failure.

- [ ] **Step 4: Run contract, reconciliation, Commerce, and type checks**

```bash
bunx vitest run --config vitest.contract.config.ts tests/contract/waffo-contract.test.ts
bunx vitest run --config vitest.integration.config.ts tests/integration/commerce/payment-reconciliation.test.ts
bun run verify:commerce
bun run typecheck
```

Expected: all commands exit `0`. Live provider verification remains owner-side because test/production credentials are not stored in the repository.

- [ ] **Step 5: Commit provider reconciliation**

```bash
git add src/platform/commerce/domain/events.ts src/platform/commerce/application/payment-provider.ts src/platform/commerce/application/reconcile-stale-payments.ts src/platform/commerce/providers/waffo/adapter.ts src/app/api/internal/jobs/reconcile/route.ts tests/contract/waffo-contract.test.ts tests/integration/commerce/payment-reconciliation.test.ts docs/providers/waffo-contract-2026-08-08.md
git commit -m "fix(commerce): reconcile missed payments"
```

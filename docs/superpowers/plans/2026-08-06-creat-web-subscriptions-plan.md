# creat-web Subscriptions and Refunds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Waffo subscription checkout, lifecycle projection, paid-period fulfillment, cancellation/restoration, past-due policy, refund tickets, entitlement reversal, reconciliation, and account-deletion coordination.

**Architecture:** Local subscriptions are projections of verified Waffo state. Each successful paid period creates one uniquely identified `subscription_period`, then one durable fulfillment source. Access policy and credit issuance policy are separate. Refunds are tracked as their own workflow and invoke source-linked entitlement reversal only after authoritative success.

**Tech Stack:** Waffo Pancake TypeScript SDK, PostgreSQL/Drizzle, Next.js server actions/routes, durable jobs, Vitest, Playwright.

## Global Constraints

- Execute only after the credit-ledger plan exit gate passes.
- Authenticated `buyerIdentity` is required for subscription checkout; anonymous subscription checkout is disabled.
- Provider event names and payloads are taken from the current dashboard/test account and captured fixtures, not invented from documentation prose.
- `past_due` is not immediate cancellation and does not create a new credit grant without successful payment.
- `canceling` retains current paid-period access; future periods stop only when cancellation becomes effective.
- Restore is allowed only while provider state/capability proves the subscription is still canceling.
- In-place upgrade/downgrade is not implemented or advertised while Waffo's change-product endpoint returns 501.
- Each paid period/payment can grant at most once across duplicate webhooks, reconciliation, retries, and worker crashes.
- Refund success and entitlement reversal are separate idempotent steps; failed/pending refund does not revoke credits.
- Account deletion cannot silently leave an active renewing subscription.

---

## File Map

- `docs/providers/waffo-subscription-contract.md` — current test-account event/capability capture.
- `src/platform/commerce/domain/subscription.ts` — lifecycle and access policy.
- `src/platform/commerce/domain/refund.ts` — refund ticket state machine.
- `src/platform/database/subscription-schema.ts` — subscriptions, periods, refunds.
- `src/platform/commerce/application/create-subscription-checkout.ts` — authenticated checkout.
- `src/platform/commerce/application/process-subscription-event.ts` — projection and period creation.
- `src/platform/commerce/application/cancel-subscription.ts` — period-end cancellation.
- `src/platform/commerce/application/resume-subscription.ts` — canceling restoration.
- `src/platform/commerce/application/create-refund-ticket.ts` — reviewed refund request.
- `src/platform/commerce/application/process-refund-event.ts` — refund projection/reversal job.
- `src/platform/commerce/application/reconcile-subscription.ts` — provider repair.
- `src/platform/commerce/providers/waffo/subscriptions.ts` — Waffo calls and event mapping.
- `src/platform/commerce/fulfillment/subscription-credit-fulfillment.ts` — period-to-credit grant.
- `src/app/(account)/account/subscription/page.tsx` — owner UI.
- `src/app/api/commerce/subscriptions/*` — authenticated routes/actions where required.
- `scripts/reconcile-subscriptions.ts`, `scripts/process-refunds.ts` — operations.
- `tests/unit/subscriptions/*`, `tests/integration/subscriptions/*`, `tests/contract/waffo/subscriptions.test.ts`, `tests/e2e/subscriptions.spec.ts`.

### Task 1: Capture current Waffo subscription/refund contract

**Files:**
- Create: `docs/providers/waffo-subscription-contract.md`
- Create: `tests/fixtures/waffo/subscriptions/fixture-meta.json`
- Create: sanitized fixtures under `tests/fixtures/waffo/subscriptions/`
- Modify: `.env.example`

**Interfaces:**
- Produces exact test-account facts consumed by mapper/contract tests.

- [ ] **Step 1: Create isolated test subscription product**

Create one monthly test subscription product with no trial for the baseline flow. If trials are required for a later product, create a second test product only after the baseline lifecycle passes.

- [ ] **Step 2: Record exact capabilities and events**

The committed document must contain actual values for:

```text
Captured at UTC
SDK version
Subscription product ID variable
Billing period representation
Checkout/session/order methods or endpoints
Authenticated buyerIdentity field location
Current dashboard event names for activation, paid renewal, update, past_due, canceling, canceled, uncanceled/restored, refund succeeded and refund failed
External subscription/order/payment identifiers in every fixture
Period start/end field names and formats
Cancel method/endpoint and returned state
Resume method/endpoint and returned state
Customer portal availability in the test account
Change-product behavior and observed 501 response
Refund ticket create/query methods and statuses
```

No placeholders, secrets, real emails, signatures, checkout URLs or billing details remain.

- [ ] **Step 3: Capture sanitized lifecycle fixtures**

Capture or generate from official test mode:

- activation/first successful payment;
- renewal successful payment;
- past due;
- canceling;
- canceled;
- restored/uncanceled;
- refund ticket created/approved/succeeded if available;
- refund failed;
- unknown signed subscription event.

Preserve exact field names/types; replace identifiers/data with synthetic equivalents.

- [ ] **Step 4: Update environment variables**

```text
WAFFO_SUBSCRIPTION_PRODUCT_ID=
WAFFO_CUSTOMER_PORTAL_ENABLED=false
WAFFO_CANCEL_AT_PERIOD_END=true
WAFFO_RESUME_CANCELING_ENABLED=true
WAFFO_IN_PLACE_PLAN_CHANGE_ENABLED=false
```

- [ ] **Step 5: Commit**

```bash
git add docs/providers/waffo-subscription-contract.md tests/fixtures/waffo/subscriptions .env.example
git commit -m "docs: capture Waffo subscription and refund contract"
```

### Task 2: Define subscription and refund state machines

**Files:**
- Create: `src/platform/commerce/domain/subscription.ts`
- Create: `src/platform/commerce/domain/refund.ts`
- Create: `tests/unit/subscriptions/state-machine.test.ts`
- Create: `tests/unit/subscriptions/access-policy.test.ts`
- Create: `tests/unit/subscriptions/refund-state.test.ts`

**Interfaces:**
- Produces `SubscriptionStatus = pending | trialing | active | past_due | canceling | canceled | expired | closed`.
- Produces `transitionSubscription(current, fact): SubscriptionStatus`.
- Produces `subscriptionAccessDecision(snapshot, now, policy): AccessDecision`.
- Produces `RefundStatus = requested | approved | rejected | processing | succeeded | failed`.

- [ ] **Step 1: Write failing state/access tests**

```ts
import { expect, it } from "vitest";
import { transitionSubscription, subscriptionAccessDecision } from "@/platform/commerce/domain/subscription";

it("treats duplicate activation and renewal facts idempotently", () => {
  expect(transitionSubscription("active", { type: "activated", occurredAt: new Date() })).toBe("active");
});

it("does not move backward on an older event", () => {
  expect(() => transitionSubscription("canceling", { type: "activated", occurredAt: new Date("2026-01-01"), lastEventAt: new Date("2026-02-01") })).toThrow("stale subscription event");
});

it("keeps canceling access through period end", () => {
  expect(subscriptionAccessDecision({ status: "canceling", periodEnd: new Date("2026-09-01") }, new Date("2026-08-20"), { pastDueGraceDays: 3 }).allowed).toBe(true);
});

it("does not issue credits from past-due state", () => {
  expect(subscriptionAccessDecision({ status: "past_due", periodEnd: new Date("2026-09-01") }, new Date("2026-08-20"), { pastDueGraceDays: 3 }).issuePeriodCredits).toBe(false);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun run test:unit -- tests/unit/subscriptions`

Expected: FAIL.

- [ ] **Step 3: Implement explicit state and policy functions**

State transitions use provider occurrence/version ordering where available. Reconciliation may repair an inconsistent projection but must record reason/source. Access decision returns separate fields:

```ts
export type AccessDecision = {
  allowed: boolean;
  reason: "active" | "trial" | "paid_period" | "past_due_grace" | "ended" | "never_activated";
  issuePeriodCredits: boolean;
};
```

Refund state never collapses into payment status.

- [ ] **Step 4: Run tests and commit**

Run: `bun run test:unit -- tests/unit/subscriptions`

Expected: PASS.

```bash
git add src/platform/commerce/domain/subscription.ts src/platform/commerce/domain/refund.ts tests/unit/subscriptions
git commit -m "feat: define subscription access and refund states"
```

### Task 3: Add subscription, period, and refund persistence

**Files:**
- Create: `src/platform/database/subscription-schema.ts`
- Modify: `src/platform/database/schema.ts`
- Create: migration under `drizzle/`
- Create: `tests/integration/subscriptions/schema.test.ts`
- Create: `tests/integration/subscriptions/constraints.test.ts`

**Interfaces:**
- Produces tables `subscriptions`, `subscription_periods`, `refunds`.

- [ ] **Step 1: Write failing constraint tests**

Tests assert uniqueness of `(environment, external_subscription_id)`, `(subscription_id, external_payment_id)`, period fulfillment key, external refund/ticket ID, and refund reversal key. Invalid periods (`end <= start`), negative refund amount, unsupported status, and user mismatch fail.

- [ ] **Step 2: Run to verify failure**

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" bun run test:integration -- tests/integration/subscriptions/schema.test.ts tests/integration/subscriptions/constraints.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement schema**

```text
subscriptions:
  id, user_id, product_id, environment, external_subscription_id,
  external_customer_id, status, billing_period,
  current_period_start, current_period_end,
  cancel_at_period_end, last_provider_event_id,
  last_provider_event_at, last_reconciled_at, created_at, updated_at
  UNIQUE(environment, external_subscription_id)

subscription_periods:
  id, subscription_id, external_payment_id, external_period_id nullable,
  period_start, period_end, payment_status, fulfillment_status,
  fulfillment_key, refund_id nullable, created_at, fulfilled_at
  UNIQUE(subscription_id, external_payment_id)
  UNIQUE(fulfillment_key)
  CHECK(period_end > period_start)

refunds:
  id, environment, external_refund_id, external_ticket_id,
  payment_id, order_id nullable, subscription_period_id nullable,
  status, currency, requested_minor, approved_minor nullable,
  reason_code, operator_note_redacted, reversal_status,
  reversal_key, created_at, resolved_at
  UNIQUE(environment, external_refund_id)
  UNIQUE(environment, external_ticket_id)
  UNIQUE(reversal_key)
```

- [ ] **Step 4: Generate/apply migration and run tests**

Run:

```bash
bun run db:generate
DATABASE_URL="$TEST_DATABASE_URL" bun run db:migrate
TEST_DATABASE_URL="$TEST_DATABASE_URL" bun run test:integration -- tests/integration/subscriptions
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/platform/database/subscription-schema.ts src/platform/database/schema.ts drizzle tests/integration/subscriptions
git commit -m "feat: add subscription periods and refund persistence"
```

### Task 4: Extend product catalog and Waffo adapter for subscriptions

**Files:**
- Modify: `src/platform/commerce/domain/product.ts`
- Modify: `src/config/products.config.ts`
- Create: `src/platform/commerce/providers/waffo/subscriptions.ts`
- Create: `tests/contract/waffo/subscriptions.test.ts`

**Interfaces:**
- Extends `PaymentProvider` with capability-scoped methods:
  - `createSubscriptionCheckout`
  - `getSubscription`
  - `cancelSubscriptionAtPeriodEnd`
  - `resumeCancelingSubscription`
  - `createRefundTicket`
  - `getRefundTicket`

- [ ] **Step 1: Write failing fixture contract tests**

Tests load captured fixtures and assert exact mapping to subscription IDs, customer IDs, payment IDs, billing period, period boundaries, statuses, refund IDs/statuses, and normalized amount/currency. A 501 change-product response must map to `capability_not_supported`, not a generic server error.

- [ ] **Step 2: Run to verify failure**

Run: `bun run test:contract -- tests/contract/waffo/subscriptions.test.ts`

Expected: FAIL.

- [ ] **Step 3: Extend product definitions**

Subscription product snapshots add:

```ts
billingPeriod: "weekly" | "monthly" | "quarterly" | "yearly";
trialDays: number;
periodFulfillment: { type: "credits"; creditType: string; quantity: number; expiresInDays?: number } | { type: "access"; entitlementKey: string };
pastDueGraceDays: number;
```

Trial defaults to `0`; a nonzero trial requires authenticated buyer identity and explicit legal/product configuration.

- [ ] **Step 4: Implement Waffo calls using exact captured SDK methods**

The adapter supplies stable `buyerIdentity=userId`, validates checkout URL origin, and declares capabilities:

```ts
{
  oneTime: true,
  subscriptions: true,
  refunds: true,
  partialRefunds: true,
  customerPortal: <actual tested value>,
  cancelAtPeriodEnd: true,
  resumeCancelingSubscription: true,
  inPlacePlanChange: false
}
```

Replace `<actual tested value>` with the committed test-account result before implementation commit.

- [ ] **Step 5: Run contract tests and commit**

Run: `bun run test:contract -- tests/contract/waffo/subscriptions.test.ts`

Expected: PASS.

```bash
git add src/platform/commerce/domain/product.ts src/config/products.config.ts src/platform/commerce/providers/waffo/subscriptions.ts tests/contract/waffo/subscriptions.test.ts
git commit -m "feat: extend Waffo adapter for subscriptions"
```

### Task 5: Implement authenticated subscription checkout

**Files:**
- Create: `src/platform/commerce/application/create-subscription-checkout.ts`
- Create: `src/platform/commerce/infrastructure/subscription-repository.ts`
- Create: `src/app/api/commerce/subscriptions/checkout/route.ts`
- Create: `tests/integration/subscriptions/create-checkout.test.ts`
- Create: `tests/e2e/subscriptions.spec.ts`

**Interfaces:**
- Produces `createSubscriptionCheckout({ userId, productKey, requestKey }): Promise<{ subscriptionId; checkoutUrl }>`.

- [ ] **Step 1: Write failing tests**

Tests assert authentication required, subscription product required, stable buyer identity equals canonical user ID, duplicate request key does not create two subscriptions/checkouts, trial product without buyer identity is impossible, client price/period fields are rejected, and provider failure leaves pending retryable state.

- [ ] **Step 2: Run to verify failure**

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" bun run test:integration -- tests/integration/subscriptions/create-checkout.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement checkout use case and route**

Use server product snapshot and canonical user ID. Create local pending subscription intent before external call. Return hosted checkout URL; do not activate subscription from the return page.

- [ ] **Step 4: Run tests and commit**

Run:

```bash
TEST_DATABASE_URL="$TEST_DATABASE_URL" bun run test:integration -- tests/integration/subscriptions/create-checkout.test.ts
bun run test:e2e -- tests/e2e/subscriptions.spec.ts
```

Expected: PASS with provider stub.

```bash
git add src/platform/commerce/application/create-subscription-checkout.ts src/platform/commerce/infrastructure/subscription-repository.ts src/app/api/commerce/subscriptions/checkout tests/integration/subscriptions/create-checkout.test.ts tests/e2e/subscriptions.spec.ts
git commit -m "feat: create authenticated subscription checkout"
```

### Task 6: Process subscription events and create unique paid periods

**Files:**
- Create: `src/platform/commerce/application/process-subscription-event.ts`
- Modify: `src/platform/commerce/application/process-provider-event.ts`
- Modify: `src/platform/commerce/domain/events.ts`
- Create: `tests/integration/subscriptions/event-processing.test.ts`
- Create: `tests/integration/subscriptions/out-of-order.test.ts`

**Interfaces:**
- Produces normalized events `subscription_activated`, `subscription_payment_succeeded`, `subscription_past_due`, `subscription_canceling`, `subscription_canceled`, `subscription_restored`, `subscription_updated`.

- [ ] **Step 1: Write failing duplicate/out-of-order tests**

Tests assert activation/renewal duplicate events produce one period, older events do not move state backward, renewal without payment ID/period boundaries blocks and dead-letters, amount/product/user/environment mismatch blocks, past_due creates no period grant, canceling/canceled/restored preserve period history, and reconciliation uses the same path.

- [ ] **Step 2: Run to verify failure**

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" bun run test:integration -- tests/integration/subscriptions/event-processing.test.ts tests/integration/subscriptions/out-of-order.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement transactional projection**

Inside one transaction:

1. lock inbox and subscription projection;
2. validate environment/store/customer/user/product;
3. reject stale/conflicting event or record unsupported fields;
4. apply idempotent status transition;
5. on successful paid period, insert `subscription_period` by external payment ID and period boundaries;
6. insert fulfillment job with key `subscription-period:<subscriptionId>:<externalPaymentId>`;
7. mark inbox processed.

- [ ] **Step 4: Run tests repeatedly and commit**

Run:

```bash
for i in 1 2 3; do TEST_DATABASE_URL="$TEST_DATABASE_URL" bun run test:integration -- tests/integration/subscriptions/event-processing.test.ts tests/integration/subscriptions/out-of-order.test.ts || exit 1; done
```

Expected: PASS.

```bash
git add src/platform/commerce/application/process-subscription-event.ts src/platform/commerce/application/process-provider-event.ts src/platform/commerce/domain/events.ts tests/integration/subscriptions/event-processing.test.ts tests/integration/subscriptions/out-of-order.test.ts
git commit -m "feat: project subscription lifecycle idempotently"
```

### Task 7: Fulfill subscription periods with credits exactly once

**Files:**
- Create: `src/platform/commerce/fulfillment/subscription-credit-fulfillment.ts`
- Modify: `scripts/commerce-worker.ts`
- Create: `tests/integration/subscriptions/period-fulfillment.test.ts`

**Interfaces:**
- Implements period fulfillment from immutable product/period snapshot to `grantCredits` source `{ type: "subscription_period", id: periodId }`.

- [ ] **Step 1: Write failing period grant tests**

Tests assert activation and each successful renewal grant once, duplicate event/reconciliation/worker retry no duplicate, past_due no grant, canceled no future period grant, period refund links to exact grant, and product snapshot determines quantity/expiry.

- [ ] **Step 2: Run to verify failure**

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" bun run test:integration -- tests/integration/subscriptions/period-fulfillment.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement period fulfillment**

```ts
await grantCredits({
  userId: period.userId,
  creditType: period.fulfillment.creditType,
  quantity: period.fulfillment.quantity,
  source: { type: "subscription_period", id: period.id },
  idempotencyKey: `subscription-credit:${period.id}`,
  expiresAt: period.fulfillment.expiresAt,
  actor: "system",
});
```

Mark period fulfilled only after grant transaction succeeds. Retry safely after crash between grant return and job acknowledgment.

- [ ] **Step 4: Run tests and commit**

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" bun run test:integration -- tests/integration/subscriptions/period-fulfillment.test.ts`

Expected: PASS.

```bash
git add src/platform/commerce/fulfillment/subscription-credit-fulfillment.ts scripts/commerce-worker.ts tests/integration/subscriptions/period-fulfillment.test.ts
git commit -m "feat: grant subscription period credits once"
```

### Task 8: Implement cancellation, restoration, and owner subscription UI

**Files:**
- Create: `src/platform/commerce/application/cancel-subscription.ts`
- Create: `src/platform/commerce/application/resume-subscription.ts`
- Create: `src/app/api/commerce/subscriptions/cancel/route.ts`
- Create: `src/app/api/commerce/subscriptions/resume/route.ts`
- Create: `src/app/(account)/account/subscription/page.tsx`
- Create: `tests/integration/subscriptions/cancel-resume.test.ts`
- Modify: `tests/e2e/subscriptions.spec.ts`

**Interfaces:**
- Produces `cancelSubscription({ actorUserId, subscriptionId }): Promise<SubscriptionSnapshot>`.
- Produces `resumeSubscription({ actorUserId, subscriptionId }): Promise<SubscriptionSnapshot>`.

- [ ] **Step 1: Write failing owner/capability tests**

Tests assert cross-user denial, fresh session required, active may request cancellation, canceling may restore, canceled cannot use resume action, duplicate requests idempotent, provider failure does not fake state, and no immediate-access removal before period end.

- [ ] **Step 2: Run to verify failure**

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" bun run test:integration -- tests/integration/subscriptions/cancel-resume.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement actions and UI**

UI shows plan, state, paid period end, billing recovery message, cancel-at-period-end status, supported actions and stable support code. It does not display an upgrade/downgrade control. Local state changes only after trusted provider response/event and is reconciled if ambiguous.

- [ ] **Step 4: Run integration/E2E and commit**

Run:

```bash
TEST_DATABASE_URL="$TEST_DATABASE_URL" bun run test:integration -- tests/integration/subscriptions/cancel-resume.test.ts
bun run test:e2e -- tests/e2e/subscriptions.spec.ts
```

Expected: PASS.

```bash
git add src/platform/commerce/application/cancel-subscription.ts src/platform/commerce/application/resume-subscription.ts src/app/api/commerce/subscriptions src/app/'(account)'/account/subscription tests/integration/subscriptions/cancel-resume.test.ts tests/e2e/subscriptions.spec.ts
git commit -m "feat: manage period-end subscription cancellation"
```

### Task 9: Implement refund tickets and entitlement reversal

**Files:**
- Create: `src/platform/commerce/application/create-refund-ticket.ts`
- Create: `src/platform/commerce/application/process-refund-event.ts`
- Create: `src/platform/commerce/infrastructure/refund-repository.ts`
- Create: `src/app/api/commerce/refunds/route.ts`
- Create: `scripts/process-refunds.ts`
- Create: `tests/integration/subscriptions/refunds.test.ts`
- Create: `tests/contract/waffo/refunds.test.ts`

**Interfaces:**
- Produces `requestRefund({ userId, paymentId, reasonCode, requestedAmount? }): Promise<Refund>`.
- Produces `processRefundEvent(event): Promise<void>`.

- [ ] **Step 1: Write failing refund tests**

Tests assert owner/fresh-session validation, refund-window/policy decision, exact payment association, safe decimal/minor amount, duplicate request/ticket/event idempotency, pending/approved/processing no credit reversal, succeeded creates one reversal job, failed leaves entitlement unchanged, full refund revokes only unused source credits, and ambiguous partial refund requires operator review.

- [ ] **Step 2: Run to verify failure**

Run:

```bash
bun run test:contract -- tests/contract/waffo/refunds.test.ts
TEST_DATABASE_URL="$TEST_DATABASE_URL" bun run test:integration -- tests/integration/subscriptions/refunds.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement ticket and event workflow**

Provider adapter uses the exact current SDK method captured in Task 1. Store only redacted reason code/notes. On authoritative `refund.succeeded`, insert a unique entitlement-reversal job. The worker calls `revokeSourceCredits` for order or subscription-period source and records `revokedUnused`, `unrecoveredConsumed`, and operator-review status.

- [ ] **Step 4: Run tests and commit**

Run:

```bash
bun run test:contract -- tests/contract/waffo/refunds.test.ts
TEST_DATABASE_URL="$TEST_DATABASE_URL" bun run test:integration -- tests/integration/subscriptions/refunds.test.ts
```

Expected: PASS.

```bash
git add src/platform/commerce/application/create-refund-ticket.ts src/platform/commerce/application/process-refund-event.ts src/platform/commerce/infrastructure/refund-repository.ts src/app/api/commerce/refunds scripts/process-refunds.ts tests/integration/subscriptions/refunds.test.ts tests/contract/waffo/refunds.test.ts
git commit -m "feat: process refunds and entitlement reversal"
```

### Task 10: Add subscription reconciliation and account-deletion participation

**Files:**
- Create: `src/platform/commerce/application/reconcile-subscription.ts`
- Create: `src/platform/commerce/application/account-deletion-commerce.ts`
- Modify: `src/platform/auth/account-deletion.ts`
- Create: `scripts/reconcile-subscriptions.ts`
- Create: `tests/integration/subscriptions/reconciliation.test.ts`
- Create: `tests/integration/subscriptions/account-deletion.test.ts`

**Interfaces:**
- Produces `reconcileSubscription({ actor, subscriptionId }): Promise<ReconciliationResult>`.
- Produces commerce deletion phase `cancel_active_subscriptions | preserve_financial_records | complete`.

- [ ] **Step 1: Write failing reconciliation/deletion tests**

Tests simulate missed renewal/canceling/canceled events and assert repair through normalized event processing with no duplicate periods/grants. Account deletion test asserts active/canceling subscription is handled according to policy before identity completion, all future renewals are prevented, financial records remain linked through pseudonymous stable reference, and retries are idempotent.

- [ ] **Step 2: Run to verify failure**

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" bun run test:integration -- tests/integration/subscriptions/reconciliation.test.ts tests/integration/subscriptions/account-deletion.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement reconciliation and deletion phase**

Reconciliation queries provider, compares customer/user/product/environment/period/payment state, then emits normalized repair facts. Account deletion blocks final identity removal if cancellation is unresolved; it never marks complete merely because a provider call timed out.

- [ ] **Step 4: Run tests and commit**

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" bun run test:integration -- tests/integration/subscriptions/reconciliation.test.ts tests/integration/subscriptions/account-deletion.test.ts`

Expected: PASS.

```bash
git add src/platform/commerce/application/reconcile-subscription.ts src/platform/commerce/application/account-deletion-commerce.ts src/platform/auth/account-deletion.ts scripts/reconcile-subscriptions.ts tests/integration/subscriptions/reconciliation.test.ts tests/integration/subscriptions/account-deletion.test.ts
git commit -m "feat: reconcile subscriptions and coordinate deletion"
```

### Task 11: Complete live test-mode lifecycle and release gates

**Files:**
- Create: `tests/contract/waffo/live-subscription.test.ts`
- Create: `tests/integration/subscriptions/fault-injection.test.ts`
- Create: `docs/runbooks/subscription-incidents.md`
- Create: `docs/setup/waffo-subscriptions.md`
- Modify: `scripts/verify-release.ts`
- Modify: legal/refund/cancellation configuration and documents

**Interfaces:**
- Produces opt-in real test-mode lifecycle evidence.

- [ ] **Step 1: Add fault-injection tests**

Cover duplicate/out-of-order events, crash after period insert before job acknowledgment, provider timeout during cancel/resume/refund/reconciliation, stale past_due event, event with wrong user/customer/product/environment, and dead-letter retry.

- [ ] **Step 2: Run fault tests**

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" bun run test:integration -- tests/integration/subscriptions/fault-injection.test.ts`

Expected: PASS.

- [ ] **Step 3: Execute real test-mode lifecycle**

With test credentials:

1. authenticated user creates subscription checkout;
2. successful test payment activates local subscription;
3. first period grants once;
4. duplicate activation/payment event grants none additional;
5. simulate/observe renewal and assert one new period grant;
6. request cancel, verify `canceling` and retained access;
7. restore before period end, verify active;
8. request cancel again and verify no future period after effective cancellation;
9. run refund ticket success/failed paths available in test mode and verify exact reversal behavior;
10. run reconciliation after intentionally withholding one webhook.

Record sanitized evidence in PR artifacts, not repository fixtures with real data.

- [ ] **Step 4: Add release validation**

Release fails if subscriptions enabled without buyer identity, period mapping, unique fulfillment key, past-due/access policy, cancellation/restoration capability tests, refund policy, reconciliation, account-deletion handling, matching legal text, or observed 501 guard for plan changes.

- [ ] **Step 5: Run full gate**

```bash
bun run format:check
bun run lint
bun run typecheck
bun run test:unit
TEST_DATABASE_URL="$TEST_DATABASE_URL" bun run test:integration
bun run test:contract
bun run build
bun run test:e2e -- tests/e2e/subscriptions.spec.ts tests/e2e/credits.spec.ts
bun run verify:release
```

Expected: all offline commands exit `0`; live test-mode suite passes separately.

- [ ] **Step 6: Commit**

```bash
git add tests/contract/waffo/live-subscription.test.ts tests/integration/subscriptions/fault-injection.test.ts docs/runbooks/subscription-incidents.md docs/setup/waffo-subscriptions.md scripts/verify-release.ts src/config/legal.config.ts src/app/'(legal)'
git commit -m "test: verify subscription refund and cancellation lifecycle"
```

## Subscriptions/Refunds Exit Gate

Before requesting review, prove:

- actual current Waffo subscription/refund event contract is captured without secrets;
- authenticated buyer identity is always supplied;
- activation and every successful paid period create at most one period and one entitlement source;
- duplicate/out-of-order/reconciled events cannot duplicate credits or move state backward incorrectly;
- past_due creates no new period credit and follows explicit access grace policy;
- canceling retains current-period access and restoration works only before effective cancellation;
- no upgrade/downgrade UI or implementation exists while capability is unsupported;
- refunds track their own lifecycle and revoke only after authoritative success;
- partial-refund ambiguity blocks for operator review;
- account deletion cannot leave a renewing subscription and preserves financial evidence;
- real Waffo test-mode activation/renewal/cancel/restore/refund/reconciliation flows pass;
- legal subscription, cancellation, refund and credit terms match actual behavior;
- full CI/integration/contract/E2E gates pass.

# creat-web Commerce and One-Time Payments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a provider-isolated commerce core and a reliable Waffo one-time purchase flow with local orders/payments, signed webhook ingestion, durable processing, reconciliation, and operator inspection—without granting credits yet.

**Architecture:** The Waffo adapter translates provider calls and events into normalized commerce facts. Local order/payment state and webhook inbox/outbox are authoritative for application behavior. Browser redirects show processing only; fulfillment begins after a verified event or trusted provider reconciliation and remains behind an `OrderFulfillment` interface.

**Tech Stack:** Waffo Pancake TypeScript SDK, Next.js route handlers/server actions, PostgreSQL/Drizzle, Zod, Node crypto, Vitest, Playwright.

## Global Constraints

- Execute only after the SEO/Home/Legal plan exit gate passes.
- Waffo is the only payment provider implementation in v1.
- Do not grant credits in this plan.
- Client-submitted amount, currency, product name, provider product ID, or entitlement is never authoritative.
- Use local product keys and versioned server-side product snapshots.
- Browser return URLs never mark orders paid or trigger fulfillment.
- Verify webhook signatures against the exact raw body before trusting any payload field.
- Test/live merchant, store, product, key, header, and webhook identities must be impossible to mix silently.
- Persist valid unknown signed events for operator review.
- Duplicate events, payment IDs, checkout requests, and fulfillment source keys must be idempotent at database-constraint level.
- Monetary values use validated decimal strings and integer minor units; binary floating point is forbidden.

---

## File Map

- `docs/providers/waffo-test-contract.md` — captured account capabilities, event names, headers, fixtures and dates.
- `src/platform/commerce/domain/money.ts` — currency-safe parsing/comparison.
- `src/platform/commerce/domain/product.ts` — immutable product definitions/snapshots.
- `src/platform/commerce/domain/order.ts` — order state machine.
- `src/platform/commerce/domain/payment.ts` — payment/refund projection.
- `src/platform/commerce/domain/events.ts` — normalized provider facts.
- `src/platform/commerce/application/payment-provider.ts` — provider boundary.
- `src/platform/commerce/application/create-checkout.ts` — authenticated checkout use case.
- `src/platform/commerce/application/process-provider-event.ts` — transactional state transitions and outbox creation.
- `src/platform/commerce/application/order-fulfillment.ts` — fulfillment boundary.
- `src/platform/commerce/providers/waffo/client.ts` — server-only SDK construction.
- `src/platform/commerce/providers/waffo/adapter.ts` — checkout/query/event normalization.
- `src/platform/commerce/providers/waffo/webhook.ts` — signature verification.
- `src/platform/database/commerce-schema.ts` — product/order/payment/inbox/outbox/reconciliation records.
- `src/app/api/commerce/checkout/route.ts` — authenticated checkout creation.
- `src/app/api/webhooks/waffo/route.ts` — raw-body webhook endpoint.
- `src/app/(account)/checkout/return/page.tsx` — processing/status UI.
- `src/app/(account)/account/billing/page.tsx` — owner-scoped history.
- `scripts/commerce-worker.ts`, `scripts/reconcile-commerce.ts`, `scripts/inspect-commerce.ts` — durable processing/operator tools.
- `tests/unit/commerce/*`, `tests/integration/commerce/*`, `tests/contract/waffo/*`, `tests/e2e/commerce.spec.ts`.

### Task 1: Capture the live Waffo test-account contract before adapter code

**Files:**
- Create: `docs/providers/waffo-test-contract.md`
- Create: `tests/fixtures/waffo/README.md`
- Modify: `.env.example`

**Interfaces:**
- Produces reviewed facts consumed by adapter/contract tests: merchant/store identity, environment header, checkout endpoints, current event names, signature header name/format, payload samples, test product IDs, supported refund/portal capabilities.

- [ ] **Step 1: Create isolated Waffo test resources**

In Waffo test mode create:

- one merchant API key dedicated to staging;
- one staging store;
- one fixed-price USD one-time product;
- one HTTPS staging webhook endpoint selecting at least `order.completed`, `refund.succeeded`, and `refund.failed` if currently offered;
- a webhook signing secret.

Do not copy live IDs or keys into the repository.

- [ ] **Step 2: Record exact current contract facts**

`docs/providers/waffo-test-contract.md` must contain:

```text
Captured at (UTC): <actual ISO timestamp>
Dashboard environment: test
SDK package/version: <exact installed version>
Merchant ID variable: WAFFO_MERCHANT_ID
Store ID variable: WAFFO_STORE_ID
Environment header/value: <actual header and test value>
Webhook signature header: <actual header>
Signature input: raw UTF-8 request body
Signature algorithm/encoding: HMAC-SHA256 / <actual encoding>
One-time checkout flow: create-session -> create-order -> hosted checkout URL
Current selected event names: <actual names copied from dashboard>
Unknown signed event policy: persist as unsupported
```

The angle-bracket values are replaced with actual captured values in the committed document; no placeholders may remain.

- [ ] **Step 3: Capture sanitized fixtures**

Perform one successful and one declined test checkout. Store sanitized JSON fixtures under `tests/fixtures/waffo/` with synthetic UUIDs/emails, preserving field names/types and adding a `fixture-meta.json` containing capture date, environment, event name and schema hash. Never commit real checkout URLs, signatures, private keys, billing details, or customer data.

- [ ] **Step 4: Update environment documentation**

Add purpose-specific variables:

```text
WAFFO_MERCHANT_ID=
WAFFO_PRIVATE_KEY=
WAFFO_STORE_ID=
WAFFO_WEBHOOK_SECRET=
WAFFO_ENVIRONMENT=test
WAFFO_ONETIME_PRODUCT_ID=
```

- [ ] **Step 5: Commit**

```bash
git add docs/providers/waffo-test-contract.md tests/fixtures/waffo .env.example
git commit -m "docs: capture Waffo test account contract"
```

### Task 2: Add money parsing and immutable local product catalog

**Files:**
- Create: `src/platform/commerce/domain/money.ts`
- Create: `src/platform/commerce/domain/product.ts`
- Create: `src/config/products.config.ts`
- Create: `src/platform/commerce/application/product-catalog.ts`
- Create: `tests/unit/commerce/money.test.ts`
- Create: `tests/unit/commerce/product-catalog.test.ts`

**Interfaces:**
- Produces: `Money = { currency: string; minor: bigint }`.
- Produces: `parseDisplayAmount(value, currency): Money` and `formatDisplayAmount(money): string`.
- Produces: `ProductDefinition`, `ProductSnapshot`, `ProductCatalog.getEnabled(key)`.

- [ ] **Step 1: Write failing money tests**

```ts
import { expect, it } from "vitest";
import { parseDisplayAmount } from "@/platform/commerce/domain/money";

it("parses decimal display strings without binary floating point", () => {
  expect(parseDisplayAmount("29.00", "USD")).toEqual({ currency: "USD", minor: 2900n });
  expect(parseDisplayAmount("4500", "JPY")).toEqual({ currency: "JPY", minor: 4500n });
});

it("rejects malformed or over-precision values", () => {
  expect(() => parseDisplayAmount("29.001", "USD")).toThrow("invalid USD precision");
  expect(() => parseDisplayAmount("NaN", "USD")).toThrow("invalid amount");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun run test:unit -- tests/unit/commerce/money.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement safe currency parsing**

```ts
const FRACTION_DIGITS: Record<string, number> = { USD: 2, EUR: 2, GBP: 2, JPY: 0 };

export type Money = { currency: string; minor: bigint };

export function parseDisplayAmount(value: string, currencyInput: string): Money {
  const currency = currencyInput.toUpperCase();
  const digits = FRACTION_DIGITS[currency];
  if (digits === undefined || !/^\d+(?:\.\d+)?$/.test(value)) throw new Error("invalid amount");
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > digits) throw new Error(`invalid ${currency} precision`);
  return { currency, minor: BigInt(whole) * 10n ** BigInt(digits) + BigInt((fraction + "0".repeat(digits)).slice(0, digits) || "0") };
}
```

- [ ] **Step 4: Define product catalog**

```ts
export type ProductDefinition = {
  key: string;
  version: number;
  enabled: boolean;
  commercialModel: "one_time" | "subscription";
  currency: string;
  expectedPrice: string;
  providerProductIdByEnvironment: { test: string; production?: string };
  fulfillmentKey: string;
  refundPolicyKey: string;
};
```

Catalog validation rejects duplicate key/version pairs, unsupported currency/precision, missing environment mapping, mutable reuse of an existing version, subscription fields on one-time products and disabled product checkout.

- [ ] **Step 5: Run tests and commit**

Run: `bun run test:unit -- tests/unit/commerce`

Expected: PASS.

```bash
git add src/platform/commerce/domain src/platform/commerce/application/product-catalog.ts src/config/products.config.ts tests/unit/commerce
git commit -m "feat: add safe money and versioned commerce catalog"
```

### Task 3: Create commerce schema and database invariants

**Files:**
- Create: `src/platform/database/commerce-schema.ts`
- Modify: `src/platform/database/schema.ts`
- Create: migration under `drizzle/`
- Create: `tests/integration/commerce/schema.test.ts`
- Create: `tests/integration/commerce/idempotency-constraints.test.ts`

**Interfaces:**
- Produces tables: `commerce_products`, `orders`, `payments`, `payment_webhook_inbox`, `fulfillment_jobs`, `commerce_reconciliation_runs`.

- [ ] **Step 1: Write failing schema/invariant tests**

Tests insert duplicate provider event ID, external payment ID, checkout idempotency key and fulfillment source key, asserting PostgreSQL unique-constraint failures. Also assert an order cannot store negative expected minor amount or unsupported environment.

- [ ] **Step 2: Run to verify failure**

Run:

```bash
TEST_DATABASE_URL="$TEST_DATABASE_URL" bun run test:integration -- tests/integration/commerce/schema.test.ts tests/integration/commerce/idempotency-constraints.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement schema with explicit constraints**

Required columns/constraints:

```text
commerce_products: id, key, version, model, environment, provider_product_id, currency, expected_minor, fulfillment_key, refund_policy_key, enabled, active_from, active_to; UNIQUE(key, version, environment)
orders: id, user_id, product_id, environment, status, expected_currency, expected_minor, checkout_idempotency_key, external_checkout_session_id, external_order_id, created_at, paid_at, canceled_at; UNIQUE(checkout_idempotency_key), UNIQUE(environment, external_order_id)
payments: id, order_id, external_payment_id, status, refund_status, currency, amount_minor, provider_created_at, raw_payload_hash, reconciled_at; UNIQUE(environment, external_payment_id)
payment_webhook_inbox: id, environment, provider_event_id, dedup_hash, event_type, signature_valid, payload_json, payload_hash, state, attempts, lease_owner, lease_expires_at, next_attempt_at, last_error_code, received_at, processed_at; UNIQUE(environment, provider_event_id), UNIQUE(environment, dedup_hash)
fulfillment_jobs: id, source_type, source_id, operation, idempotency_key, state, attempts, lease_owner, lease_expires_at, next_attempt_at, last_error_code, created_at, completed_at; UNIQUE(idempotency_key)
commerce_reconciliation_runs: id, target_type, target_id, actor_type, before_json, after_json, result, created_at
```

Store minor units as `bigint`; JSON payloads are sanitized before insertion and bounded by a size check in application code.

- [ ] **Step 4: Generate/apply migration and run tests**

Run:

```bash
bun run db:generate
DATABASE_URL="$TEST_DATABASE_URL" bun run db:migrate
TEST_DATABASE_URL="$TEST_DATABASE_URL" bun run test:integration -- tests/integration/commerce
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/platform/database/commerce-schema.ts src/platform/database/schema.ts drizzle tests/integration/commerce
git commit -m "feat: add constrained commerce persistence model"
```

### Task 4: Define commerce state machines and provider boundary

**Files:**
- Create: `src/platform/commerce/domain/order.ts`
- Create: `src/platform/commerce/domain/payment.ts`
- Create: `src/platform/commerce/domain/events.ts`
- Create: `src/platform/commerce/application/payment-provider.ts`
- Create: `src/platform/commerce/application/order-fulfillment.ts`
- Create: `tests/unit/commerce/order-state.test.ts`
- Create: `tests/unit/commerce/payment-state.test.ts`

**Interfaces:**
- Produces `OrderStatus = pending | paid | canceled | partially_refunded | refunded`.
- Produces `PaymentStatus = pending | succeeded | failed | canceled` and independent `RefundStatus`.
- Produces `PaymentProvider.createOneTimeCheckout`, `getPayment`, `verifyAndNormalizeWebhook`.
- Produces `OrderFulfillment.fulfill(command)`.

- [ ] **Step 1: Write failing transition tests**

```ts
import { expect, it } from "vitest";
import { transitionOrder } from "@/platform/commerce/domain/order";

it("never moves a paid order back to pending", () => {
  expect(() => transitionOrder("paid", "payment_pending")).toThrow("invalid order transition");
});

it("allows duplicate paid facts idempotently", () => {
  expect(transitionOrder("paid", "payment_succeeded")).toBe("paid");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun run test:unit -- tests/unit/commerce/order-state.test.ts tests/unit/commerce/payment-state.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement explicit transitions and normalized facts**

```ts
export type NormalizedProviderEvent =
  | { type: "one_time_payment_succeeded"; eventId: string; externalOrderId: string; externalPaymentId: string; amount: Money; occurredAt: Date }
  | { type: "one_time_payment_failed"; eventId: string; externalOrderId: string; externalPaymentId?: string; occurredAt: Date }
  | { type: "refund_succeeded"; eventId: string; externalPaymentId: string; amount: Money; occurredAt: Date }
  | { type: "refund_failed"; eventId: string; externalPaymentId: string; occurredAt: Date }
  | { type: "unsupported_signed_event"; eventId: string; providerType: string; occurredAt: Date };
```

```ts
export interface PaymentProvider {
  readonly name: "waffo";
  createOneTimeCheckout(input: { localOrderId: string; productId: string; currency: string; buyerIdentity: string; successUrl: string; cancelUrl: string }): Promise<{ externalCheckoutSessionId: string; externalOrderId?: string; checkoutUrl: string }>;
  getPayment(input: { externalOrderId?: string; externalPaymentId?: string }): Promise<NormalizedPaymentSnapshot | null>;
  verifyAndNormalizeWebhook(input: { rawBody: Uint8Array; signature: string; environment: "test" | "production" }): Promise<NormalizedProviderEvent>;
}
```

- [ ] **Step 4: Run tests and commit**

Run: `bun run test:unit -- tests/unit/commerce`

Expected: PASS.

```bash
git add src/platform/commerce/domain src/platform/commerce/application/payment-provider.ts src/platform/commerce/application/order-fulfillment.ts tests/unit/commerce
git commit -m "feat: define commerce states and provider contracts"
```

### Task 5: Implement Waffo client, webhook verifier and contract tests

**Files:**
- Modify: `package.json`
- Create: `src/platform/commerce/providers/waffo/client.ts`
- Create: `src/platform/commerce/providers/waffo/webhook.ts`
- Create: `src/platform/commerce/providers/waffo/adapter.ts`
- Create: `tests/contract/waffo/webhook.test.ts`
- Create: `tests/contract/waffo/checkout.test.ts`
- Create: `vitest.contract.config.ts`

**Interfaces:**
- Produces `createWaffoProvider(env): PaymentProvider`.

- [ ] **Step 1: Install exact SDK version**

Run: `bun add --exact @waffo/pancake-ts@latest`

Record the exact resolved version in `docs/providers/waffo-test-contract.md`.

- [ ] **Step 2: Write fixture-based signature and mapping tests**

```ts
import { createHmac } from "node:crypto";
import { expect, it } from "vitest";
import { verifyWaffoSignature } from "@/platform/commerce/providers/waffo/webhook";

it("accepts exact raw bytes and rejects any mutation", () => {
  const raw = Buffer.from('{"event":"order.completed","data":{"id":"event-1"}}');
  const secret = "test-secret";
  const signature = createHmac("sha256", secret).update(raw).digest("hex");
  expect(verifyWaffoSignature(raw, signature, secret)).toBe(true);
  expect(verifyWaffoSignature(Buffer.from(`${raw.toString()} `), signature, secret)).toBe(false);
});
```

Mapping tests load captured fixtures and assert exact normalized event, amount, currency, external IDs and timestamp. A valid unknown event maps to `unsupported_signed_event`.

- [ ] **Step 3: Run to verify failure**

Run: `bun run test:contract -- tests/contract/waffo`

Expected: FAIL.

- [ ] **Step 4: Implement timing-safe verification**

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyWaffoSignature(rawBody: Uint8Array, signature: string, secret: string): boolean {
  const expected = Buffer.from(createHmac("sha256", secret).update(rawBody).digest("hex"));
  const actual = Buffer.from(signature);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
```

Use the exact signature header/encoding captured in Task 1. If the dashboard contract differs from hex HMAC, update this code and fixture tests before implementation approval.

- [ ] **Step 5: Implement SDK client and adapter**

```ts
// src/platform/commerce/providers/waffo/client.ts
import "server-only";
import { WaffoPancake } from "@waffo/pancake-ts";

export function createWaffoClient(input: { merchantId: string; privateKey: string }) {
  return new WaffoPancake({ merchantId: input.merchantId, privateKey: input.privateKey });
}
```

The adapter performs the documented checkout-session then one-time-order flow, sends the captured test/prod environment mode, validates returned URLs use an approved Waffo origin, maps provider failures into stable error categories, and never exposes SDK types outside the provider directory.

- [ ] **Step 6: Run contract tests and commit**

Run: `bun run test:contract -- tests/contract/waffo`

Expected: PASS for sanitized fixtures; live test-mode tests remain opt-in behind `WAFFO_CONTRACT_LIVE=1`.

```bash
git add package.json bun.lock src/platform/commerce/providers/waffo tests/contract/waffo vitest.contract.config.ts docs/providers/waffo-test-contract.md
git commit -m "feat: add Waffo provider adapter and contract tests"
```

### Task 6: Implement authenticated checkout creation

**Files:**
- Create: `src/platform/commerce/application/create-checkout.ts`
- Create: `src/platform/commerce/infrastructure/order-repository.ts`
- Create: `src/app/api/commerce/checkout/route.ts`
- Create: `tests/integration/commerce/create-checkout.test.ts`
- Create: `tests/e2e/commerce.spec.ts`

**Interfaces:**
- Produces `createCheckout({ userId, productKey, requestKey }): Promise<{ orderId; checkoutUrl }>`.

- [ ] **Step 1: Write failing integration tests**

Tests assert:

- anonymous requests are rejected;
- disabled/unknown product keys are rejected;
- client amount/currency/provider ID fields are ignored/rejected;
- same `(userId, requestKey)` returns same local order and does not call provider twice;
- order snapshot records expected price/currency/product version before external call;
- provider failure leaves a retryable pending order without marking paid.

- [ ] **Step 2: Run to verify failure**

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" bun run test:integration -- tests/integration/commerce/create-checkout.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement checkout use case**

```ts
export type CreateCheckoutInput = { userId: string; productKey: string; requestKey: string };

export async function createCheckout(input: CreateCheckoutInput, deps: CheckoutDependencies) {
  const product = deps.catalog.getEnabled(input.productKey);
  if (product.commercialModel !== "one_time") throw new Error("product is not one-time");
  const order = await deps.orders.getOrCreatePending({
    userId: input.userId,
    requestKey: input.requestKey,
    product,
  });
  if (order.checkoutUrl) return { orderId: order.id, checkoutUrl: order.checkoutUrl };
  const external = await deps.provider.createOneTimeCheckout({
    localOrderId: order.id,
    productId: product.providerProductId,
    currency: product.currency,
    buyerIdentity: input.userId,
    successUrl: `${deps.appOrigin}/checkout/return?order=${order.id}`,
    cancelUrl: `${deps.appOrigin}/pricing`,
  });
  await deps.orders.attachCheckout(order.id, external);
  return { orderId: order.id, checkoutUrl: external.checkoutUrl };
}
```

The API route validates the authenticated user, accepts only `{ productKey, requestKey }`, and returns a 303 redirect or JSON URL according to reviewed UI behavior.

- [ ] **Step 4: Run tests and commit**

Run:

```bash
TEST_DATABASE_URL="$TEST_DATABASE_URL" bun run test:integration -- tests/integration/commerce/create-checkout.test.ts
bun run test:e2e -- tests/e2e/commerce.spec.ts
```

Expected: PASS with provider stub; browser reaches hosted checkout URL but no local payment is fulfilled.

```bash
git add src/platform/commerce/application/create-checkout.ts src/platform/commerce/infrastructure/order-repository.ts src/app/api/commerce/checkout tests/integration/commerce/create-checkout.test.ts tests/e2e/commerce.spec.ts
git commit -m "feat: create authenticated idempotent checkout"
```

### Task 7: Implement raw webhook ingestion and durable inbox

**Files:**
- Create: `src/app/api/webhooks/waffo/route.ts`
- Create: `src/platform/commerce/application/ingest-webhook.ts`
- Create: `src/platform/commerce/infrastructure/webhook-inbox-repository.ts`
- Create: `tests/integration/commerce/webhook-ingest.test.ts`
- Modify: `tests/e2e/commerce.spec.ts`

**Interfaces:**
- Produces `ingestWebhook({ rawBody, signature, environment }): Promise<{ accepted; duplicate; inboxId }>`.

- [ ] **Step 1: Write failing ingestion tests**

Tests cover invalid signature rejection/no trusted payload storage, environment/store mismatch, accepted valid event, duplicate accepted idempotently, valid unknown event persisted as unsupported, payload size limit, and response before heavy processing.

- [ ] **Step 2: Run to verify failure**

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" bun run test:integration -- tests/integration/commerce/webhook-ingest.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement route and ingestion**

```ts
export async function POST(request: Request): Promise<Response> {
  const raw = new Uint8Array(await request.arrayBuffer());
  const signature = request.headers.get("<captured-signature-header>");
  if (!signature) return new Response("missing signature", { status: 400 });
  const result = await ingestWebhook({ rawBody: raw, signature, environment: env.waffoEnvironment });
  return Response.json({ accepted: result.accepted }, { status: result.accepted ? 202 : 400 });
}
```

Replace the header placeholder with the actual header recorded in Task 1 before committing. The repository stores sanitized payload JSON/hash only after successful verification and unique insert.

- [ ] **Step 4: Run tests and commit**

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" bun run test:integration -- tests/integration/commerce/webhook-ingest.test.ts`

Expected: PASS.

```bash
git add src/app/api/webhooks/waffo src/platform/commerce/application/ingest-webhook.ts src/platform/commerce/infrastructure/webhook-inbox-repository.ts tests/integration/commerce/webhook-ingest.test.ts tests/e2e/commerce.spec.ts
git commit -m "feat: ingest signed Waffo events durably"
```

### Task 8: Process inbox events transactionally and create fulfillment jobs

**Files:**
- Create: `src/platform/commerce/application/process-provider-event.ts`
- Create: `src/platform/commerce/infrastructure/payment-repository.ts`
- Create: `src/platform/commerce/infrastructure/fulfillment-job-repository.ts`
- Create: `scripts/commerce-worker.ts`
- Create: `tests/integration/commerce/event-processing.test.ts`
- Create: `tests/integration/commerce/worker-leasing.test.ts`

**Interfaces:**
- Produces `processInboxEvent(inboxId): Promise<void>`.
- Produces `leaseCommerceWork(workerId, limit): Promise<LeasedWork[]>`.

- [ ] **Step 1: Write failing transaction/idempotency tests**

Tests assert concurrent duplicate processing produces one payment, one paid transition and one fulfillment job; transaction rollback leaves neither state transition nor outbox job; worker crash lease expires and is recoverable; unsupported event becomes terminal `unsupported` without data loss.

- [ ] **Step 2: Run to verify failure**

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" bun run test:integration -- tests/integration/commerce/event-processing.test.ts tests/integration/commerce/worker-leasing.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement transaction and leasing**

Inside one database transaction:

1. lock inbox row;
2. return if already terminal;
3. resolve local order by environment/external order ID;
4. validate amount, currency, product snapshot and merchant/store identity;
5. upsert payment by external payment ID;
6. apply idempotent order transition;
7. insert fulfillment job with key `order-paid:<orderId>:<externalPaymentId>`;
8. mark inbox processed.

Worker leasing uses `FOR UPDATE SKIP LOCKED`, a bounded lease, attempt counter, exponential retry and dead-letter after configured maximum.

- [ ] **Step 4: Run tests repeatedly and commit**

Run:

```bash
for i in 1 2 3; do TEST_DATABASE_URL="$TEST_DATABASE_URL" bun run test:integration -- tests/integration/commerce/event-processing.test.ts tests/integration/commerce/worker-leasing.test.ts || exit 1; done
```

Expected: all iterations PASS.

```bash
git add src/platform/commerce/application/process-provider-event.ts src/platform/commerce/infrastructure scripts/commerce-worker.ts tests/integration/commerce/event-processing.test.ts tests/integration/commerce/worker-leasing.test.ts
git commit -m "feat: process commerce events with durable outbox"
```

### Task 9: Add reconciliation and owner/operator inspection

**Files:**
- Create: `src/platform/commerce/application/reconcile-payment.ts`
- Create: `scripts/reconcile-commerce.ts`
- Create: `scripts/inspect-commerce.ts`
- Create: `src/app/(account)/account/billing/page.tsx`
- Create: `src/app/(account)/checkout/return/page.tsx`
- Create: `tests/integration/commerce/reconciliation.test.ts`
- Modify: `tests/e2e/commerce.spec.ts`

**Interfaces:**
- Produces `reconcilePayment({ actor, orderId }): Promise<ReconciliationResult>`.

- [ ] **Step 1: Write failing reconciliation tests**

Tests simulate a missed webhook, provider query showing success, and assert reconciliation uses the same normalized event/state-transition path to create exactly one payment/job. Amount/currency mismatch must produce an audited blocked result, not patch local data.

- [ ] **Step 2: Run to verify failure**

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" bun run test:integration -- tests/integration/commerce/reconciliation.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement reconciliation and read-only user pages**

Return page loads owner-scoped local order state and displays `processing`, `paid`, `canceled`, or stable support code. It never reads query parameters as payment facts. Billing page queries by authenticated user ID and excludes raw provider payloads/secrets.

Operator scripts require explicit environment and target IDs, print redacted normalized state, record actor `operator_script`, and require a confirmation flag for mutations/retries.

- [ ] **Step 4: Run tests and commit**

Run:

```bash
TEST_DATABASE_URL="$TEST_DATABASE_URL" bun run test:integration -- tests/integration/commerce/reconciliation.test.ts
bun run test:e2e -- tests/e2e/commerce.spec.ts
```

Expected: PASS.

```bash
git add src/platform/commerce/application/reconcile-payment.ts scripts/reconcile-commerce.ts scripts/inspect-commerce.ts src/app/'(account)'/account/billing src/app/'(account)'/checkout/return tests/integration/commerce/reconciliation.test.ts tests/e2e/commerce.spec.ts
git commit -m "feat: reconcile and inspect one-time commerce"
```

### Task 10: Complete live test-mode one-time flow and fault verification

**Files:**
- Create: `tests/contract/waffo/live-one-time.test.ts`
- Create: `tests/integration/commerce/fault-injection.test.ts`
- Create: `docs/runbooks/commerce-incidents.md`
- Create: `docs/setup/waffo.md`
- Modify: `scripts/verify-release.ts`

**Interfaces:**
- Produces opt-in live contract flow and operator recovery runbook.

- [ ] **Step 1: Add fault-injection tests**

Cover database unavailable after signature verification, worker crash after lease, crash after payment transition before response, duplicate/out-of-order events, provider timeout, malformed amount/currency, wrong environment/store, and dead-letter retry.

- [ ] **Step 2: Run fault tests**

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" bun run test:integration -- tests/integration/commerce/fault-injection.test.ts`

Expected: PASS; no duplicate payment/job and no false paid state.

- [ ] **Step 3: Run real Waffo test-mode checkout**

With `WAFFO_CONTRACT_LIVE=1`, create a checkout from the app, pay using an official success test card, receive the selected event, process it, and assert one local payment/fulfillment job. Repeat webhook delivery and assert counts remain one. Run a declined card and assert no paid transition.

- [ ] **Step 4: Add production verification**

Release script rejects live mode with test merchant/store/product IDs, test mode with production identifiers, missing webhook contract capture, missing selected events, unverified HTTPS endpoint, or disabled reconciliation/dead-letter visibility.

- [ ] **Step 5: Run full commerce gate**

```bash
bun run format:check
bun run lint
bun run typecheck
bun run test:unit
TEST_DATABASE_URL="$TEST_DATABASE_URL" bun run test:integration
bun run test:contract
bun run build
bun run test:e2e -- tests/e2e/commerce.spec.ts
bun run verify:release
```

Expected: all offline gates exit `0`; live contract test passes separately with test credentials.

- [ ] **Step 6: Commit**

```bash
git add tests/contract/waffo/live-one-time.test.ts tests/integration/commerce/fault-injection.test.ts docs/runbooks/commerce-incidents.md docs/setup/waffo.md scripts/verify-release.ts
git commit -m "test: verify Waffo one-time commerce reliability"
```

## Commerce/One-Time Exit Gate

Before requesting review, prove:

- current Waffo test contract/event/signature facts are captured without secrets;
- checkout accepts only authenticated user and local product key;
- local product/version/price/currency snapshot is authoritative;
- return page remains processing until verified event/reconciliation;
- invalid signatures and environment/store mismatches never transition commerce;
- valid unknown signed events are retained;
- duplicate events/payment IDs/request keys/fulfillment keys remain single under concurrency;
- event transition and fulfillment job creation are atomic;
- worker leases recover after crashes and persistent failures dead-letter visibly;
- reconciliation repairs missed webhook state through the same idempotent path;
- owner-scoped billing pages deny cross-user access;
- live Waffo test-mode success/decline and duplicate-delivery scenarios pass;
- no credits are granted yet.

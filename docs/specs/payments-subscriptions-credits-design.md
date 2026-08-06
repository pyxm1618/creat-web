# Payments, subscriptions, and credits design

- Status: proposed for independent review
- Initial payment provider: Waffo Pancake
- Supported commercial models: one-time purchase, subscription, and credits
- Multi-provider implementation: excluded from v1

## 1. Decision

`creat-web v1` supports all three required models:

1. one-time purchases;
2. recurring subscriptions;
3. internal credits.

These are not three equivalent payment systems.

- One-time purchases and subscriptions are commerce/payment models processed by Waffo.
- Credits are internal entitlements issued after an authoritative business event such as a paid order or successful subscription period.

The system therefore separates provider integration, commerce state, fulfillment, and credit accounting.

## 2. Design layers

```text
Waffo provider
    ↓ verified provider facts
Commerce domain
    ↓ durable fulfillment command
Fulfillment policy
    ↓ grant/revoke/use entitlement
Credit ledger or product entitlement
```

### 2.1 Provider layer

Responsibilities:

- create Waffo checkout sessions/orders;
- verify webhook signatures;
- query provider order/payment/subscription state;
- request supported cancellations/refunds;
- preserve raw provider identifiers and normalized payload metadata;
- translate provider facts into internal events.

It must not:

- grant credits directly;
- import product-domain code;
- decide whether a user may access a feature;
- treat a browser redirect as payment proof.

### 2.2 Commerce domain

Responsibilities:

- local product catalog mapping;
- orders and payment attempts;
- subscription state and paid periods;
- refunds;
- webhook inbox/outbox;
- idempotency;
- reconciliation;
- durable fulfillment requests;
- operator-visible failure/dead-letter state.

### 2.3 Fulfillment policy

Responsibilities:

- decide what a successful order/period grants;
- call the credit service or another product entitlement service;
- make fulfillment idempotent;
- reverse or adjust entitlements after refunds according to declared product policy.

### 2.4 Credit domain

Responsibilities:

- grants/lots;
- available balance;
- reservation;
- consumption/commit;
- release;
- expiry;
- revocation;
- administrative adjustment;
- immutable audit trail.

The credit domain does not call Waffo.

## 3. Provider strategy

V1 implements only `WaffoPaymentProvider`.

A small provider boundary is retained to prevent Waffo SDK types from leaking through commerce and product code. This is not a promise that another provider can be enabled by changing one configuration value.

Illustrative capability shape:

```ts
type PaymentCapabilities = {
  oneTime: true;
  subscriptions: true;
  refunds: true;
  partialRefunds: boolean;
  customerPortal: boolean;
  cancelAtPeriodEnd: boolean;
  resumeCancelingSubscription: boolean;
  inPlacePlanChange: boolean;
};
```

Capabilities are detected/declared by the implementation and verified against current provider documentation and test-account behavior.

Current Waffo documentation states that subscription product change is not implemented and returns `501`. V1 must not advertise in-place upgrade/downgrade until a staging contract test proves it is available. The initial product policy may require cancel-and-resubscribe for plan changes.

## 4. Local product catalog

The application owns a versioned local catalog that maps internal products to Waffo product IDs.

Minimum fields:

```ts
type ProductDefinition = {
  key: string;
  enabled: boolean;
  commercialModel: "one_time" | "subscription";
  currency: string;
  providerProductId: string;
  expectedPrice: string;
  billingPeriod?: "weekly" | "monthly" | "quarterly" | "yearly";
  fulfillment: FulfillmentDefinition;
  refundPolicy: RefundPolicyDefinition;
};
```

Rules:

- client-submitted amount, currency, product name, or credit quantity is never authoritative;
- checkout is created from a server-side product key;
- provider response and webhook values are checked against the local product/version captured by the order;
- price/product changes create a new product version rather than mutating historical order meaning;
- staging and production Waffo product IDs are separate configuration values;
- disabled products cannot create new checkout sessions but historical records remain valid.

## 5. Core data model

Exact column names may change during implementation, but the following concepts are mandatory.

### 5.1 `commerce_products`

Stores immutable/versioned local product definitions or snapshots required for historical interpretation.

Key properties:

- internal product key and version;
- commercial model;
- provider/product/environment mapping;
- price/currency snapshot;
- fulfillment-policy snapshot;
- active interval.

### 5.2 `orders`

Represents local purchase intent.

Key properties:

- internal order ID;
- user ID;
- product/version;
- environment;
- status;
- expected amount/currency;
- external checkout/session/order IDs;
- idempotency key;
- created/paid/canceled timestamps;
- provider metadata required for reconciliation.

### 5.3 `payments`

Tracks actual money movement and attempts.

Key properties:

- external payment ID uniqueness;
- order/subscription association;
- amount/currency;
- status;
- refund status/amount;
- provider timestamps;
- raw payload reference/hash;
- reconciliation timestamp.

### 5.4 `subscriptions`

Tracks the local projection of the provider subscription.

Key properties:

- user and product/version;
- external subscription/order ID;
- status;
- billing period;
- current period start/end;
- cancel-at-period-end/canceling state;
- trial state where enabled;
- last provider event/version/time;
- last reconciliation time.

### 5.5 `subscription_periods`

One record for each billable/fulfilled subscription period.

Key properties:

- external payment/period identifier;
- subscription ID;
- period start/end;
- payment outcome;
- fulfillment status;
- unique key preventing duplicate grants;
- refund association.

### 5.6 `refunds`

Tracks provider refund workflow independently from payment status.

Key properties:

- external refund/ticket ID;
- payment/order association;
- requested, approved, processing, succeeded, failed, or rejected state;
- full/partial amount;
- reason and operator notes with privacy limits;
- entitlement reversal state;
- timestamps.

### 5.7 `payment_webhook_inbox`

Stores every received webhook before business processing.

Key properties:

- provider event ID or stable deduplication hash;
- signature verification outcome;
- environment/store identity;
- event type;
- received timestamp;
- normalized/raw payload with retention/redaction policy;
- processing state, attempts, lease, error category;
- unique idempotency constraint.

Invalid signatures are rejected and minimally logged; valid unknown events are durably stored and marked unsupported rather than discarded.

### 5.8 `payment_outbox` / `fulfillment_jobs`

Stores durable work created transactionally with accepted commerce transitions.

Key properties:

- event/aggregate ID;
- operation type;
- unique idempotency key;
- pending/leased/succeeded/retry/dead-letter state;
- attempt count and next-attempt time;
- bounded error details;
- lease owner/expiry.

Workers must use safe leasing and recovery, such as PostgreSQL row locking with `SKIP LOCKED` or an equivalent verified approach.

## 6. Commerce state machines

### 6.1 One-time order

```text
pending -> paid
pending -> canceled
paid -> partially_refunded
paid -> refunded
partially_refunded -> refunded
```

A paid order never returns to pending. Refund is represented explicitly rather than erasing payment history.

### 6.2 Payment

Provider-facing normalized states:

```text
pending | succeeded | failed | canceled
```

Refund state is tracked independently:

```text
none | pending | partially_refunded | refunded | failed
```

### 6.3 Subscription

Waffo’s documented lifecycle must be represented without collapsing meaningful states:

```text
pending
trialing
active
past_due
canceling
canceled
expired
closed
```

Required interpretations:

- `past_due` is a recovery/grace state, not immediate cancellation;
- `canceling` remains entitled through the paid period;
- `canceled` stops future renewal after the current period policy is exhausted;
- `closed` means the subscription never activated due to timeout/failure;
- out-of-order events must not blindly move state backward;
- provider reconciliation can repair local projections.

## 7. Authoritative payment rule

The following are never authoritative proof of payment:

- success URL query parameters;
- the browser returning from checkout;
- a client-side API call saying checkout completed;
- an email receipt forwarded by a user;
- an unverified webhook payload.

Fulfillment occurs only after:

1. a signed, environment/store-validated webhook is accepted; or
2. a trusted server-side provider query confirms the state during reconciliation.

The user-facing return page may show “processing” until local fulfillment completes.

## 8. Webhook processing

### 8.1 Request path

1. Read raw body using the provider-required format.
2. Verify signature before trusting fields.
3. Validate environment, store/merchant identity, schema, currency/amount format, and event identity.
4. Insert inbox record idempotently.
5. Return quickly according to provider expectations.
6. Process asynchronously/durably.
7. Apply local transition and create outbox/fulfillment work in one database transaction.
8. Retry transient failures with bounded exponential backoff.
9. Dead-letter persistent failures and expose an operator recovery action.

### 8.2 Event mapping

Waffo documentation warns that current webhook event names may change and directs developers to the dashboard. Therefore implementation must capture the actual test/live event catalog before coding the final mapper.

Requirements:

- event names are not invented from memory;
- fixtures are recorded from test mode or official schemas;
- unknown signed events are stored;
- mapping includes schema version or fixture date;
- contract tests fail loudly when required fields disappear;
- raw payload retention is minimized/redacted but sufficient for dispute and debugging needs.

### 8.3 Idempotency

At least the following unique identities must prevent duplicates:

- provider event ID/deduplication key;
- external payment ID;
- local checkout idempotency key;
- fulfillment source key;
- subscription period/payment grant key;
- refund reversal key.

Retries must produce the same result, not a second credit grant.

## 9. Reconciliation

Webhook delivery alone is insufficient for financial correctness.

The system requires:

- scheduled reconciliation for recent pending/failed/leased records;
- manual operator reconciliation by order/subscription/payment ID;
- provider query for ambiguous state;
- comparison of amount, currency, product, environment, and user/buyer identity;
- repair through the same idempotent domain operations used by webhooks;
- audit trail for automatic and manual repairs.

Reconciliation must not directly patch balances or statuses without domain validation.

## 10. Subscription fulfillment

### 10.1 Activation

A subscription is considered activated only after authoritative provider confirmation. If the product grants credits at activation, the grant key must be unique to the subscription’s first successful paid/trial policy event.

### 10.2 Renewal

Each successful paid period creates at most one `subscription_period` and one fulfillment source. Duplicate renewal events or reconciliations must resolve to the existing record.

### 10.3 `past_due`

Default policy:

- do not issue new period credits without successful payment;
- retain access through a declared grace/paid-period rule;
- show billing recovery state;
- allow provider portal/payment-method update if supported;
- do not permanently cancel from one failed event.

Access policy and credit issuance policy are separate decisions.

### 10.4 Canceling/canceled

- cancellation is at period end where Waffo requires it;
- `canceling` users retain paid access until period end;
- no future period grant occurs after cancellation takes effect;
- a documented restore/resume action before period end may return the subscription to active;
- cancellation must not erase prior paid periods or consumed credits.

### 10.5 Upgrade/downgrade

Because current Waffo documentation marks the change-product endpoint as unimplemented, v1 does not promise in-place plan changes.

Initial options:

- use provider customer portal only after verified support; or
- cancel at period end and start a new subscription; or
- defer plan-change UI entirely.

Proration logic must not be invented locally without provider support and explicit product policy.

## 11. Credit ledger model

### 11.1 Invariants

1. Every credit change has an immutable ledger entry.
2. Available balance cannot be changed by direct update.
3. A grant records its source: order, subscription period, compensation, promotion, or admin adjustment.
4. A grant may have an expiry date and remaining amount.
5. Reservation and consumption are transactional.
6. The same source cannot grant twice.
7. Release cannot exceed the reservation.
8. Revocation is linked to the originating grant/source.
9. Historical consumption is not deleted.
10. User-visible balance and audit-derived balance must reconcile.

### 11.2 Required records

#### `credit_grants`

A lot/batch of credits with:

- user;
- source type and source ID;
- quantity;
- remaining/revocable quantity derived safely;
- granted and expiry timestamps;
- state;
- idempotency key;
- product/credit type where multiple balances exist.

#### `credit_ledger_entries`

Immutable entries such as:

```text
grant
reserve
release
consume
expire
revoke
adjust_positive
adjust_negative
```

Each entry contains source, correlation, quantity, actor/system origin, and timestamp.

#### `credit_reservations`

Tracks work that may succeed or fail:

- reservation ID;
- user and amount;
- purpose/correlation ID;
- status (`active`, `committed`, `released`, `expired`);
- created/expiry timestamps;
- unique purpose key.

### 11.3 Allocation policy

Credits are allocated from eligible grants using a deterministic policy, normally earliest-expiring first and then oldest grant. Reservations must preserve their allocation so commit/release is exact.

### 11.4 Consumption flow

```text
begin transaction
  lock relevant user/grants
  verify available balance
  allocate units
  create reservation and ledger entries
commit

perform product work

success -> transactionally commit reservation
failure/timeout -> transactionally release reservation
```

Long-running product work must not hold a database transaction open.

### 11.5 Expiry

Expiry is a durable job that:

- identifies expired unreserved units;
- creates expiry ledger entries idempotently;
- never expires already consumed units;
- handles active reservations according to declared reservation timeout policy;
- is safe to rerun.

## 12. Refund and entitlement reversal

### 12.1 General rule

Refund state and credit state are related but not identical. A financial refund must trigger an idempotent entitlement-adjustment workflow.

### 12.2 One-time credit purchase refund

- revoke unused credits originating from the refunded order;
- do not delete consumption history;
- account balance should not become silently negative;
- if some originating credits were already consumed, record the unrecovered consumed quantity;
- product refund policy may forbid voluntary refund after use, but mandatory corrections/refunds still require explicit handling;
- do not revoke unrelated grants from other purchases merely to force mathematical recovery unless the policy explicitly requires it and is reviewed.

### 12.3 Subscription period refund

- associate the refund with the relevant subscription payment/period;
- revoke unused credits granted by that period;
- stop no unrelated periods;
- update access only according to subscription/refund policy;
- record consumed amount that cannot be technically reversed.

### 12.4 Partial refunds

Automatic credit reversal is allowed only when the product defines an unambiguous conversion from refunded amount to entitlement quantity. Otherwise:

- record the partial refund;
- pause automatic entitlement adjustment;
- require an explicit operator decision or product-specific policy;
- never guess a proportional quantity from floating-point arithmetic.

Money values must use decimal/minor-unit safe representations; never JavaScript binary floating point for financial comparison.

## 13. Buyer/user identity

Checkout should use a stable authenticated buyer identity when available, particularly for trials and subscription linkage. The system must still verify that provider events map to the expected local user/order.

Rules:

- do not trust email alone when a stable external/local identity exists;
- store provider customer/buyer identifiers;
- prevent an event for one environment/store from fulfilling another;
- define whether anonymous checkout is allowed; v1 default should require authentication for credit or subscription products;
- callback metadata must be allowlisted and not used as the sole source of ownership.

## 14. Security and privacy

- private keys and webhook secrets remain server-only;
- webhook signature verification uses raw body as required;
- full card data is never received or stored by creat-web;
- logs exclude private keys, signatures, full billing details, checkout URLs containing secrets, and unnecessary payload fields;
- database access to financial records is restricted;
- operator actions are audited;
- refund/support notes have retention and sensitive-data limits;
- webhook/reconciliation endpoints are rate-limited or authenticated as appropriate;
- test and live environments are impossible to mix silently.

## 15. Operational controls

Required operator capabilities may initially be scripts or protected internal routes, not a full admin dashboard:

- search order/payment/subscription by internal and external IDs;
- view normalized state and recent provider events;
- retry a dead-letter fulfillment;
- run reconciliation;
- inspect credit source/allocation history;
- cancel/resume subscription where supported;
- record refund resolution;
- disable a product;
- export a bounded audit trail for support.

Every operator mutation requires authorization, fresh session, validation, and audit logging.

## 16. Test matrix

### 16.1 Domain unit tests

- all order/payment/subscription state transitions;
- invalid/backward/out-of-order transitions;
- fulfillment idempotency;
- product/configuration validation;
- refund policy decisions;
- credit allocation, expiry, reserve/commit/release/revoke;
- money parsing and currency validation.

### 16.2 PostgreSQL integration tests

- migrations from empty database;
- unique event/payment/period/fulfillment keys;
- concurrent duplicate webhooks;
- concurrent credit reservations;
- worker leasing and lease recovery;
- transaction rollback between commerce transition and outbox creation;
- retry/dead-letter behavior;
- ledger balance reconciliation;
- refund revocation limited to originating grants;
- scheduled expiry idempotency.

### 16.3 Waffo contract tests

Using official/test-mode fixtures:

- checkout creation for one-time and subscription products;
- signature verification success/failure;
- environment/store mismatch;
- amount and currency formatting;
- paid one-time event;
- subscription activation/renewal/past-due/canceling/canceled/restored events available in the actual account;
- refund lifecycle;
- unknown signed event retention;
- provider API reconciliation;
- current unsupported plan-change behavior.

### 16.4 E2E tests

- authenticated user starts checkout;
- return page remains processing before webhook;
- successful webhook grants exactly once;
- duplicate webhook does not duplicate credits;
- product job reserves and consumes credit only on success;
- failed product job releases reservation;
- subscription renewal grants one period entitlement;
- cancellation retains current-period access and stops future grants;
- refund revokes only unused originating credits;
- user cannot access another user’s order/subscription/credit history.

### 16.5 Fault injection

- database unavailable after webhook verification;
- worker crash after lease;
- crash after domain transition but before external response;
- provider timeout during reconciliation;
- repeated out-of-order events;
- malformed amount/currency;
- email/user metadata mismatch;
- expired checkout/session;
- dead-letter manual retry.

## 17. Acceptance criteria

Commerce is production-ready only when:

- one-time and subscription test-mode purchases complete end to end;
- browser redirects never cause fulfillment;
- duplicate and out-of-order events are safe;
- every subscription paid period fulfills at most once;
- `past_due`, `canceling`, cancellation, and restoration follow explicit policies;
- credit reservations are concurrency-safe;
- refund and entitlement reversal are auditable;
- reconciliation repairs missed webhooks through idempotent operations;
- dead-letter records are visible and retryable;
- test/live products, stores, keys, and events are isolated;
- no provider capability is advertised without a passing staging contract test.

## 18. References

- https://docs.waffo.ai/zh/
- https://docs.waffo.ai/zh/features/orders-payments
- https://docs.waffo.ai/zh/features/subscriptions
- https://docs.waffo.ai/zh/features/refunds
- https://docs.waffo.ai/zh/features/test-mode
- https://docs.waffo.ai/zh/features/integrations
- https://docs.waffo.ai/zh/mor/what-is-mor

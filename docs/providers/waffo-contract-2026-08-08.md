# Waffo Pancake provider contract — 2026-08-08

Status: **SDK contract captured; live merchant resource validation still required before deployed commerce is enabled.**

## Package

- Package: `@waffo/pancake-ts`
- Version: `0.16.0` (exactly pinned)
- Product: Waffo Pancake Merchant of Record SDK
- Default API base URL: `https://api.waffo.ai`
- Merchant requests use RSA-SHA256 signing and merchant identity headers through the SDK.

## Checkout contract

The starter uses authenticated checkout:

```ts
client.checkout.authenticated.create({
  productId,
  currency,
  buyerIdentity,
  buyerEmail,
  successUrl,
  orderMerchantExternalId,
})
```

The local retained `account_subjects.id` is the stable `buyerIdentity`. The local order UUID is sent as `orderMerchantExternalId`, providing a merchant-controlled reconciliation key that later appears on order/payment/refund facts and webhooks.

The SDK returns a checkout `sessionId`, `checkoutUrl`, expiry/session token information. It does not provide the final Waffo order ID at checkout creation time; the final Waffo order ID is bound when a verified provider event arrives.

The browser never supplies authoritative amount, currency, Waffo product ID or entitlement. The server product catalog chooses those values. Provider checkout does not itself prove payment success.

## Money contract

Waffo amounts are decimal display strings, not integer minor units. Examples from the SDK documentation include USD `"29.00"` and JPY `"4500"`.

The starter converts provider display strings to BIGINT minor units using an explicit reviewed currency exponent registry. Unsupported currencies and precision mismatches fail closed. The original provider display value may be preserved only where needed for diagnostics; financial equality is evaluated in minor units plus currency.

## Payment query contract

The pinned SDK documentation exposes merchant GraphQL payment queries, `paymentsCount` with the same filter as the corresponding list, payment `snapshotAmountDetails`, `createdAt`, and mutually exclusive `onetimeOrder` / `subscriptionOrder` relations. It explicitly documents `OnetimeOrder.testMode`; the subscription payment query documentation does not establish a payment-level subscription period.

The application query is bounded to 100 rows and requests:

```graphql
query ($reference: String!, $paymentId: String!) {
  payments(
    limit: 100
    filter: {
      orderMerchantExternalId: { eq: $reference }
      id: { eq: $paymentId }
    }
  ) {
    id
    orderId
    status
    orderMerchantExternalId
    snapshotAmountDetails { currency total }
    onetimeOrder { id testMode store { id } }
    subscriptionOrder { id store { id } }
    createdAt
  }
  paymentsCount(
    filter: {
      orderMerchantExternalId: { eq: $reference }
      id: { eq: $paymentId }
    }
  )
}
```

Either lookup identity may be omitted, but when both are provided both remain in the list and count filters and both are validated against every returned payment. The adapter also requires:

- list length equals `paymentsCount`, count does not exceed 100, and payment IDs are unique;
- `orderMerchantExternalId` matches the local order reference when supplied;
- exactly one provider-order relation, whose `id` equals `payment.orderId` and whose `store.id` equals the configured store;
- one-time `testMode` maps exactly to local `test` / `production`;
- supported payment status, uppercase supported currency, exact decimal precision, and a strict UTC provider `createdAt`;
- any GraphQL `errors`, including partial data plus errors, fail closed.

Every lookup creates a request-scoped SDK client whose custom fetch receives a combined caller abort signal and a bounded timeout. Provider warnings are not discarded: only `message`, `layer`, and optional `aiHint` leave the adapter so the reconciliation worker can persist an allowlisted audit record.

These tests validate code against the checked-in SDK 0.16.0 documentation and a controlled wire fixture. They do **not** prove the authenticated live merchant schema or resources.

## Missed-webhook recovery boundary

Automatic recovery is restricted to unambiguous one-time payment facts. Subscription payment facts discovered through GraphQL must be quarantined for operator review with reason `payment-level period unavailable` and must produce no payment row, subscription period, fulfillment job, or Credits grant.

`subscriptionOrder.currentPeriodStart` and `subscriptionOrder.currentPeriodEnd` are current order-projection fields, not proven historical payment-period fields. They must never be copied onto a recovered subscription payment. Subscription recovery can be reconsidered only after the live schema or retained historical event proves authoritative payment-level period bounds.

Therefore this implementation may be code-safe while owner activation remains **NO-GO**.

## Webhook contract

Signature header: `x-waffo-signature`.

Verification is performed over the exact raw request body using `client.webhooks.verify(...)`. Environment values at the SDK boundary are `test` and `prod`; the application maps them to internal `test` and `production`.

Verified event envelope fields include:

- `id`: webhook delivery identifier used for deduplication
- `timestamp`
- `eventType`
- `eventId`
- `storeId`
- `storeName`
- `mode`
- `data`

Relevant event types exposed by SDK 0.16.0:

- `order.completed`
- `subscription.activated`
- `subscription.payment_succeeded`
- `subscription.canceling`
- `subscription.uncanceled`
- `subscription.updated`
- `subscription.canceled`
- `subscription.past_due`
- `refund.succeeded`
- `refund.failed`

Relevant data fields include `orderId`, `orderMerchantExternalId`, `paymentId`, `paymentStatus`, `currency`, `amount`, subscription period fields, and refund fields.

The verified-webhook path handles one-time, refund, and typed subscription events. Subscription activation/payment mutation requires period bounds from that signed event itself. This is separate from GraphQL missed-webhook reconciliation: query results cannot substitute current order-period fields for missing payment-level history.

## Retention contract

- Invalid-signature payloads: never retain raw body; retain only bounded diagnostics such as hash/size.
- Known valid events: retain normalized allowlisted facts by default.
- Valid but unsupported signed events: encrypted raw body may be retained for a bounded exceptional window, with key ID, expiry and purge timestamp.
- Raw payloads must not be logged.

## Live-resource gate

The repository currently has no connected Waffo account/tool that can prove merchant-owned resources. Before `staging` or `production` commerce can be enabled, the operator must validate with its own Waffo resources:

1. Merchant ID and RSA request signing work.
2. Store ID belongs to that merchant and matches webhook deliveries.
3. Test and production product IDs map to the intended immutable product versions/currencies.
4. Test webhook public key verifies an actual Waffo delivery; production key is configured separately.
5. `orderMerchantExternalId` round-trips as the local order UUID.
6. `order.completed` exposes the expected order/payment/amount/currency facts.
7. Refund and, when enabled, subscription event shapes match the captured SDK contract.
8. Replay of the same delivery is deduplicated.

## Mandatory live payment-query activation gate

This gate is additional to the eight live-resource checks above. The operator must complete and retain evidence for all of the following against authenticated Waffo Test merchant resources:

1. Run authenticated merchant GraphQL introspection and confirm the payment filter and selected relation fields exist with the expected scalar/object shapes.
2. Execute test queries proving merchant reference and payment ID use `String!` variables, including a request that supplies both identities.
3. Confirm the payment list and `paymentsCount` use an identical list/count filter, the list has an explicit limit, and bounded list and count completeness holds without truncation, mismatch, or duplicate IDs.
4. Inspect a real payment and confirm its one-time relation, `testMode`, store, amount, currency, and `createdAt` map exactly to the local Test order.
5. Capture a representative one-time payment snapshot and reconcile it against the local order reference, provider order/payment IDs, product model, amount, currency, store, environment, and provider-created time.
6. Do not enable subscription recovery until the live schema or retained historical event proves a payment-level immutable subscription period for that exact payment. Until then, subscription automatic recovery remains **NO-GO**.

`WAFFO_CONTRACT_VERIFIED=1` must not be set until both the original live-resource checklist and this payment-query gate pass. The runtime rejects deployed commerce when the flag is not set, but the flag itself is not evidence that either checklist was completed.

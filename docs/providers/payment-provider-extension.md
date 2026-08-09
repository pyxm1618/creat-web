# Payment provider extension contract

## Goal

A future provider such as Stripe must be added as an adapter, not as a second commerce architecture. Orders, payments, subscriptions, refunds, entitlements, credits, durable jobs, and reconciliation remain provider-neutral local domains.

## Stable boundary

Implement `PaymentProvider` from `src/platform/commerce/application/payment-provider.ts`.

The adapter owns only provider-facing concerns:

- provider authentication/client construction;
- checkout creation;
- provider customer-session or equivalent authorization;
- subscription cancel/resume commands;
- refund submission;
- payment lookup/reconciliation facts;
- signature verification;
- provider payload to `NormalizedProviderEvent` mapping.

The adapter must expose its capabilities explicitly. Application/domain code must not branch on provider-specific class names or event payloads.

## Local authority model

Provider adapters do **not** own:

- product pricing authority;
- local order IDs;
- retained account subjects;
- subscription grace policy;
- refund cumulative-cap enforcement;
- entitlement/credit reversal policy;
- durable retry/dead-letter semantics;
- operator reconciliation history.

Those remain inside local configuration/domain/application/database layers.

## Checkout

`createCheckout` receives a server-owned product snapshot. Do not accept price/amount authority from a browser.

Return only stable provider identifiers and an HTTPS checkout URL. Do not persist arbitrary provider checkout payloads in the domain.

## Webhooks

An adapter must:

1. verify the exact raw request body and provider signature before trusting payload fields;
2. verify environment/account/store identity where the provider supports it;
3. normalize provider event IDs and timestamps;
4. map only verified fields needed by the local domain;
5. return `unsupported_signed_event` for a valid event the local domain intentionally ignores;
6. never make the browser or webhook delivery order the source of truth for local idempotency.

The webhook inbox stores minimized normalized data plus hashes/retention metadata; it is not a permanent raw provider JSON archive.

## Subscriptions

Map provider subscription semantics into the existing local normalized events/status projection. Provider-specific states may require an explicit mapping table, but do not add provider states directly to domain code unless they represent a genuinely provider-independent lifecycle state.

Local billing cadence (`month` / `year`) comes from the immutable product snapshot, not from parsing a provider webhook opportunistically.

The local past-due grace deadline is a product policy. A provider adapter must not extend or recompute it.

## Refunds

`requestRefund` submits an already-authorized local refund request. The local application layer has already serialized the payment and enforced the captured/refunded/open-request ceiling.

Map a provider refund/ticket ID to `externalRefundReference`. A provider “request accepted” response is not automatically equivalent to a settled financial refund unless the provider contract explicitly guarantees that state; use signed events or reconciliation as required.

Partial refund support is a provider capability, but entitlement reversal policy remains local/product-specific.

## Reconciliation

Implement `getPayment` (and future provider-neutral reconciliation methods only when domain needs prove them necessary) using provider APIs. Return normalized facts rather than provider objects.

When the provider cannot supply enough unambiguous facts, fail closed and surface operator reconciliation rather than inventing a state.

## Adding Stripe later

A `StripeAdapter` should implement the same boundary and map Stripe checkout/payment/subscription/refund events into the existing normalized event set. It must not create parallel `stripe_orders`, `stripe_subscriptions`, or Stripe-specific entitlement logic merely for convenience.

Provider IDs belong in adapter/config/projection fields designed for external identifiers; Stripe SDK types must not leak into the domain or shared application interfaces.

## Required tests for any new provider

Before enabling a provider:

- adapter contract tests against the exact pinned SDK/API version;
- signature-verification regression tests using exact raw bodies;
- environment/account identity mismatch rejection;
- server-owned price/amount assertions;
- checkout URL validation;
- webhook normalization tests for every supported event;
- duplicate event idempotency through the common application path;
- refund/subscription command idempotency;
- provider feature OFF build/runtime test proving no provider secret or SDK initialization is required;
- build matrix, integration, security, and release gates.

Pin critical provider dependencies exactly. Do not perform an opportunistic global dependency upgrade while adding a provider.

# Commerce, subscription, and refund recovery runbook

## Scope

This runbook covers durable payment webhook ingestion, provider-event application, fulfillment, subscription commands, refunds, entitlement reversal, and reconciliation. Financial/provider state must never be repaired by trusting the browser or by deleting failed rows.

The account-deletion and credit-ledger subsystems retain their own domain rules; this runbook calls out their interaction points where they affect commerce records.

## Core invariants

- Browser price, checkout return parameters, and client state are never payment authority.
- A signed provider event is normalized before domain application; provider raw bodies are minimized and retained only under the bounded encrypted retention policy.
- `commerce_applied_events` makes provider-event application idempotent by environment + provider event ID.
- Orders/payments/subscriptions/refunds are updated in database transactions with row locking where competing events could violate money/state invariants.
- Provider command jobs, webhook inbox jobs, and fulfillment jobs use leases. A `processing` row is reclaimable only after its lease expires.
- Retries use bounded exponential backoff. Reaching the attempt limit creates a dead-letter/operator-visible state; it is never treated as success.
- Captured amount is the upper bound for cumulative successful plus in-flight refund requests.
- `past_due_started_at`, `past_due_grace_ends_at`, and `grace_policy_version` are fixed when a subscription first enters the current past-due episode. Duplicate/repeated past-due events must not extend grace.
- Financial success and entitlement success are separate facts. If entitlement reversal cannot be automated safely, record reconciliation instead of silently declaring the system consistent.

## Scheduled worker

`GET /api/cron/commerce` requires the cron bearer secret and is `no-store`.

The commerce cron performs durable work against persisted queues/projections. It may process:

1. verified webhook inbox rows;
2. order/subscription fulfillment jobs;
3. durable subscription cancel/resume commands;
4. durable refund provider commands;
5. bounded raw-webhook retention purge.

Workers must be safe to run concurrently. Row locks, leases, unique idempotency keys, and `skip locked` claims provide the serialization boundary.

## Webhook inbox states

`payment_webhook_inbox.state`:

- `pending`: verified event waiting to be applied;
- `processing`: claimed by a live worker until its lease expires;
- `retry`: prior attempt failed and `next_attempt_at` controls retry time;
- `completed`: normalized event has been applied or safely classified;
- `dead_letter`: automatic retries are exhausted; investigate.

When investigating a dead-letter event, use the normalized event, payload hash, event ID, environment, timestamps, and error code first. Do not expose or log decrypted sensitive raw bodies as a general debugging mechanism.

An invalid-signature webhook must not persist an encrypted/raw sensitive body.

## Fulfillment job states

`fulfillment_jobs` is the durable boundary between confirmed financial facts and product entitlements/credits.

- `pending`: due for processing;
- `processing`: lease held by a worker;
- `completed`: the idempotent fulfillment handler completed;
- `dead_letter`: automatic retries exhausted.

Before resetting a dead-letter fulfillment job, verify whether the downstream entitlement operation already occurred. Fulfillment handlers must have their own stable operation/idempotency key so retrying cannot duplicate grants or delivery.

For credit-backed products, use the credit runbook and immutable credit ledger rather than editing balances.

## Subscription lifecycle

The local projection supports:

```text
pending
active
past_due
canceling
canceled
expired
closed
```

Activation and successful renewal establish/update the current paid period and clear the current past-due episode. A renewal payment produces an idempotent `subscription_period` record and fulfillment job keyed by the provider payment.

### Past due

On first entry into `past_due` for an episode:

- persist `past_due_started_at`;
- calculate and persist `past_due_grace_ends_at` once;
- persist `grace_policy_version`.

If a later past-due webhook arrives while those fields are already present, keep the original values. Never use “now + grace” on every retry/event.

A change in future grace policy must use a new policy version and must not retroactively extend an already-fixed deadline unless the operator performs an explicit reviewed correction.

### Cancel and resume

Customer cancel/resume requests create `commerce_command_jobs`; the API does not require the provider call to complete inline.

A repeated client request with the same idempotency key must return/reuse the original command even if the projected subscription state changed in the meantime.

Provider success is reflected by provider response/webhook facts. Do not mutate a subscription to a desired terminal state merely because the user clicked a button.

## Commerce command jobs

`commerce_command_jobs.state`:

- `pending`
- `processing`
- `completed`
- `dead_letter`

Commands:

- `subscription_cancel`
- `subscription_resume`
- `refund_request`

On failure, clear the lease, increment attempts, and schedule the next exponential retry. At the maximum attempt count, retain the job as `dead_letter`.

A dead-letter refund command also moves the refund into operator reconciliation because provider execution is unresolved.

## Refund workflow

### Request admission

Refund requests must:

- belong to the authenticated retained account subject;
- target a succeeded payment;
- use the same currency as the payment;
- have a positive amount and stable idempotency key;
- serialize against the payment row;
- satisfy `captured >= already_refunded + open_requested + new_request`.

Idempotent retry checks happen before re-reserving the refundable balance so a repeated request cannot block itself.

### Provider event application

A successful signed refund webhook:

1. locks the payment/order;
2. rejects cumulative refund above capture;
3. advances payment/order refund projection;
4. matches the local refund request when possible;
5. either schedules a safe entitlement reversal or records reconciliation.

An ambiguous webhook is not guessed. Create an operator reconciliation record.

### Full refund entitlement reversal

A full refund schedules `reverse:<fulfillmentKey>`.

For credit fulfillment, only unused credits from the originating payment/subscription period may be revoked. Already consumed or actively reserved credits make full automatic reversal impossible; the refund is moved to `reconciliation_required` with the blocked condition recorded.

### Partial refunds

The platform does not invent a universal “refund 30%, revoke 30% of entitlement” rule. Unless the product has an explicit reviewed partial-reversal policy, a successful partial refund becomes financially succeeded but entitlement reconciliation remains operator-required.

## Reconciliation

`commerce_reconciliation_runs` is append-only operational evidence of a comparison/correction decision. Use it for at least:

- unmatched or ambiguous refund provider events;
- entitlement reversal blocked by already-consumed/reserved rights;
- provider command exhaustion where the final external state is unknown;
- manual provider-vs-local state comparisons.

For an incident, record:

1. target type and stable target ID;
2. actor (`worker`, `webhook`, or operator process);
3. before facts;
4. provider/authoritative facts used to decide;
5. after/desired projection;
6. explicit result such as `operator_review_required`.

Never delete a reconciliation row to make dashboards green.

## Account deletion interaction

Financial, subscription, refund, and credit records reference the retained account subject rather than an ephemeral authentication user identity. Account deletion must revoke/delete authentication access while preserving legally/operationally required financial records under the documented retention model.

Never reattach retained commerce history to a newly created authentication identity merely because an email address matches.

## Incident checklist

When a commerce incident is reported:

1. identify environment and retained subject/order/payment/subscription/refund IDs;
2. inspect the relevant provider event ID and `commerce_applied_events` entry;
3. inspect inbox/command/fulfillment state, attempts, lease expiration, `next_attempt_at`, and last error code;
4. determine whether the external provider action actually occurred before resetting any command;
5. compare captured/refunded totals and local refund reservations;
6. inspect entitlement/credit reversal state;
7. create/retain a reconciliation record for unresolved divergence;
8. repair through an idempotent compensating operation, not direct destructive history edits;
9. rerun the relevant verifier/integration tests after a code fix.

## Release checks

Before enabling commerce/subscriptions for a project:

- `features.commerce.enabled` and only the required subfeatures are enabled;
- Waffo contract/resources have been verified for the target environment;
- every enabled product has an exact provider product mapping and immutable local price snapshot;
- subscription products declare `billingInterval: "month" | "year"`;
- fulfillment and reversal handlers exist for every enabled product;
- refund/legal policy facts match the enabled commercial model;
- the commerce cron is deployed and authenticated;
- migrations pass empty-to-latest and main-chain-to-latest verification;
- unit, PostgreSQL integration, provider-contract, security, commerce, subscription, credits, release, and E2E gates pass;
- dead-letter and reconciliation queues are understood by the operator before production traffic is accepted.

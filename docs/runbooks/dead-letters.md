# Dead-letter operations

Dead-letter records are durable failures that exhausted automatic retry. Do not edit queue or business tables manually.

## Inspect

Use the redacted read-only tool with the target environment and the environment's database credential:

```bash
APP_ENV=staging DATABASE_URL="$DATABASE_URL" \
  bun scripts/inspect-dead-letters.ts --environment=staging
```

The output is limited to queue name, internal record ID, attempt count, bounded error code and creation time. It intentionally excludes payloads, email addresses, subject IDs, order/payment identifiers and provider payloads.

## Decide whether retry is safe

Before retrying, confirm all of the following:

1. The underlying dependency or configuration problem is resolved.
2. The queue item is still `dead_letter`; completed or already-requeued items must not be touched.
3. Re-execution is protected by the queue's idempotency key/domain invariant.
4. The operator has recorded a concrete reason that another operator can audit later.
5. The selected `--environment` matches `APP_ENV` and the database credential belongs to that environment.

For production, use short-lived operator/database credentials from the approved access path. Do not copy production credentials into shell history, tickets or chat.

## Retry

Queues are `webhook`, `fulfillment`, `commerce_command`, `credit_finalization`, and `account_deletion`.

```bash
APP_ENV=staging DATABASE_URL="$DATABASE_URL" \
  bun scripts/retry-dead-letter.ts \
  --environment=staging \
  --queue=fulfillment \
  --id=<dead-letter-id> \
  --reason="Provider incident resolved and idempotency checked" \
  --confirm=RETRY:<dead-letter-id>
```

The script delegates to the dead-letter domain operation. That operation only transitions an item from its exact dead-letter state back to the queue's retryable state, clears leases/error state, and writes an immutable `dead_letter_retried` audit event in the same transaction. It does not patch order, payment, credit, subscription, account, or fulfillment business outcomes directly.

## After retry

Inspect again, then verify the corresponding scheduled worker and operational alerts. A retry that returns to dead-letter requires a new diagnosis; do not repeatedly force requeue. For a payment/refund mismatch or an uncertain external side effect, use reconciliation/operator review instead of retrying blindly.

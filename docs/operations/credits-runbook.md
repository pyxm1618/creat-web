# Credit ledger operations runbook

## Scope

This runbook covers the reusable credit ledger, reservations, expiry, paid-order grants, post-delivery finalization and reconciliation. It does not authorize manual balance edits. There is no mutable balance column.

## Normal invariants

- Every grant has exactly one `grant` ledger entry equal to the grant quantity.
- Available balance is derived from grants minus terminal reductions and active reservations.
- Reservations allocate exact grant IDs and quantities and never hold a database transaction open while product work runs.
- Commit/release uses the original allocation; it never reallocates at terminal time.
- A delivered result whose credit commit failed remains delivered. `credit_finalization_jobs` retries only the commit and never reruns the product work.
- Refund/source reversal only touches unused units from the originating grant. Consumed/reserved units are reported as blocked; unrelated grants are never debited.

## Scheduled maintenance

`GET /api/cron/credits` is authenticated with the platform cron bearer secret. It runs, in order:

1. expired reservation release;
2. durable credit finalization;
3. expired grant processing;
4. ledger reconciliation.

The response reports counts only and is `no-store`.

## Investigating a mismatch

Run the credit reconciliation against the affected environment before changing data. Treat these issue codes as operator-visible incidents:

- `RESERVATION_ALLOCATION_MISMATCH`
- `STALE_ACTIVE_RESERVATION`
- `GRANT_LEDGER_MISMATCH`
- `GRANT_OVERDRAWN`
- `EXPIRED_GRANT_WITHOUT_EXPIRY_ENTRY`
- `CROSS_SUBJECT_ALLOCATION`
- `CROSS_CREDIT_TYPE_ALLOCATION`
- `TERMINAL_RESERVATION_WITHOUT_LEDGER`

Do not repair by editing a balance. Preserve the immutable history and use an explicit reviewed adjustment or compensating workflow after determining the cause.

## Finalization backlog

For `credit_finalization_jobs`:

- `pending`: safe to retry when due;
- `processing`: reclaim only after its lease expires;
- `completed`: no action;
- `dead_letter`: investigate before any retry/reset.

A finalization job proves delivery was already persisted. Never rerun the underlying user work from this queue.

## Refund reversal

Full reversal may revoke only currently unused units from grants linked to that provider-confirmed source. If units were consumed or remain reserved, record/report the blocked amount for policy handling. Partial reversals are blocked unless the project has an explicit reviewed conversion policy.

## Release checks

Before enabling credits for a project:

- commerce is enabled;
- every enabled credit product has an explicit credit fulfillment definition;
- every fulfillment key maps to a real handler;
- quantities are positive integers;
- the credit cron is deployed;
- PostgreSQL integration tests and `verify:credits` pass;
- reconciliation reports zero unexplained issues on the target environment.

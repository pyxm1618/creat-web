# Production Readiness Remediation Design

## Context

The release-candidate audit of `f1a8298` found concrete production failure paths in authentication, account deletion, commerce event durability, refunds, subscription periods, credits, and worker lease handling. This remediation closes those paths without reopening the completed Commerce/Credits architecture refactor or introducing a new framework.

The work remains on `feat/seo-performance-i18n-platform-completion` and updates the existing open Draft PR #7. The final PR must remain Draft until repository verification and owner-side provider activation are complete.

## Goals

- Remove public authentication routes that bypass the platform security boundaries.
- Make commerce-enabled account deletion durable, idempotent, and safe for active subscriptions.
- Make every normalized provider event losslessly serializable through the webhook inbox.
- Bind refund events to the correct payment and preserve exactly-once financial and entitlement effects.
- Preserve subscription-period and credit-lifecycle invariants across renewal and refund sequences.
- Fence worker completion by the active lease owner.
- Add database-level append-only protection and durable reconciliation visibility for credits.
- Add regression tests that reproduce every fixed failure path.
- Keep existing bounded-context direction and use the current composition roots and verification system.

## Non-goals

- Replacing Better Auth, Waffo, Drizzle, the queue tables, or the Credits ledger.
- Adding an IoC container, general queue framework, repository interfaces everywhere, or unrelated refactors.
- Claiming live Waffo, email, Turnstile, DNS, monitoring, or deployment activation without owner credentials and external evidence.
- Making PR #7 ready for review automatically. It remains Draft as requested.

## Authentication Boundary

The Better Auth catch-all remains the adapter for allowed framework endpoints, but the platform route rejects direct public access to native account deletion and native Magic Link sending. Internal Better Auth API calls used by the account-deletion worker and the custom Magic Link route are unaffected because they do not traverse the public catch-all.

The unused Bearer plugin is removed so a leaked session token cannot be promoted into an additional authentication channel. Security-page forms submit a session identifier rather than a raw session token; the server reloads the current user's sessions, resolves the identifier to its token, and then invokes revocation.

Refund, subscription-cancel, and subscription-resume routes use the same 15-minute fresh-session boundary as account deletion. Origin, content type, authentication, ownership, and fresh-session failures remain explicit client errors rather than uncaught server errors.

## Commerce-enabled Account Deletion

The account-deletion coordinator becomes a Commerce integration adapter rather than a feature-flag stub. For a deleting subject it:

1. loads all non-terminal subscriptions with their provider order identities;
2. creates deterministic cancellation commands keyed by the deletion request and subscription;
3. executes or reuses those commands through the existing command path;
4. succeeds only after each provider cancellation has been accepted into a local terminal or canceling state;
5. leaves financial, refund, subscription-period, and credit audit rows attached to the non-auth account subject;
6. allows the existing deletion service to detach and delete the authentication identity only after preparation succeeds.

Retries use the same operation keys and therefore cannot create duplicate cancellation effects. Provider uncertainty leaves the deletion request retryable instead of deleting the identity and allowing an unmanaged active subscription. The release verifier rejects a commerce-enabled build if this coordinator is not wired.

## Provider Event Durability

A single versioned codec owns serialization and parsing for the complete `NormalizedProviderEvent` union. Every `Money.minor` value is stored as a decimal string, every timestamp as ISO 8601, and every optional provider identity is preserved. Parsing validates the full shape and reconstructs `bigint` and `Date` values. An exhaustive `never` check prevents a new event variant from silently falling through.

Webhook ingestion verifies the raw body before normalization, then serializes only the trusted normalized event. The worker parses only records created by this codec. Round-trip tests cover one-time payment, all subscription variants, and refund success/failure, including `externalRefundReference`.

Invalid-signature diagnostics are bounded: different invalid payloads arriving in the same environment/time bucket collapse to one diagnostic record, and rejected rows have an explicit short retention cleanup path. No unverified payload body is retained.

## Refund and Subscription Correctness

Refund processing validates that an external refund reference belongs to the payment selected by the signed event. A mismatch records a reconciliation incident and performs no payment, order, period, credit, or fulfillment mutation.

The browser owns one stable idempotency key per logical refund/cancel/resume intent. A transport failure or lost response reuses that key; a materially different refund input creates a new intent key.

Refund capacity includes every unresolved refund state, including reconciliation-required operations. Stale pending and processing refunds move to an operator-visible reconciliation state without releasing reserved refund capacity. A provider-originated refund that has no local request creates a deterministic durable refund record before any projection or entitlement mutation. A cumulatively full refund enqueues the existing source-bounded reversal exactly once.

For subscription products, a full refund marks the matched subscription period as refunded but does not poison the long-lived order aggregate. A later valid renewal can therefore move through the normal paid-period path. One-time orders retain their existing paid/partially-refunded/refunded projection semantics.

Where the pinned Waffo SDK exposes a queryable provider identity, stale local payment/refund state is reconciled through that identity. A provider fact that cannot be queried through the pinned contract remains an explicit owner-side activation assumption and is not reported as repository verification.

## Credits Integrity

Subscription credit grants derive their expiration base from the matched subscription period, not the original order payment date. One-time grants continue to use the order payment time.

The ledger receives a PostgreSQL trigger that rejects application `UPDATE` and `DELETE` operations. Reconciliation tests that need corrupt fixtures temporarily disable the trigger only in isolated test databases; production application code has no bypass.

Credit reconciliation issues are persisted in a dedicated incident table with a stable issue identity, first/last detection timestamps, occurrence count, and open/resolved state. Repeated scans update the existing open incident instead of producing an unbounded duplicate stream. Operational snapshots and health alerts include unresolved incident counts.

`executeCreditBackedWork` requires database-backed delivery persistence to participate in the same transaction that creates the durable finalization obligation. External/non-transactional delivery must use an outbox adapter and is outside the generic helper contract. A process crash can therefore leave either neither record or both the delivery and its finalization obligation, never a delivered result without a recovery path.

## Worker Leases and Fairness

Webhook, command, and fulfillment worker acknowledgements and failures update rows only when row id, `processing` state, and lease owner all match. A stale worker that lost its lease cannot mark a reclaimed job complete, dead-letter it, or apply failure-side projections.

The aggregate Commerce worker reserves bounded capacity for inbox, command, and fulfillment queues. Unused capacity may spill to another queue, but a continuously full inbox cannot permanently starve commands and fulfillment.

## Architecture and Release Guards

The existing ESLint architecture verifier is extended so any current or future Commerce application, domain, or provider module importing a Credits concrete implementation fails verification. Commerce runtime/composition files remain the assembly point, and Credits integration adapters may depend on the Commerce port.

Secret scanning includes production source, scripts, migrations, workflows, tests, and documentation while retaining the existing false-positive controls. Provider documentation and PR verification statistics are updated from fresh command output. `bun audit` remains fail-closed; a registry HTTP failure is reported as an environment failure, not converted into a pass.

## Test Strategy

Each production change follows red-green-refactor:

- public native delete-user and Magic Link requests are rejected while internal calls still work;
- commerce account deletion retries provider cancellation and cannot duplicate it;
- all normalized events survive JSON serialization, database storage, parsing, and worker execution;
- cross-payment refund references, duplicate/out-of-order refunds, unknown provider refunds, and stale unresolved refunds preserve money and credit invariants;
- refunding one subscription period does not block a later renewal;
- renewal grants use the renewal period for expiration;
- stale lease owners cannot acknowledge or fail reclaimed work;
- concurrent credit operations preserve conservation and the append-only trigger blocks mutation;
- reconciliation findings persist and surface in operational health;
- queue capacity remains available to all three Commerce queues under sustained backlog;
- architecture, release, and security verifiers fail on the newly prohibited configurations.

Targeted tests run immediately after each failing regression test is added and again after implementation. Final verification runs format check, lint, typecheck, unit, integration, contract, migration verification, architecture, security, subscription, Commerce, Credits, credit races, build matrix, production build, full verify, and supply-chain audit. Any unavailable external check is labeled environment-blocked with its exact output.

## Delivery

After all checks, the complete diff is reviewed for unrelated changes and migration safety. Intended files are staged explicitly, committed on the existing feature branch, pushed to `origin`, and used to update Draft PR #7. The PR body lists root causes, fixes, migrations, red-green regression coverage, fresh verification results, and remaining owner/deployment activation work.

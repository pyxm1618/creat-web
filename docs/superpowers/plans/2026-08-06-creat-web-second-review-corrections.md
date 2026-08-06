# creat-web Second Review Execution Corrections

> **For all implementation agents:** Read this document after `2026-08-06-creat-web-gemini-review-corrections.md` and before any phase plan. It is binding and supersedes conflicting webhook-retention and credit-expiry examples in earlier plans.

**Status:** implementation remains blocked pending independent review of the corrected plan suite and owner approval.

## 1. Commerce plan corrections: webhook data lifecycle

### 1.1 Required files

Add to the commerce phase:

```text
src/platform/commerce/domain/webhook-retention.ts
src/platform/commerce/application/sanitize-provider-event.ts
src/platform/commerce/application/purge-webhook-payloads.ts
src/platform/commerce/infrastructure/webhook-payload-crypto.ts
scripts/purge-webhook-payloads.ts
tests/unit/commerce/webhook-sanitization.test.ts
tests/integration/commerce/webhook-retention.test.ts
tests/integration/commerce/webhook-purge-concurrency.test.ts
tests/integration/commerce/webhook-log-redaction.test.ts
```

Modify:

```text
src/platform/database/commerce-schema.ts
src/platform/commerce/application/process-provider-event.ts
src/app/api/webhooks/waffo/route.ts
src/platform/observability/redact.ts
.env.example
docs/runbooks/data-retention.md
```

### 1.2 Schema correction

`payment_webhook_inbox` uses:

```text
normalized_payload_json JSONB NOT NULL
payload_hash TEXT NOT NULL
payload_size_bytes INTEGER NOT NULL
raw_payload_ciphertext BYTEA NULL
raw_payload_key_id TEXT NULL
raw_payload_expires_at TIMESTAMPTZ NULL
raw_payload_purged_at TIMESTAMPTZ NULL
retention_class TEXT NOT NULL
legal_hold_review_at TIMESTAMPTZ NULL
```

Constraints/checks:

- ciphertext/key/expiry must be all-null for `retention_class = none`;
- ciphertext/key/expiry must be present for short-lived encrypted classes;
- invalid-signature records cannot contain ciphertext or normalized provider facts;
- payload size is bounded before parsing/storage;
- retention class is an explicit enum/check constraint;
- indexes support `raw_payload_expires_at` purge batches and legal-hold review queries.

### 1.3 TDD task: sanitization and persistence policy

Write failing tests proving:

```ts
const raw = {
  event_id: "evt_test",
  buyer: { email: "person@example.com", name: "Real Name", ip: "203.0.113.5" },
  order_id: "ord_test",
  amount: "29.00",
  currency: "USD",
  signature: "secret",
};

expect(sanitizeKnownPaymentEvent(raw)).toEqual({
  eventId: "evt_test",
  orderId: "ord_test",
  amountDisplay: "29.00",
  currency: "USD",
});
```

Also assert the serialized normalized object contains none of:

```text
person@example.com
Real Name
203.0.113.5
secret
```

Run:

```bash
bun run test:unit -- tests/unit/commerce/webhook-sanitization.test.ts
```

Expected before implementation: FAIL for missing sanitizer/policy.

Implementation contract:

```ts
export type WebhookRetentionClass =
  | "none"
  | "short_debug"
  | "unresolved_event"
  | "legal_hold";

export type WebhookPersistenceDecision = {
  normalized: Record<string, unknown>;
  retentionClass: WebhookRetentionClass;
  retainEncryptedRawUntil: Date | null;
};

export function decideWebhookPersistence(input: {
  signatureValid: boolean;
  normalizedEventKnown: boolean;
  processingOutcome: "success" | "transient_failure" | "unresolved";
  receivedAt: Date;
}): WebhookPersistenceDecision;
```

Defaults:

- successful known event: no raw retention;
- transient failure: encrypted raw for at most 7 days;
- valid unresolved event: encrypted raw for at most 30 days;
- invalid signature: no raw retention.

### 1.4 TDD task: encryption and purge

`WebhookPayloadCrypto` interface:

```ts
export interface WebhookPayloadCrypto {
  encrypt(rawBody: Uint8Array): Promise<{ ciphertext: Uint8Array; keyId: string }>;
  decrypt(input: { ciphertext: Uint8Array; keyId: string }): Promise<Uint8Array>;
}
```

Production implementation must use a purpose-specific authenticated-encryption key path. Tests use a deterministic test implementation but must still detect plaintext persistence.

`purgeWebhookPayloads` interface:

```ts
export async function purgeWebhookPayloads(input: {
  now: Date;
  batchSize: number;
  workerId: string;
}): Promise<{ leased: number; purged: number; skippedLegalHold: number }>;
```

PostgreSQL tests must prove:

- expired ciphertext becomes NULL while digest/normalized facts remain;
- repeated purge is idempotent;
- two workers using `FOR UPDATE SKIP LOCKED` or an equivalent proven lease do not purge the same record twice;
- active legal hold is skipped and reported;
- known successful events never stored ciphertext in the first place;
- exceptions/logs remain redacted.

Required commands:

```bash
TEST_DATABASE_URL="$TEST_DATABASE_URL" bun run test:integration -- \
  tests/integration/commerce/webhook-retention.test.ts \
  tests/integration/commerce/webhook-purge-concurrency.test.ts \
  tests/integration/commerce/webhook-log-redaction.test.ts
```

### 1.5 Operations integration

Add a bounded authenticated internal job or operator script for purge. Its schedule is chosen only after actual traffic/retention policy is known. `verify:release` rejects:

- plaintext raw-payload columns;
- missing retention expiry for encrypted non-hold rows;
- overdue raw payloads;
- enabled commerce without documented retention classes and purge procedure.

## 2. Credit plan corrections: reservation/expiry serialization

### 2.1 Required files/tests

Add or modify:

```text
src/platform/credits/infrastructure/credit-lock.ts
src/platform/credits/application/expire-credits.ts
src/platform/credits/application/expire-reservations.ts
src/platform/credits/application/commit-reservation.ts
src/platform/credits/application/release-reservation.ts
tests/integration/credits/expiry-reservation-race.test.ts
tests/integration/credits/expiry-boundary.test.ts
tests/integration/credits/credit-invariant.test.ts
```

### 2.2 Shared serialization API

```ts
export async function withCreditMutationLock<T>(input: {
  tx: CreditTransaction;
  subjectId: string;
  creditType: string;
  run: () => Promise<T>;
}): Promise<T>;
```

The implementation uses one reviewed lock-key derivation or an equivalent row-lock strategy for **all** of:

- reserve;
- commit;
- release;
- stale-reservation expiry;
- grant expiry;
- source revocation.

Lock order after the shared scope:

```text
grants ordered by id
reservations ordered by id
reservation allocations ordered by (reservation_id, grant_id)
```

### 2.3 Quantity invariant implementation

Repository queries calculate per grant:

```ts
export type GrantQuantityProjection = {
  quantity: number;
  consumed: number;
  revoked: number;
  expired: number;
  activeReserved: number;
  available: number;
};
```

Required assertion:

```ts
quantity === consumed + revoked + expired + activeReserved + available
```

The invariant is checked inside each mutation transaction and by reconciliation. Application code must not persist a mutable balance shortcut.

### 2.4 Exact expiry semantics

`expireDueCredits`:

1. obtains the same subject/credit-type mutation lock;
2. locks due grants and active allocations;
3. computes `expirableNow = available` inside the transaction;
4. writes one idempotent expiry entry per grant for exactly that amount;
5. does not alter active allocations;
6. marks a grant fully expired only when no active-reserved units remain and all quantity is consumed/revoked/expired.

Commit after grant expiry remains valid when the reservation was created before expiry and is still active.

Release/stale-expire after grant expiry:

- terminally release the reservation allocation;
- in the same transaction write expiry entries for the newly unreserved already-expired units, or create one uniquely keyed immediate expiry job transactionally;
- never expose those units as available between release and expiry.

### 2.5 Required concurrent tests

Use fake/controlled clock inputs, not wall-clock sleeps.

```text
A. reserve before grant expiry; expiry worker runs; commit after expiry -> one consume, no expire for reserved units
B. reserve before expiry; expiry worker runs; release after expiry -> release plus immediate expire, zero available
C. commit and expiry transactions race -> invariant preserved for either legal serialization order
D. release and expiry race -> no double ledger entries and no spendable intermediate balance
E. reserve at exact expiry timestamp -> rejected
F. stale-reservation and grant-expiry workers race -> exact terminal result, no duplicate release/expire
G. two expiry workers race -> safe batch leasing
H. replay every operation -> idempotent
```

Run each race suite repeatedly:

```bash
for i in $(seq 1 30); do
  TEST_DATABASE_URL="$TEST_DATABASE_URL" bun run test:integration -- \
    tests/integration/credits/expiry-reservation-race.test.ts \
    tests/integration/credits/expiry-boundary.test.ts \
    tests/integration/credits/credit-invariant.test.ts || exit 1
done
```

## 3. Exit-gate additions

Commerce cannot exit until:

- successful known webhooks retain no raw payload;
- encrypted exceptional payloads have bounded expiry and pass purge tests;
- normalized payloads are allowlisted and PII fixtures are absent;
- purge backlog/oldest-record observability exists.

Credit cannot exit until:

- expiry/reservation race tests pass repeatedly against real PostgreSQL;
- commit after grant expiry works for a valid protected reservation;
- release after grant expiry cannot restore spendable balance;
- quantity reconciliation reports zero invariant mismatches.

## 4. Commit boundaries

These corrections belong in their owning phases:

- webhook lifecycle changes in Commerce/Waffo PR;
- credit serialization changes in Credit Ledger PR.

Do not create a separate late privacy or concurrency cleanup PR after unsafe schemas have already merged.

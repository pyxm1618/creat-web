# creat-web v1 Second Independent Review Resolution

- Date: 2026-08-06
- Status: binding design correction
- Applies after: `creat-web-v1-auth-critical-clarifications.md`
- Implementation status: blocked pending corrected-plan review and owner approval

## 1. Precedence and review scope

This document is the highest-precedence design correction. It supersedes conflicting statements in all earlier specifications and review resolutions.

The second review inspected only the five original `docs/specs/*.md` documents and therefore repeated Findings 1–7 without applying:

- `creat-web-v1-gemini-review-resolution.md`;
- `creat-web-v1-auth-critical-clarifications.md`;
- the Superpowers execution corrections.

Findings 1–7 are already resolved by those binding documents and are not reopened by this report.

The genuinely new review items are:

| Finding | Decision | Final severity |
|---|---|---|
| Raw webhook payload retention and PII | Accepted with stricter minimization, encryption and purge lifecycle | IMPORTANT |
| Credit expiry racing active reservations | Core invariant already present; accepted as concurrency hardening | IMPORTANT control, not a new architectural defect |

Quick I Ching remains read-only.

## 2. Webhook payload minimization and retention

### 2.1 Design decision

The raw HTTP request body is required transiently for provider signature verification. That requirement does not justify indefinite plaintext storage of the full provider payload.

The normal persistence model is:

1. read the exact raw bytes into bounded request memory;
2. verify the signature before trusting any field;
3. parse and normalize only after verification;
4. persist allowlisted normalized business facts needed for idempotency, state transition, reconciliation and audit;
5. persist a cryptographic payload digest and schema/fixture metadata;
6. discard the raw plaintext unless a documented short-lived debugging/replay purpose requires encrypted retention.

### 2.2 Required inbox fields

`payment_webhook_inbox` must separate normalized facts from an optional encrypted diagnostic envelope:

```text
id
provider
environment
provider_event_id nullable
dedup_hash
event_type
signature_status
payload_hash
payload_size_bytes
schema_version nullable
normalized_payload_json
raw_payload_ciphertext nullable
raw_payload_key_id nullable
raw_payload_expires_at nullable
raw_payload_purged_at nullable
retention_class: none | short_debug | unresolved_event | legal_hold
processing_state
attempts / lease / bounded error fields
received_at / processed_at
```

Rules:

- `normalized_payload_json` is an explicit allowlist, never a shallow copy of the provider body;
- email, full name, phone, postal address, IP address, billing details, checkout secrets, signatures and unnecessary provider metadata are excluded unless one field is demonstrably required for a specific lawful operational purpose;
- invalid-signature requests do not persist the body; retain only bounded security metadata such as digest, byte size, timestamp and coarse failure category;
- full raw payload is never stored plaintext;
- encrypted raw retention uses a purpose-specific key and restricted operator access;
- logs and error trackers never receive the raw body or encrypted body contents;
- no payment or credit state transition depends on a raw payload after normalized facts are committed.

### 2.3 Retention classes

Default policy:

```text
known successfully processed event:
  raw retention = none
  normalized event/audit facts = according to commerce/accounting schedule

transient processing failure where replay diagnostics are needed:
  encrypted raw retention <= 7 days

valid signed unknown event or unresolved provider-contract failure:
  encrypted raw retention <= 30 days

invalid signature:
  raw retention = none

legal/dispute hold:
  explicit case-linked override, restricted access, documented expiry/review date
```

The 7- and 30-day values are starter defaults, not universal legal conclusions. Each product records the operational/legal basis and may choose a shorter period. Any extension requires a reviewed policy and must remain purpose-limited.

### 2.4 Purge workflow

A durable `purgeWebhookPayloads(now, batchSize)` operation:

1. selects expired encrypted envelopes using safe leasing/locking;
2. sets ciphertext and key identifier to `NULL`;
3. records `raw_payload_purged_at` and a non-sensitive purge audit entry;
4. preserves event ID, digest, normalized facts and processing history;
5. is idempotent and safe to rerun;
6. skips active legal holds but reports overdue hold reviews;
7. exposes backlog/oldest-unpurged metrics and alerts.

Account deletion must not depend on parsing old raw payloads. Subject linkage and retained financial facts live in normalized tables. If a payload was retained under a valid hold, deletion processing records the restriction and prevents use outside that purpose.

### 2.5 Required tests

- known successful webhook persists no raw plaintext/ciphertext;
- allowlisted normalized JSON contains no fixture email, name, IP, address, signature or checkout secret;
- invalid signature persists no body;
- unresolved signed event stores encrypted bytes with an expiry and cannot be read without the diagnostic key path;
- purge removes ciphertext while preserving digest, event identity and normalized state;
- purge is idempotent and concurrency-safe;
- legal hold prevents purge only until its explicit review/expiry policy permits action;
- account deletion leaves no unnecessary webhook PII and does not destroy required normalized financial records;
- logs and exception reports contain neither raw nor decrypted payloads.

## 3. Credit expiry and active-reservation concurrency

### 3.1 Existing invariant retained

The original design already requires expiry to identify only expired **unreserved** units and to handle active reservations according to reservation timeout policy. The Credit execution plan also requires that active reservation units are not double-expired.

This review therefore does not reveal a missing high-level rule. It does identify a need to make database locking and boundary semantics explicit.

### 3.2 Binding quantity invariant

For each grant at any transaction boundary:

```text
quantity = consumed + revoked + expired + active_reserved + available
```

All terms are non-negative integers. No operation may make their sum exceed `quantity`.

At grant expiry time:

```text
expirable_now = available
```

Active reserved units are not available and therefore cannot be expired.

### 3.3 Locking and operation order

Reserve, commit, release, stale-reservation expiry, grant expiry and source revocation use the same serialization scope:

1. acquire the per-subject/per-credit-type transaction advisory lock, or an equivalently proven serialization lock;
2. lock affected grants in stable grant-ID order;
3. lock affected reservations and allocation rows in stable reservation/grant order;
4. recompute invariant quantities inside the transaction;
5. write immutable ledger entries and terminal states atomically.

No expiry worker may update grant state using an unlocked aggregate calculated before the transaction.

### 3.4 Boundary semantics

- A reservation created before the grant expiry instant protects its exact allocations until that reservation is committed, explicitly released or becomes stale.
- A valid active reservation may be committed after the underlying grant's `expires_at`; the right to consume was fixed at reservation time.
- New reservations cannot allocate from a grant at or after its expiry instant.
- Expiry immediately expires only currently available units.
- When a stale reservation is released after its grant has expired, the same transaction, or an idempotently chained job, expires the newly released units rather than returning them to available balance.
- Manual release after grant expiry follows the same rule unless a reviewed compensation policy explicitly creates a new grant.
- Commit, release and expiry never recalculate or replace the original reservation allocations.
- Worker retries and duplicate boundary events create no duplicate `expire`, `release` or `consume` entries.

### 3.5 Required PostgreSQL tests

Use a controllable database/application clock and real concurrent transactions:

1. reserve at `11:59`, expire grant at `12:00`, commit at `12:01`: commit succeeds exactly once;
2. reserve at `11:59`, expire grant at `12:00`, release at `12:01`: released units become expired, not available;
3. expiry and commit start concurrently: one serialization order occurs, invariant remains correct;
4. expiry and release start concurrently: no double expiry/release and no temporary spendable balance;
5. reservation request at the exact expiry boundary cannot use the grant;
6. stale-reservation worker and grant-expiry worker run concurrently without double ledger entries;
7. two expiry workers lease the same batch safely;
8. repeated expiry runs are idempotent;
9. reconciliation recomputes the quantity invariant and reports any mismatch without direct balance patching.

## 4. Code-start status

Application code remains blocked because:

- this new binding correction must be reflected in the execution plan;
- the independent reviewer has still not reviewed the corrected design stack and Superpowers plan suite in the authoritative reading order;
- owner approval applies only after that corrected-plan verdict.

The Waffo contract gate remains phase-specific and does not block unrelated Foundation/Auth/SEO work after the general code-start gate is eventually satisfied.

## 5. References

- European Commission, GDPR storage limitation and data minimisation guidance: https://commission.europa.eu/law/law-topic/data-protection/rules-business-and-organisations/principles-gdpr/
- PostgreSQL explicit locking: https://www.postgresql.org/docs/current/explicit-locking.html
- PostgreSQL transaction isolation: https://www.postgresql.org/docs/current/transaction-iso.html

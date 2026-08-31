# Webhook data retention and purge runbook

## Scope

This runbook governs `payment_webhook_inbox` raw-payload retention. Normalized provider facts are the operational record. Raw webhook bodies are exceptional evidence and are never the default persistence format.

## Retention classes

- `normalized_only`: known, successfully normalized events retain no raw ciphertext.
- `transient_encrypted`: a valid signed event may retain encrypted raw bytes for short-lived operational recovery, with a mandatory expiry.
- `unresolved_encrypted`: a valid but unresolved event may retain encrypted raw bytes for bounded investigation, with a mandatory expiry.
- legal hold is represented by `legal_hold_review_at` on an otherwise encrypted retained row. It is not permission for indefinite unattended retention.

Invalid-signature requests must not retain raw ciphertext or normalized provider facts derived from an untrusted body.

## Data minimization

Known event normalization is allowlist-based. Do not persist buyer email, buyer name, IP address, authorization values, signatures, session/auth tokens, payment-card data, or arbitrary provider payload fields in normalized JSON.

Structured logs must pass through the repository redaction boundary. Do not log decrypted raw webhook bodies.

## Encryption

Exceptional raw payloads use the commerce-retention key path configured by `COMMERCE_RETENTION_KEY` and `COMMERCE_RETENTION_KEY_ID`. The ciphertext, key identifier, and expiry are stored together. Plaintext raw payload columns are prohibited.

Key rotation follows `docs/runbooks/key-rotation.md`. Rotating a key must not silently make still-retained ciphertext undecryptable; keep the old key available only for its remaining retention window or re-encrypt under an explicitly reviewed migration procedure.

## Purge procedure

The authenticated internal reconciliation job invokes bounded raw-payload purge. Purge selection uses row locking with `SKIP LOCKED`, so multiple workers may run safely without claiming the same row.

For an expired row without an active legal hold, purge atomically clears:

- `raw_payload_ciphertext`;
- `raw_payload_key_id`;
- `raw_payload_expires_at`;

and records `raw_payload_purged_at`. Normalized allowlisted facts and the payload hash remain for idempotency/audit purposes.

Repeated purge is idempotent. Do not restore a purged body from logs, backups, or another analytics system merely for convenience.

## Legal hold handling

A row with an active `legal_hold_review_at` is skipped by the automated purge. Operators must review holds at the recorded review date and either:

1. remove/resolve the hold so normal expiry can proceed; or
2. document the lawful/contractual reason and a new bounded review date.

A legal hold must never be created just to avoid investigating a purge failure.

## Observability and alerts

Operational telemetry exposes only aggregate values:

- retained raw-payload backlog;
- age in seconds of the oldest retained raw payload;
- invalid-signature volume;
- worker/job backlog and age;
- dead-letter/provider-failure counts.

No webhook body, buyer identity, order/payment identifier, email, token, signature, or card data belongs in these metric/alert payloads.

The reconciliation job emits `webhook_retained_payloads` and `oldest_webhook_payload_age_seconds`. `webhook_retention_backlog_stale` is raised when configured backlog/age thresholds are reached.

## Incident response

If retained-payload backlog or oldest age breaches threshold:

1. confirm the internal reconciliation schedule is running and authenticated;
2. inspect aggregate metrics and job/error codes before accessing any retained ciphertext;
3. verify whether legal holds explain the skipped rows;
4. run the bounded purge job again only after identifying the failure mode;
5. confirm ciphertext count decreases and `raw_payload_purged_at` is populated;
6. investigate database/provider failures without copying raw payloads into tickets or chat;
7. rotate the retention key only through the documented key-rotation procedure if compromise is suspected.

## Release evidence

Commerce cannot be considered release-ready until CI proves:

- successful known webhooks store no raw payload;
- exceptional retained payloads are encrypted and have bounded expiry;
- two purge workers do not purge the same row twice;
- purge replay is idempotent;
- active legal holds are skipped;
- structured logging removes sensitive webhook data;
- backlog and oldest-retained-payload observability are present;
- this procedure and key-rotation procedure are versioned in the repository.

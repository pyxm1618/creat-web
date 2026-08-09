# Database backup and restore

Use this procedure only with an isolated restore target. Never restore over the only copy of a production database and never commit a dump.

## Preconditions

- Confirm source environment, database owner and approved retention/PITR policy.
- Use short-lived database credentials where available.
- Ensure the restore target is isolated from production workers, webhooks, cron jobs and email/payment providers.
- Record source commit, migration count, backup timestamp and responsible operator.

## Logical backup

```bash
pg_dump "$DATABASE_URL" \
  --format=custom \
  --no-owner \
  --no-acl \
  --file=creat-web.dump
```

Protect the dump as production data. Encrypt it at rest and delete the temporary copy after the drill according to the approved retention policy.

## Restore into an isolated database

```bash
createdb creat_web_restore_test
export RESTORED_DATABASE_URL='postgres://.../creat_web_restore_test'
pg_restore \
  --dbname="$RESTORED_DATABASE_URL" \
  --no-owner \
  --no-acl \
  creat-web.dump
RESTORED_DATABASE_URL="$RESTORED_DATABASE_URL" bun scripts/verify-restored-database.ts
```

The verifier checks migration history, Better Auth/core relations, payment/subscription/credit constraints, duplicate idempotency keys, credit-ledger reconciliation and synthetic owner-scoped reads. A failed verifier blocks release and recovery sign-off.

## Managed-provider/PITR recovery

For a managed PostgreSQL provider, use its point-in-time-recovery or snapshot restore into a **new isolated database/project** first. Record the chosen recovery timestamp, provider job/result and connection target. Do not repoint application traffic until `scripts/verify-restored-database.ts` passes and the release owner has reviewed the recovery point.

Provider-specific dashboard clicks, retention duration and named responsible operator are deployment facts and must be completed in the staging/production activation record; the starter cannot invent them.

## Recovery validation

After the smoke verifier passes:

1. Run `bun run db:verify` against the restored database configuration.
2. Run the focused auth, commerce, subscription and credit integration suites with provider calls disabled/test-only.
3. Confirm no production cron/webhook endpoint targets the isolated database.
4. Compare expected row-volume ranges using approved internal operational tooling; do not paste user/payment data into tickets or chat.
5. Record duration, result, anomalies and cleanup.

## CI restore drill

CI creates schema/data in the PostgreSQL service, takes a custom-format dump, restores into a separate database and runs `scripts/verify-restored-database.ts`. This proves the repository's dump/restore/smoke procedure against synthetic data on every relevant change. It is not a substitute for the deployment-specific managed-provider/PITR staging drill.

## Cleanup

Delete the temporary dump and isolated restore database after evidence is recorded. If the exercise exposed credentials, rotate them rather than continuing to reuse drill credentials.

# Release rollback

Rollback is a controlled recovery action, not permission to reverse database history blindly.

## Before every release

Record the candidate commit, previous known-good deploy, migration set, environment/provider changes, database restore point, job/schema compatibility and owner. Keep the previous deploy address/revision available until verification is complete.

Classify the release:

- **Code-only/backward-compatible:** previous code can safely run against the current database/schema.
- **Forward-only schema/provider change:** previous code is not safe without a database/provider recovery plan.
- **Credential compromise:** never roll back to a compromised secret merely to restore service.

## Code rollback

1. Stop or pause destructive/background operations if they could amplify the incident.
2. Promote/redeploy the last known-good commit using the deployment platform's immutable deployment history.
3. Keep the current database if migrations are backward-compatible.
4. Verify `/api/health/live`, `/api/health/ready`, auth, representative public page, internal job authentication and the affected product journey.
5. Reconcile commerce/credits after payment or fulfillment incidents before declaring recovery.

## Database recovery

Do not execute ad-hoc down migrations against production. If data/schema recovery is necessary:

1. Restore the approved backup/PITR point into an isolated database.
2. Run `RESTORED_DATABASE_URL=... bun scripts/verify-restored-database.ts`.
3. Determine what externally committed provider events occurred after the recovery point and how they will be replayed/reconciled.
4. Only then repoint application traffic under an incident/release owner.

Follow `docs/runbooks/database-backup-restore.md` for the exact restore procedure.

## Provider/config rollback

If a provider configuration change failed, restore the previous configuration only when the old credential/configuration remains authorized and uncompromised. Verify callback origins, webhook signing, product IDs and environment separation before reopening traffic.

## Migration compatibility rule

A release with a destructive or non-backward-compatible migration must use an expand/migrate/contract rollout or an explicit forward-fix. The previous application version is not a valid rollback target if it cannot safely operate against the new schema.

## Verification after rollback

Run the focused incident suite plus:

```bash
bun run typecheck
bun run test:unit
TEST_DATABASE_URL="$TEST_DATABASE_URL" bun run test:integration
bun run verify:security
bun run verify:commerce
bun run verify:credits
bun run build
bun run verify:release
```

For a live incident, replace broad local commands with the approved deployment smoke checks if running the full suite would delay containment; run the complete gate before closing the incident.

## Record

Capture trigger, scope, previous/current commit, migrations, database recovery point, provider/config/credential changes, commands, deployment IDs, reconciliation result, customer-impact window, owner and follow-up. Never copy secrets or private payloads into the record.

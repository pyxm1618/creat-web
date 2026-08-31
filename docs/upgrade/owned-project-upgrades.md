# Upgrading an owned product from this starter

Products created from `creat-web` are owned codebases, not live template instances. Do not merge the starter wholesale over product config/content.

## 1. Record the baseline

In the owned product, record the starter version/commit it was created from and the target starter version. Compare `CHANGELOG.md` entries between those versions.

## 2. Classify each starter change

For each security/platform change, record:

- affected platform files/modules;
- database migrations and whether they are additive/destructive;
- new/removed/renamed environment variables;
- provider/dashboard changes;
- config interface changes;
- verification commands and expected evidence;
- rollback requirements;
- whether the change is mandatory for security or optional functionality.

Product-owned copy, routes, legal facts, provider IDs, pricing and feature choices are not overwritten merely because the starter changed.

## 3. Port intentionally

Prefer a reviewed cherry-pick when a starter commit is isolated and applies cleanly. Otherwise manually port the smallest coherent change. Never resolve conflicts by blindly choosing the starter version of product config/content.

Apply migrations in order. If a migration or provider change is irreversible, rehearse it against an isolated restored database before production.

## 4. Reconcile configuration

Update `.env.example`, feature/config types and deployment secrets together. New required secrets are purpose-specific; never reuse auth, cron, webhook, encryption, database or provider secrets for another purpose.

## 5. Verify

Run at minimum:

```bash
bun install --frozen-lockfile
bun run format:check
bun run lint
bun run typecheck
bun run test:unit
TEST_DATABASE_URL="$TEST_DATABASE_URL" bun run test:integration
bun run test:contract
bun run db:verify
bun run verify:security
bun run verify:secrets
bun run build
bun run test:e2e
bun run verify:release
```

Run any additional commands named in the relevant changelog entry. Security, credit, payment, subscription, retention or migration changes require their focused suites as well.

## 6. Release and rollback

Deploy to isolated staging first. Verify migrations, auth, jobs, provider callbacks and product journeys. Keep the previous deploy and database restore point available until the target version is proven. Follow `docs/runbooks/release-rollback.md` when rollback is required.

## 7. Close the upgrade record

Record source version/commit, target version/commit, ported commits/files, migrations, environment/provider changes, verification results, staging evidence, production deployment, and any intentionally deferred optional change.

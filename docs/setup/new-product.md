# Create a new product from a clean checkout

This starter is configuration-first. Do not duplicate or edit platform code merely to rename a product.

## Prerequisites

- Git
- Bun `1.3.14`
- PostgreSQL 16-compatible database for local/test verification
- Chromium dependencies supported by Playwright

For a real deployed product you will also need environment-specific provider accounts/credentials for every enabled feature. The repository cannot manufacture legal identity, domain ownership, verified senders, payment accounts or production credentials.

## 1. Start clean

Clone the repository and check out the reviewed starter version/commit. The worktree should be clean before product configuration starts.

```bash
git status --porcelain
bun install --frozen-lockfile
```

The starter version is exported by `src/config/template-version.ts` and changes are recorded in `CHANGELOG.md`.

## 2. Configure only versioned product inputs

The product-owned configuration surface is under `src/config`. At minimum review:

- `site.config.ts`
- `features.config.ts`
- `products.config.ts`
- `seo.config.ts`
- `routes.config.ts`
- `legal.config.ts`

`examples/neutral-product` is a synthetic Focus Planner example used only to prove the workflow. Apply it with:

```bash
bun scripts/apply-example-config.ts
```

The script refuses to overwrite already-modified target config unless `--confirm` is supplied. It never copies platform code.

Replace the synthetic example with your own reviewed product facts. Do not treat the sample operator, legal text, provider IDs, prices or `example` domain as production facts.

## 3. Configure test environment

Copy the variable names from `.env.example` into your local secret manager or uncommitted environment file. Enable only the providers selected by `features.config.ts`.

For Magic Link, local/test can use Cloudflare Turnstile's official test configuration supplied by runtime defaults. Staging/production require real Turnstile keys. Commerce requires Waffo merchant/store/credential/webhook values plus a 32-byte base64 retention key. Google sign-in requires a matching OAuth client. Never commit credentials.

## 4. Prepare database

Create a fresh PostgreSQL database and run:

```bash
DATABASE_URL="$DATABASE_URL" bun run db:migrate
bun run db:verify
```

Do not skip migrations because another checkout already created tables.

## 5. Run the offline gate

```bash
bun run format:check
bun run lint
bun run typecheck
bun run test:unit
TEST_DATABASE_URL="$TEST_DATABASE_URL" bun run test:integration
bun run test:contract
bun run build
bun run test:e2e
bun run verify:architecture
bun run verify:secrets
bun run verify:security
bun run verify:release --mode=test
```

No required command may be replaced with “works on my machine.” Fix the config/docs if a new developer needs an undocumented edit.

## 6. Reproduce the clean-setup proof

With a disposable PostgreSQL database:

```bash
CLEAN_SETUP_DATABASE_URL="$CLEAN_SETUP_DATABASE_URL" bun scripts/verify-clean-setup.ts
```

The script clones the exact current commit into a temporary directory, applies only the six neutral product config files, resets the isolated database, installs dependencies and runs the full gate. It fails if any additional tracked file must be edited or if product-specific forbidden references appear in application/config sample paths.

## 7. Before staging

Replace all sample/legal placeholders, provision a separate staging deployment/database/provider configuration, configure an alert destination, and follow `docs/releases/v0.1.0-staging-verification.md`. Staging must remain isolated from production credentials and production analytics/search submission.

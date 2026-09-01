# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

`creat-web` is a private, SEO-first Next.js 16 / React 19 starter for launching web products. It ships as a **neutral template**: auth, email, commerce, one-time payments, subscriptions, credits and analytics are all **disabled by default** and turned on only when the product needs them. Launching a product means editing `src/config/**`, not platform code.

`README.md` is the product-launch guide (step-by-step SEO launch, enabling each module). This file covers how to work _in_ the code.

## Commands

Toolchain is pinned: **Bun 1.3.14**, PostgreSQL 16, exact dependency versions (no ranges). Always install with `bun install --frozen-lockfile`.

### Dev and build

```bash
bun run dev          # next dev --webpack (Turbopack is deliberately not used)
bun run build        # production build
bun run build:test   # APP_ENV=test build
```

### Quality

```bash
bun run format       # prettier --write .
bun run format:check
bun run lint
bun run typecheck
```

### Tests

```bash
bun run test:unit         # vitest, node env, tests/unit/**
bun run test:integration  # vitest, requires TEST_DATABASE_URL, serial (fileParallelism: false)
bun run test:contract     # provider contract tests, tests/contract/**
bun run test:e2e          # Playwright; boots its own server via tests/e2e/start-enabled-test-server.ts
bun run test:build-matrix # builds once with all features off, once with all on
```

Run a single test file or case (same form CI uses):

```bash
bun run test:unit -- tests/unit/seo/canonical.test.ts
bun run test:integration -- tests/integration/commerce/job-leases.test.ts
bun run test:unit -- -t "rejects duplicate canonical"
bunx playwright test tests/e2e/seo.spec.ts -g "sitemap"
```

Integration tests read `TEST_DATABASE_URL` (not `DATABASE_URL`) and in `beforeAll` **drop and recreate the `public` and `drizzle` schemas** before re-running migrations. Point it at a throwaway database.

### Database

```bash
bun run db:generate  # drizzle-kit generate — the ONLY way to create a migration
bun run db:migrate   # apply drizzle/ migrations
bun run db:verify    # empty-DB chain + main-baseline forward chain + idempotent re-apply
```

Never hand-write a migration and present it as generated output. Production never uses schema push.

`db:verify` runs two paths: `empty_to_latest` (fresh install) and `main_chain_to_latest`, which applies migrations up to `MAIN_BASELINE_TAG` first — simulating the current production database — then applies the rest, proving this release's migrations land safely on an existing database. That baseline is a hardcoded constant in `scripts/verify-migrations.ts`, not read from git, and it asserts "main's last migration is X". Note the guard on line 220: the baseline may not be the _last_ entry in the journal, so advancing it to the newest migration right after a merge makes `db:verify` fail on the next PR that adds no migration. Advance it when you next add a migration, not at merge time. A stale (older) baseline is conservative, not dangerous; a baseline set too new is what silently skips real upgrade coverage.

### Release gates

`bun run verify` is the aggregate local gate and runs everything below in order. Individual gates while iterating:

| Command                              | Checks                                                                 |
| ------------------------------------ | ---------------------------------------------------------------------- |
| `verify:architecture`                | `eslint src tests scripts` — boundary rules                            |
| `verify:secrets`                     | repository secret scan                                                 |
| `verify:seo`                         | route/TDH/intent/link-graph/orphan/anchor gate                         |
| `verify:i18n`                        | locale bundle completeness                                             |
| `verify:security`                    | runs twice: default env and `APP_ENV=production`                       |
| `verify:subscription`                | subscription config + command-route classes                            |
| `verify:commerce` / `verify:credits` | commerce and credit-ledger invariants                                  |
| `verify:credit-races`                | 30-run credit expiry race probe (CI)                                   |
| `verify:supply-chain`                | frozen lockfile + `bun audit --audit-level=high`                       |
| `verify:release`                     | config/legal/SEO release readiness; `--mode=test\|staging\|production` |
| `verify:performance`                 | Playwright budgets against a production build (desktop + mobile)       |
| `verify:seo:production`              | production-mode canonical and security output                          |

CI (`.github/workflows/ci.yml`) additionally diffs the generated Better Auth schema, runs a PostgreSQL dump/restore drill, and a `clean-setup` job (`scripts/verify-clean-setup.ts`) proving a fresh checkout can be configured into a working product.

After changing `src/platform/auth/auth-cli.ts` or Better Auth options, regenerate and commit the schema — CI fails on a diff:

```bash
bunx auth@1.6.25 generate --config src/platform/auth/auth-cli.ts --output src/platform/database/auth-schema.ts --yes
bunx prettier --config .prettierrc.json --write src/platform/database/auth-schema.ts
```

## Architecture

### Product config vs. platform — the central boundary

- `src/config/**` — **product-owned**, per-project, safe to edit for a launch. Every export uses `as const satisfies <PlatformType>` so platform types drive the shape.
- `src/platform/**` — **reusable platform**. Must not depend on product modules; ESLint bans `@/modules/*` imports here (`@/modules` is the reserved location for future product code).
- `src/components/**` — renderers the config feeds (landing sections, legal document, navigation, analytics boundary).
- `examples/neutral-product/` — a synthetic sample config applied by `bun scripts/apply-example-config.ts`; it never copies platform code.

Adding a product capability almost always means config + a platform capability behind a type, not editing a page component.

### Feature flags are compile-time constants

`src/config/features.config.ts` is the single source of truth for what exists at all. Consequences to respect:

- **Env validation is feature-gated.** `src/platform/config/env.ts` calls `loadRuntimeEnv(process.env, featuresConfig)`; a provider's secrets are required only when its flag is on. Never require a secret unconditionally.
- **Disabled providers are never initialized.** Provider modules load via dynamic `import()` inside composition roots (see `getCommerceRuntime()` in `src/platform/commerce/commerce-runtime.ts`), so a disabled feature contributes no bundle, no client script, no network request.
- The same file carries E2E profiles selected by env: `APP_ENV=test` + `CREAT_WEB_E2E_ENABLED_FEATURES=1` (auth/email/analytics on), plus `CREAT_WEB_E2E_COMMERCE=1` (commerce/subscriptions on). `test:build-matrix` rewrites this file temporarily to build both extremes, so keep it mechanically rewritable (plain object literals).

### SEO is a route registry, not per-page metadata

`src/config/routes.config.ts` declares **every** route with a class — `public_indexable` | `public_noindex` | `private` | `system` — and indexable routes carry the full intent model (`searchIntent`, `primaryKeyword`, `title`/`description`/`h1`, `pageType`, `relatedRoutes`, `lastModified`, `reviewStatus`). `createRouteRegistry` (`src/platform/seo/route-registry.ts`) derives metadata, canonicals, sitemap entries, hreflang and the internal link graph from it.

Adding an indexable page = route definition in `routes.config.ts` + visible content in `src/config/seo-landings.config.tsx`; the shared landing renderer supplies the shell. `verify:seo` fails on missing/duplicate/placeholder TDH, intent mismatch, duplicate canonicals, orphan pages, invalid internal targets, generic anchors ("click here"), excessive path depth, and unreviewed production SEO. One search intent = one page; do not add synonym pages.

`APP_ENV` alone decides indexability: `seoEnvironmentPolicy` (`src/platform/seo/environment-policy.ts`) emits index/follow/sitemap/canonical **only** for `production`; every other environment is noindex with a localhost metadata origin.

### i18n routing

Path-based, default locale unprefixed (`/`, `/de`, `/de/slug`). There is no locale segment in the file tree — `src/app/[segment]/page.tsx` and `src/app/[segment]/[slug]/page.tsx` disambiguate at runtime: a segment matching a non-default supported locale renders the localized home/landing from `src/config/locales.config.tsx`; otherwise `/{segment}` is looked up as an SEO landing route. Helpers live in `src/platform/i18n/routing.ts`. A locale without real translated bundles fails `verify:i18n` and the type gates — that is intentional.

### Security headers

- `src/proxy.ts` is the Next 16 middleware (exported as `proxy`, not `middleware`). It mints a per-request nonce, builds the CSP via `buildContentSecurityPolicy`, and sets it on both the forwarded request (`x-nonce`) and the response. Script sources admit GA4/Clarity/Turnstile origins **only when the matching flag is on**; there is no `unsafe-inline` for scripts.
- `next.config.ts` sets the static baseline (nosniff, frame-deny, COOP/CORP, permissions policy, production HSTS, non-production `X-Robots-Tag: noindex`) and forces `no-store` + `noindex` on `/account`, `/sign-in`, `/auth`, `/checkout` and all `/api/{account,auth,commerce,webhooks,cron,internal,health,test}` paths.

### Commerce and credits — ports and adapters, enforced by lint

```
src/platform/commerce/domain/               pure state machines and value objects (order, payment, subscription, money)
src/platform/commerce/application/          use cases + the PaymentProvider port
src/platform/commerce/providers/waffo/      adapter for the pinned @waffo/pancake-ts version
src/platform/commerce/commerce-runtime.ts   the ONLY composition root
```

A custom ESLint rule (`creat-web/commerce-credits-boundary` in `eslint.config.mjs`) enforces that commerce `domain`/`application`/`providers` may not import Credits at all, and that `commerce-runtime.ts` may import Credits only through the single public entry `src/platform/credits/integration/commerce/credit-fulfillment`. Credits mirrors the same layering (`domain` / `application` / `infrastructure` / `integration`). To let commerce trigger credit work, extend the fulfillment port — do not reach across.

Non-negotiable domain invariants:

- Browser input is never authoritative for price or payment state; product config plus signed/reconciled provider facts are.
- Entitlement is never granted from a checkout return page — only from provider events applied with local idempotency and durable fulfillment jobs.
- Product versions are immutable snapshots; change commercial facts by adding a version.
- Refunds are serialized in the database so successful + in-flight refunds cannot exceed the captured amount.

### Durable work, not background timers

Account deletion, webhook application, fulfillment, credits, subscription commands and refund reversal are all **persisted jobs** with idempotency keys, leases, exponential retry, expired-lease recovery and dead-letter states (`src/platform/operations/`, `src/platform/commerce/application/job-leases.ts`). Entry points are the cron routes in `vercel.json` → `/api/internal/jobs/*`, authenticated via `authenticate-internal-request.ts`. Dead-letter and reconciliation states are deliberate, operator-visible failure modes — never convert one into silent success. Runbooks live in `docs/运维/` (Chinese).

### Account identity

`account_subjects` is a non-auth subject owning financial/entitlement history, distinct from the Better Auth user. Deleting an auth identity must not destroy that history or silently reattach it to a new identity (`src/platform/accounts/`).

### Where product code lives

The starter is the shell around a product, not the product. Product code — the actual tool, calculator or generator — belongs in `src/modules/<product>/`, with `domain/` for pure logic, `ui/` for components, and `index.ts` as the only entry anything outside may import.

Two edges are enforced by `creat-web-modules/product-module-boundary` in `eslint.config.mjs`: a module may not import `@/config/*` (configuration composes modules, so the reverse would close a cycle), and nothing outside a module may reach past its public entry (including one module into another). Platform code is separately barred from `@/modules/*` by `no-restricted-imports`. `tests/unit/architecture/product-module-boundary.test.ts` covers both.

Configuration wires a module in by importing its entry into a `tool-demo` section's `surface`. Full rationale and the dependency table: `docs/参考/产品模块.md`.

### UI and styling

Tailwind CSS v4 via PostCSS (`postcss.config.mjs`, `@tailwindcss/postcss`). There is no `tailwind.config.js` — v4 is configured in CSS. `src/app/globals.css` is small and holds only three things: the `@import "tailwindcss"`, the design tokens, and a short `@layer base`.

**Design tokens.** Semantic CSS variables on `:root` plus a `@media (prefers-color-scheme: dark)` override, exposed to utilities through `@theme inline`. Always compose from the semantic utilities — `bg-background`, `bg-surface`, `bg-surface-muted`, `text-foreground`, `text-muted`, `text-accent`, `bg-inverse`, `border-border` — never raw palette colors, or dark mode silently breaks.

**Shared class strings live in `src/components/ui/styles.ts`** (`container`, `card`, `buttonPrimary`, `input`, `bodyText`, …). They are plain exported constants, not components, so every surface stays visually identical while shipping zero runtime JS. Reuse them instead of re-typing utility strings; add a new constant when a pattern appears a third time.

Page shells: `src/components/landing/landing-page.tsx` is the **only** landing renderer (it defines every section internally and switches on `LandingSection["type"]`), and `src/components/account/account-shell.tsx` wraps every authenticated page. Nine standalone `*-section.tsx` files once shadowed the landing section names as dead code and were deleted — don't reintroduce that split.

When changing any page, keep every `id`, `aria-labelledby` and element type intact — e2e, SEO and axe assertions depend on them. Verify against the budgets in `tests/performance/marketing-performance.spec.ts`: script bytes ≤ 350 KB, ≤ 20 script files, LCP ≤ 2500 ms, CLS ≤ 0.1, zero console errors, no critical/serious axe violations. Tailwind itself costs no JS; a component library that ships runtime JS (Radix and friends) draws against the script budget, so pull those in per-component rather than wholesale.

**No gate catches visual regressions.** The e2e, performance and axe suites all pass on a page whose layout is completely broken — they assert DOM structure, metadata and budgets, never appearance. After changing markup or CSS, build and screenshot the affected pages before claiming the change works.

## Conventions

- TypeScript is strict with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. Build optional properties by conditional spread (`...(value ? { key: value } : {})`) rather than assigning `undefined`.
- Path alias `@/*` → `src/*` (tsconfig, all vitest configs, and the ESLint boundary resolver).
- Server-only platform modules begin with `import "server-only"`.
- Prettier: double quotes, semicolons, trailing commas, `printWidth: 100`. `docs/`, `README.md` and `drizzle/meta` are prettier-ignored.
- Tests mirror the source tree by area (`tests/unit/<area>/`, `tests/integration/<area>/`); type-level tests are `tests/type/*.test-d.ts`.
- Commits follow `type(scope): imperative subject`, e.g. `fix(commerce): fence worker leases`.
- Starter version lives in `src/config/template-version.ts` with changes recorded in `CHANGELOG.md`; `verify:release` requires semver there.

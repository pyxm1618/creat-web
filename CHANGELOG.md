# Changelog

All notable starter-platform changes are recorded here. This repository is an internal starter; owned products do not automatically inherit changes and must follow the upgrade procedure in `docs/参考/扩展与升级.md`.

## 0.2.1 - 2026-09-02

### Fixed

- `TurnstileWidget` injected the Turnstile script with `async` and `defer` set and then called `turnstile.ready()`. Cloudflare rejects that combination (`TurnstileError: Remove async/defer from the Turnstile api.js script tag before using turnstile.ready()`), so the widget never rendered, no token was ever produced, and the sign-in button stayed disabled forever — magic-link sign-in was unusable in a real browser whenever the genuine Turnstile script loaded. Both attributes are now cleared; a dynamically inserted script is non-blocking regardless. The e2e suite installs a `window.turnstile` mock before load, so the real script path was never exercised and CI stayed green throughout.

### Documentation

- `docs/建站手册.md`: added a tested local walkthrough for taking a one-time payment end to end (tunnel, `APP_ORIGIN`, registering the webhook through the SDK, the four rows to check in the database), the requirement that every `fulfillmentKey` has a handler, and four newly hit traps — a `reviewed` SEO route without `reviewFingerprint` breaking every gate that imports `routes.config.ts`, `COMMERCE_RETENTION_KEY` needing exactly 32 base64 bytes, `drizzle.config.ts` not reading `.env.local`, and stale `.next` type files producing phantom typecheck errors.
- Recorded that `verify:commerce` cannot see credit-based fulfillment: it inspects only the static `fulfillmentHandlers` registry, while credit handlers are injected at runtime by `commerce-runtime.ts`. The gate is unchanged; the limitation is now documented rather than rediscovered.

### Owned-project action

No migrations and no environment-variable changes. Any product with `auth.magicLink` enabled should take this fix — without it the sign-in form cannot be submitted.

## 0.2.0 - 2026-09-01

Platform capabilities that landed on `main` after the `0.1.0` entry was written, plus the documentation consolidation and two corrections.

### Product modules

- Added `src/modules/<product>/` as the home for product code, with `index.ts` as the only public entry.
- Added the `creat-web-modules/product-module-boundary` ESLint rule: a module may not import `@/config/*`, and nothing outside a module may reach past its public entry (including one module into another). Covered by `tests/unit/architecture/product-module-boundary.test.ts`.

### UI and styling

- Added the Tailwind CSS v4 design-token layer in `src/app/globals.css`: semantic CSS variables on `:root` with a `prefers-color-scheme: dark` override, exposed to utilities through `@theme inline`. There is no `tailwind.config.js`.
- Added `src/components/ui/styles.ts`, shared class-string constants (`container`, `card`, `buttonPrimary`, `input`, …) that keep surfaces consistent while shipping zero runtime JS.

### SEO

- Added IndexNow incremental change submission: `GET /indexnow-key.txt` and the authenticated `POST /api/internal/seo/indexnow`. It complements `/sitemap.xml` rather than replacing it.
- Hardened the SEO verification gate.

### Fixed

- `scripts/verify-credits.ts` asserted that `vercel.json` schedules `/api/cron/credits`, which it does not. The assertion was dormant while credits were disabled and would have failed the first time anyone enabled them. It now asserts `/api/internal/jobs/credit-expiry`, matching `vercel.json` and the equivalent assertion in `verify-release.ts`.

### Removed

- Removed the unscheduled `/api/cron/{commerce,credits,account-deletions}` route handlers and their route-registry entries. `vercel.json` has only ever scheduled `/api/internal/jobs/*`; the `/api/cron/*` handlers were older, narrower duplicates (ledger reconciliation had already moved to the reconcile job). The `no-store` header rule for `/api/cron/:path*` is deliberately retained in `next.config.ts` as defence in depth.

### Documentation

- Consolidated 52 English documents (13,616 lines) into 9 Chinese ones. The removed material was build-time scaffolding — implementation plans, proposals still marked _proposed for independent review_, and review briefs — superseded by the implementation that followed; `git log` retains it.
- `docs/建站手册.md` is the manual; reference material is under `docs/参考/`, operational procedures under `docs/运维/`, indexed by `docs/README.md`.
- `scripts/verify-commerce.ts` asserts the Waffo activation gate's exact wording so the checklist cannot be quietly watered down; those assertions now match the Chinese document.

### Owned-project action

No migrations and no environment-variable changes. Anything calling `/api/cron/*` directly must move to `/api/internal/jobs/*`; nothing in this repository or `vercel.json` did.

## 0.1.0 - 2026-08-09

Initial internally versioned starter baseline.

### Platform and security

- Added strict environment validation, sensitive-route caching/robots controls, strict script CSP/SRI build support, browser isolation headers, and production HSTS.
- Added durable Magic Link abuse controls with Cloudflare Turnstile server validation and durable rate limits.
- Added complete analytics consent controls and allowlisted event sanitization.
- Added authenticated bounded internal jobs, health/readiness, provider-neutral operational metrics/alerts, and audited dead-letter inspection/retry.
- Added encrypted webhook retention classes and bounded concurrent purge processing.

### Commerce and credits

- Added Waffo-backed one-time/subscription/refund workflows with durable webhook inbox, leases, retries, reconciliation and fulfillment idempotency.
- Added credit grants, reservations, commits/releases, source-bounded reversal, expiry, reconciliation and cross-expiry reservation semantics protected by shared mutation locks.

### Starter/release

- Added SEO/i18n route registry and production metadata verification.
- Added database migration verification, provider build matrix, browser performance budgets and release gates.
- Added backup/restore verification, purpose-specific key-rotation/rollback procedures, neutral-product clean-setup validation and starter version tracking.

### Owned-project action

Projects created before `0.1.0` must manually review/cherry-pick the affected platform modules, migrations, environment changes and verification commands. Do not copy product-specific config/content back into the starter.

# Changelog

All notable starter-platform changes are recorded here. This repository is an internal starter; owned products do not automatically inherit changes and must follow the upgrade procedure in `docs/upgrade/owned-project-upgrades.md`.

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

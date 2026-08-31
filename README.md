# creat-web

Private, SEO-first Next.js starter for launching overseas web products quickly, then enabling authentication, commerce, credits, subscriptions, analytics, and additional locales only after the product needs them.

`pyxm1618/quickiching` is a strictly read-only reference project. `creat-web` does not modify it, depend on it, or copy its product identity/content.

> **中文用户**：[docs/setup/建站手册.md](docs/setup/建站手册.md) 是一份按时间顺序
> 的完整操作手册，从空仓库到被 Google 收录，含实际建站时才会撞到的坑。

## Default mode: SEO launch

The neutral starter intentionally ships with advanced product modules disabled:

```text
Auth          OFF
Email         OFF
Commerce      OFF
One-time      OFF
Subscriptions OFF
Credits       OFF
Analytics     OFF
```

That means a first launch does not need OAuth, Resend, Waffo, GA4, Clarity, or other provider credentials. Keep the platform code unchanged and configure the product through the files below.

## First-day SEO-only launch

### 1. Create the project

Use this repository as the starting point, install the pinned toolchain, and keep the lockfile frozen:

```bash
bun install --frozen-lockfile
```

The repository currently pins Bun in `package.json` and pins critical runtime dependencies to exact versions.

### 2. Change the site identity

Edit `src/config/site.config.ts`:

- `slug`
- `name`
- `canonicalOrigin`
- `defaultLocale`
- `supportedLocales`
- `localeLabels`

Use the final HTTPS production origin for `canonicalOrigin`. Preview/test environments are automatically noindex and do not publish production canonicals.

### 3. Replace the logo, icon, and social image

Replace project-owned assets under `public/` as needed. The starter includes an icon and a default Open Graph fallback. Do not add a decorative hero image just to fill space; if the product does not need one, keep the first screen text/tool-first.

For product images, use `next/image` with intrinsic dimensions or a stable aspect ratio, responsive `sizes`, and below-the-fold lazy loading. Treat the actual LCP asset separately from ordinary content images.

### 4. Define homepage search intent and TDH

Edit the `/` entry in `src/config/routes.config.ts`:

```text
searchIntent
primaryKeyword
secondaryKeywords
title
description
h1
pageType
relatedRoutes
lastModified
reviewStatus
```

The release gate rejects missing/duplicate/placeholder TDH, obvious intent mismatch, duplicate canonicals, orphan pages, invalid internal routes, generic anchors, excessive path depth, and unreviewed production SEO definitions.

Google meta-keywords are intentionally not emitted.

### 5. Configure homepage sections

Edit `src/config/home.config.tsx`.

The default homepage renderer supports configurable sections such as:

```text
Hero
Tool / Product surface
Use Cases
How It Works
Benefits / Features
Comparison / Evidence
FAQ
SEO Content
Related Resources
Final CTA
```

Every section supports project-owned content and may be disabled/reordered. The primary H1 is kept consistent with the route SEO model. Core SEO copy is server-rendered HTML rather than client-only content.

### 6. Add only SEO pages with independent search intent

Register the route in `src/config/routes.config.ts`, then add its visible content to `src/config/seo-landings.config.tsx`.

The shared landing renderer supplies the SEO/page shell so a new page should mostly be **route intent + content**, not a new SEO implementation.

Do not create pages merely because keywords are slight synonyms. One clear search intent/topic cluster should map to one useful page.

### 7. Review internal links

Use `relatedRoutes` for the semantic route graph and the landing content links for actual rendered navigation. The SEO verifier checks:

- indexable pages are reachable from `/`
- rendered pages are not orphaned
- internal targets exist
- anchors are descriptive rather than generic “click here” patterns
- indexable paths are not unnecessarily deep

### 8. Replace legal facts and text

Edit `src/config/legal.config.ts`.

The starter provides configurable templates for:

- Privacy
- Terms
- Acceptable Use
- Refund / Cancellation
- Account Deletion
- Contact

They are templates, not legal advice. Before production, replace the sample operator/jurisdiction/support information, actual provider disclosures, retention/commercial facts, and mark the applicable documents/config as reviewed. Production release verification fails closed while placeholder/draft legal facts remain.

### 9. Keep product modules off for the SEO MVP

Verify `src/config/features.config.ts` remains neutral:

```ts
auth.enabled = false
email.enabled = false
commerce.enabled = false
commerce.oneTime = false
commerce.subscriptions = false
commerce.credits = false
analytics.enabled = false
```

Disabled providers are not initialized and their secrets are not required.

### 10. Deploy to Vercel

For the initial SEO-only site, configure the normal application/database deployment facts required by the project. Do not invent provider secrets for disabled modules.

The runtime treats Vercel Preview as staging/noindex and Vercel Production as production. `APP_ENV=test` is rejected on a production Vercel deployment.

### 11. Connect the production domain

Set `APP_ORIGIN` and `site.config.canonicalOrigin` to the final HTTPS origin, configure the production DNS/domain in Vercel, and verify redirects/canonical host behavior before indexing.

### 12. Search Console and sitemap

After the production domain is live and the production SEO/legal review gates are satisfied:

1. verify the site in Google Search Console;
2. submit `/sitemap.xml`;
3. inspect the homepage and priority SEO pages;
4. monitor crawl/indexing/ranking rather than generating arbitrary extra pages.

## SEO launch checklist

Before production, run:

```bash
bun run verify:seo
bun run verify:i18n
bun run verify:security
bun run verify:performance
bun run build
bun run test:e2e
```

Confirm manually that the production content is truthful and useful. Automated checks deliberately cannot decide whether a page deserves to rank.

## Enabling authentication after validation

Edit `src/config/features.config.ts`.

For Magic Link authentication:

```text
auth.enabled = true
email.enabled = true
auth.magicLink = true
```

Then provide the deployment environment values described in `.env.example`, including a production-grade `BETTER_AUTH_SECRET`, Resend configuration, sender/support addresses, and the cron secret required by durable account lifecycle work.

Google login is independent:

```text
auth.enabled = true
auth.google = true
```

Then add Google OAuth credentials. Password auth remains intentionally disabled in the neutral platform model.

Authentication uses Better Auth behind the platform boundary and retains a non-auth account subject so account deletion does not destroy financial/entitlement history or silently attach old history to a new auth identity.

## Enabling commerce

Commerce is opt-in:

```text
commerce.enabled = true
```

Then choose the specific capabilities:

```text
commerce.oneTime = true | false
commerce.subscriptions = true | false
commerce.credits = true | false
```

When commerce is OFF, Waffo is not initialized and Waffo/retention secrets are not required.

### Waffo configuration

The current adapter is built against the exact pinned `@waffo/pancake-ts` version in `package.json`.

Configure the Waffo values in `.env.example` only after the owner has real merchant/store/webhook resources. Deployed commerce also requires the explicit contract-verification gate after the actual Waffo resources have been tested.

Browser input is never the authority for product price or payment state. Product configuration and signed/reconciled provider facts are authoritative.

### Product configuration

Add versioned products to `src/config/products.config.ts`.

A one-time product has no billing interval:

```ts
{
  key: "starter-pack",
  version: 1,
  enabled: true,
  commercialModel: "one_time",
  currency: "USD",
  expectedPrice: "29.00",
  providerProductIdByEnvironment: {
    test: "<owner Waffo test product id>",
    production: "<owner Waffo production product id>",
  },
  fulfillmentKey: "starter-pack",
  refundPolicyKey: "default-one-time",
}
```

Subscriptions explicitly declare their provider-neutral cadence:

```ts
{
  key: "pro-monthly",
  version: 1,
  enabled: true,
  commercialModel: "subscription",
  billingInterval: "month", // or "year"
  currency: "USD",
  expectedPrice: "19.00",
  providerProductIdByEnvironment: {
    test: "<owner Waffo test product id>",
    production: "<owner Waffo production product id>",
  },
  fulfillmentKey: "pro-entitlement",
  refundPolicyKey: "default-subscription",
}
```

Product versions are immutable snapshots. Change material commercial facts by adding a new version rather than mutating a persisted version.

### Fulfillment and credits

Map fulfillment operations in the project configuration. Credits use the immutable credit ledger and can be granted from one-time orders or individual subscription periods.

Do not implement entitlement by trusting a checkout return page. Provider events, local idempotency, and durable fulfillment jobs drive the authoritative state.

### Subscriptions

The platform supports provider-neutral subscription projections for:

- monthly/yearly product cadence
- activation
- renewal/payment success
- canceling
- resume/uncancel
- past due
- fixed grace deadline/version
- canceled/closed terminal projections
- billing history

`past_due_started_at`, `past_due_grace_ends_at`, and `grace_policy_version` are persisted. Repeated past-due events do not extend an existing grace deadline.

Cancel/resume requests are durable command jobs with idempotency, leases, exponential retry, expired-lease recovery, and dead-letter state rather than relying on a single browser request completing the provider operation.

### Refunds

Refund requests are server-authorized against the current account subject and captured payment. The database serializes requests so successful + in-flight refunds cannot exceed the captured amount.

Full refund entitlement reversal uses the configured fulfillment reversal. If credits/entitlements have already been consumed or safely automated reversal is otherwise impossible, the refund is marked for operator reconciliation instead of silently diverging financial and entitlement state.

Partial refunds intentionally require an explicit product/operator entitlement policy rather than guessing a universal proportional reversal.

### Future Stripe adapter

The domain uses the provider-neutral `PaymentProvider` interface. A future Stripe adapter should map Stripe checkout/payment/subscription/refund facts into the existing order/payment/subscription/refund/entitlement domain rather than duplicating those domains. See `docs/providers/payment-provider-extension.md`.

## Enabling analytics

Analytics configuration lives in `src/config/features.config.ts`:

```text
analytics.enabled
analytics.ga4
analytics.clarity
analytics.consentRequired
```

GA4 and Clarity are OFF by default. When consent is required, the browser does not create provider scripts before consent, so there are no provider network requests merely because tracking calls are suppressed.

Analytics is not mounted on sensitive auth/account/checkout/payment/deletion surfaces.

Add `GA4_MEASUREMENT_ID` and/or `CLARITY_PROJECT_ID` only for enabled providers.

## Enabling another language

The URL model is path-based:

```text
/
/de/
/fr/
/ja/
```

The default locale remains at `/`; non-default locales use a path prefix. Language subdomains are not used.

To add German:

1. add `de` to `supportedLocales` in `src/config/site.config.ts`;
2. add `de: "Deutsch"` to `localeLabels`;
3. add the required `de` bundle in `src/config/locales.config.tsx`;
4. translate SEO intent copy, TDH, H1, homepage visible content, and each localized indexable landing page;
5. run `bun run verify:i18n` and the browser tests.

The routing/SEO layer then supplies locale paths, localized canonical URLs, self/all-locale hreflang entries, `x-default`, localized sitemap alternates, real `<html lang>`, and crawlable language-switcher links.

Do not add a locale without real translations. The type/i18n gates are designed to fail instead of publishing empty machine-like shells.

## Security and performance defaults

The starter applies a route-aware security baseline including CSP, clickjacking protection, content-type protection, referrer and permissions policies, production HSTS, staging/preview noindex, and no-store/noindex for sensitive paths.

The marketing site favors static/server rendering where compatible, while the security baseline uses a per-request nonce CSP and dynamic rendering for nonce-protected route groups. It does not rely on `unsafe-inline`; third-party origins are only admitted when the corresponding feature is enabled.

Performance verification runs against a production build on desktop and mobile and checks the homepage plus an indexable SEO landing page for LCP, lab interaction timing, CLS, JavaScript/image budgets, console errors, accessibility, internal links, TDH, H1, structured data, and image dimensions.

## Database migrations

Schema changes must be generated by Drizzle:

```bash
bun run db:generate
```

Do not hand-write a migration and present it as generated output.

`bun run db:verify` validates both:

- an empty database migrating to the latest schema; and
- the migration chain that existed on this PR's `main` baseline migrating forward to latest.

It then re-applies migrations to verify idempotent migration execution and checks the expected latest subscription/refund schema.

## Verification

The individual release commands are:

```bash
bun install --frozen-lockfile
bun run format:check
bun run lint
bun run typecheck
bun run test:unit
bun run test:integration
bun run test:contract
bun run db:verify
bun run test:build-matrix
bun run verify:architecture
bun run verify:secrets
bun run verify:seo
bun run verify:i18n
bun run verify:security
bun run verify:subscription
bun run verify:commerce
bun run verify:credits
bun run verify:supply-chain
bun run verify:release
bun run build
bun run verify:performance
bun run test:e2e
```

`bun run verify` is the aggregate local release gate. GitHub Actions additionally runs PostgreSQL integration, provider contract, real-page performance, and browser E2E jobs.

## Operations and recovery

Durable account deletion, payment webhook application, fulfillment, credits, subscription commands, and refund reversal all use persisted idempotency/retry state rather than in-memory background work.

Operational references:

- `docs/operations/commerce-runbook.md`
- `docs/operations/credits-runbook.md`
- existing account/auth lifecycle design and runbooks under `docs/`

Dead-letter/reconciliation states are intentional operator-visible failure modes. Do not convert them to silent success.

## Owner-only external activation items

The code can be prepared without these resources; the repository owner supplies them when a real product is activated:

- final production domain/DNS and Vercel project ownership
- Google Search Console property/submission
- real legal operator, jurisdiction, support/contact and reviewed legal text
- Better Auth production secret when Auth is enabled
- Resend API key, verified sending domain/address when Email is enabled
- Google OAuth credentials when Google Login is enabled
- Waffo merchant/store/product/webhook resources and production secrets when Commerce is enabled
- GA4 property/measurement ID and Clarity project ID when Analytics is enabled
- reviewed human translations for every enabled non-default locale

## Architecture references

The repository retains the design and Superpowers plan history for maintainers who need the deeper rationale. The current implementation remains governed by the corrected architecture/security invariants in those documents, but ordinary product launch work should start from this README and the configuration files above.

- `docs/specs/creat-web-v1-master-design.md`
- `docs/specs/auth-security-design.md`
- `docs/specs/payments-subscriptions-credits-design.md`
- `docs/specs/seo-home-legal-design.md`
- `docs/specs/quality-migration-release-design.md`
- `docs/superpowers/plans/2026-08-06-creat-web-master-execution-plan-v3.md`

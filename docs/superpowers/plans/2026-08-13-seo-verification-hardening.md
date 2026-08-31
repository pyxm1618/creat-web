# SEO Verification Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add fail-closed reviewed-SEO integrity, registry-driven rendered production SEO verification, and an analytics-enabled performance profile without changing Creat Web's existing SEO architecture.

**Architecture:** Extend the current route-registry contract with a deterministic review fingerprint, then use the existing registry as the source of truth for production browser assertions. Keep topical metrics diagnostic and deterministic. Reuse the current performance harness with a test-only analytics-enabled server profile and stubbed external provider loaders.

**Tech Stack:** TypeScript, Next.js 16 App Router, Zod, Playwright, Bun/Vitest.

## Global Constraints

- Base branch: `feat/seo-performance-i18n-platform-completion` at `2ed87103c439dc414af1730f95e371c3bf6455ae`.
- Do not change auth, commerce, credits, database migrations, payment/provider contracts, or account deletion behavior.
- Do not add new indexable routes, SEO keywords, or landing pages.
- Do not introduce a fixed keyword-density target.
- Full GitHub Actions CI is the final merge gate.

---

### Task 1: Reviewed SEO fingerprint

**Files:**
- Modify: `src/platform/seo/types.ts`
- Modify: `src/platform/seo/route-registry.ts`
- Modify: `src/config/routes.config.ts`
- Test: `src/platform/seo/route-registry.test.ts`

**Interfaces:**
- Produces: `seoReviewFingerprint(route)` and `reviewFingerprint` on reviewed indexable routes.

- [ ] Add a deterministic fingerprint over review-sensitive SEO fields.
- [ ] Add failing tests for a stale reviewed fingerprint and deterministic ordering.
- [ ] Require a matching fingerprint whenever `reviewStatus === "reviewed"`.
- [ ] Populate fingerprints for the currently reviewed indexable routes.
- [ ] Run unit tests and typecheck.

### Task 2: Registry-driven production SEO gate

**Files:**
- Modify: `tests/production/seo-production.spec.ts`

**Interfaces:**
- Consumes: `routeRegistry.indexable()` and `routeRegistry.sitemapEntries()`.

- [ ] Replace two hard-coded canonical checks with a loop over every registered indexable route.
- [ ] Verify HTTP 200, exact canonical, indexability, exact title/description, exactly one non-empty H1, and parseable JSON-LD.
- [ ] Record visible word count, exact primary-keyword occurrences, and keyword token coverage; require meaningful topical presence without enforcing density.
- [ ] Require every declared indexable `relatedRoute` to exist as a rendered anchor.
- [ ] Verify sitemap contents equal the registry exactly and public-noindex routes stay noindex/out of sitemap.
- [ ] Run production SEO Playwright.

### Task 3: Analytics-enabled performance profile

**Files:**
- Modify: `playwright.performance.config.ts`
- Modify: `tests/performance/marketing-performance.spec.ts`

**Interfaces:**
- Produces: a dedicated `analytics-on` Playwright project with test-only provider IDs and enabled feature profile.

- [ ] Add an analytics-enabled test server profile using `CREAT_WEB_E2E_ENABLED_FEATURES=1`, test-only GA4/Clarity IDs, and existing test database settings.
- [ ] Pre-grant analytics consent in the analytics-on project and stub Google/Clarity loader responses deterministically.
- [ ] Assert analytics loader requests occur only in the analytics-on profile while retaining the existing LCP/CLS/INP/script budgets.
- [ ] Run performance Playwright.

### Task 4: Full verification and PR

**Files:**
- No additional product files unless verification exposes a regression.

- [ ] Run format check, lint, typecheck, unit tests, `verify:seo`, production SEO Playwright, and performance Playwright.
- [ ] Run the complete GitHub Actions workflow on the exact branch head.
- [ ] Open a Draft PR targeting `feat/seo-performance-i18n-platform-completion` with scope, evidence, and explicit non-goals.
- [ ] Keep the PR unmerged.

# creat-web SEO, Homepage, and Legal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the reusable technical SEO system, route registry, landing-page shell, page templates, and legally configurable document framework required for SEO-first products.

**Architecture:** Every route is registered with an explicit indexability class. SEO helpers derive metadata, canonical URLs, robots, sitemap entries, and page-appropriate JSON-LD from validated project/page configuration. Homepage and legal pages use reusable components, while all keyword, operator, processor, refund, retention, and product claims remain project-owned configuration that release checks can reject when incomplete.

**Tech Stack:** Next.js Metadata API, React Server Components, Zod, Drizzle/PostgreSQL for optional legal acceptance records, Vitest, Playwright, `@axe-core/playwright`.

## Global Constraints

- Execute only after the authentication plan exit gate passes.
- Indexable primary content must exist in initial server-rendered HTML.
- Every route belongs to exactly one class: `public_indexable`, `public_noindex`, `private`, or `system`.
- Staging/preview uses layered noindex protection and never emits production canonicals or sitemap submissions.
- Legal routes default to `noindex,follow` and remain accessible from the footer.
- No hidden keyword fields, keyword stuffing, fake reviews, generic “best online tool” copy, or mass-generated thin pages.
- Schema.org data must match visible content and must escape `<` to prevent script-breaking injection.
- Release checks block placeholder domains, operator details, emails, keywords, copy, legal facts, processor disclosures, and refund/subscription mismatches.
- The starter provides technical structure; it does not promise ranking or legal compliance.

---

## File Map

- `src/config/seo.config.ts` — site-level SEO defaults.
- `src/config/routes.config.ts` — route registry and page SEO definitions.
- `src/config/legal.config.ts` — project legal facts and policy choices.
- `src/platform/seo/types.ts` — route/page/site types.
- `src/platform/seo/route-registry.ts` — validated registry.
- `src/platform/seo/canonical.ts` — canonical construction.
- `src/platform/seo/metadata.ts` — Next.js metadata factory.
- `src/platform/seo/structured-data.ts` — typed JSON-LD builders and serializer.
- `src/platform/seo/link-graph.ts` — broken/orphan-link validation.
- `src/app/robots.ts`, `src/app/sitemap.ts` — environment-aware output.
- `src/components/landing/*` — reusable homepage sections.
- `src/components/legal/*` — legal page primitives.
- `src/app/(marketing)/page.tsx` — sample/config-driven homepage.
- `src/app/(marketing)/pricing/page.tsx` — pricing shell.
- `src/app/(legal)/*` — privacy, terms, acceptable use, refund/cancellation, contact, deletion instructions.
- `src/platform/legal/types.ts`, `src/platform/legal/validate-legal-config.ts` — legal completeness and cross-checks.
- `src/platform/database/legal-schema.ts` — document acceptance records where enabled.
- `tests/unit/seo/*`, `tests/unit/legal/*`, `tests/e2e/seo.spec.ts`, `tests/e2e/legal.spec.ts`.

### Task 1: Define route classification and validated SEO configuration

**Files:**
- Create: `src/platform/seo/types.ts`
- Create: `src/platform/seo/route-registry.ts`
- Create: `src/config/seo.config.ts`
- Create: `src/config/routes.config.ts`
- Create: `tests/unit/seo/route-registry.test.ts`

**Interfaces:**
- Produces: `RouteClass`, `PageSeoDefinition`, `SiteSeoConfig`.
- Produces: `createRouteRegistry(site, routes): RouteRegistry`.
- Produces: `registry.get(route)`, `registry.indexable()`, `registry.sitemapEntries()`.

- [ ] **Step 1: Write failing registry tests**

```ts
import { describe, expect, it } from "vitest";
import { createRouteRegistry } from "@/platform/seo/route-registry";

const site = {
  siteName: "Example Tool",
  canonicalOrigin: "https://example.com",
  defaultLocale: "en",
  defaultTitle: "Example Tool",
  titleTemplate: "%s | Example Tool",
  defaultDescription: "A precise description of the example tool.",
  defaultOgImage: "/og/default.png",
};

const routes = [
  {
    route: "/",
    class: "public_indexable" as const,
    searchIntent: "use the example tool",
    primaryKeyword: "example tool",
    title: "Example Tool",
    description: "Use the example tool and understand how it works.",
    h1: "Example Tool",
    pageType: "WebApplication" as const,
    relatedRoutes: ["/guide"],
    lastModified: "2026-08-06",
  },
  { route: "/account", class: "private" as const },
];

describe("route registry", () => {
  it("returns only public indexable routes for sitemap", () => {
    const registry = createRouteRegistry(site, routes);
    expect(registry.sitemapEntries().map((entry) => entry.route)).toEqual(["/"]);
  });

  it("rejects duplicate canonicals", () => {
    expect(() => createRouteRegistry(site, [...routes, { ...routes[0], route: "/duplicate" }])).toThrow("duplicate canonical");
  });

  it("rejects indexable routes without intent, keyword, H1, related routes, or last-modified source", () => {
    expect(() => createRouteRegistry(site, [{ route: "/thin", class: "public_indexable" }])).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun run test:unit -- tests/unit/seo/route-registry.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement strict route types and validation**

```ts
// src/platform/seo/types.ts
export type RouteClass = "public_indexable" | "public_noindex" | "private" | "system";
export type PageType = "WebSite" | "WebApplication" | "SoftwareApplication" | "Article" | "Pricing" | "Legal";

export type SiteSeoConfig = {
  siteName: string;
  canonicalOrigin: string;
  defaultLocale: string;
  defaultTitle: string;
  titleTemplate: string;
  defaultDescription: string;
  defaultOgImage: string;
};

export type IndexablePage = {
  route: string;
  class: "public_indexable";
  searchIntent: string;
  primaryKeyword: string;
  secondaryKeywords?: string[];
  title: string;
  description: string;
  h1: string;
  canonical?: string;
  image?: string;
  pageType: Exclude<PageType, "Legal">;
  relatedRoutes: string[];
  lastModified: string;
};

export type NonIndexablePage = {
  route: string;
  class: Exclude<RouteClass, "public_indexable">;
  pageType?: "Legal";
};

export type RouteDefinition = IndexablePage | NonIndexablePage;
```

The registry uses Zod discriminated unions, normalizes trailing slashes, constructs default canonicals, rejects duplicate routes/canonicals/titles, and validates all related routes exist.

- [ ] **Step 4: Add initial configuration**

`routes.config.ts` registers `/` as indexable; `/pricing` according to actual product policy; `/sign-in`, legal routes, and checkout status as public noindex; `/account` as private; `/api/*` as system. The sample config is explicitly marked `releaseStatus: "draft"` so production verification fails until a real project replaces it.

- [ ] **Step 5: Run tests and commit**

Run: `bun run test:unit -- tests/unit/seo/route-registry.test.ts`

Expected: PASS.

```bash
git add src/platform/seo/types.ts src/platform/seo/route-registry.ts src/config/seo.config.ts src/config/routes.config.ts tests/unit/seo/route-registry.test.ts
git commit -m "feat: add explicit SEO route registry"
```

### Task 2: Implement canonical and metadata factories

**Files:**
- Create: `src/platform/seo/canonical.ts`
- Create: `src/platform/seo/metadata.ts`
- Create: `tests/unit/seo/canonical.test.ts`
- Create: `tests/unit/seo/metadata.test.ts`
- Modify: `src/app/layout.tsx`

**Interfaces:**
- Produces: `canonicalUrl(site, route, query?): string`.
- Produces: `metadataForRoute(registry, route): Metadata`.

- [ ] **Step 1: Write failing canonical tests**

```ts
import { expect, it } from "vitest";
import { canonicalUrl } from "@/platform/seo/canonical";

it("normalizes origin, path and strips tracking parameters", () => {
  expect(
    canonicalUrl("https://example.com/", "/guide/", new URLSearchParams("utm_source=x&ref=y")),
  ).toBe("https://example.com/guide");
});

it("rejects a canonical outside the configured origin", () => {
  expect(() => canonicalUrl("https://example.com", "https://evil.example/page")).toThrow("canonical origin mismatch");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun run test:unit -- tests/unit/seo/canonical.test.ts tests/unit/seo/metadata.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement canonical construction**

```ts
export function canonicalUrl(originInput: string, routeInput: string, _query?: URLSearchParams): string {
  const origin = new URL(originInput);
  const candidate = new URL(routeInput, origin);
  if (candidate.origin !== origin.origin) throw new Error("canonical origin mismatch");
  const pathname = candidate.pathname === "/" ? "/" : candidate.pathname.replace(/\/+$/, "").toLowerCase();
  return new URL(pathname, origin).toString().replace(/\/$/, pathname === "/" ? "/" : "");
}
```

`metadataForRoute` returns title, description, alternates.canonical, openGraph, twitter, and route-class robots. Private/system routes receive `noindex,nofollow`; public noindex routes receive `noindex,follow`.

- [ ] **Step 4: Wire root metadata from configuration**

`src/app/layout.tsx` imports site config only; it does not hard-code Vercel, Quick I Ching, author handles, locale, or domain.

- [ ] **Step 5: Run tests/build and commit**

Run:

```bash
bun run test:unit -- tests/unit/seo
bun run build
```

Expected: PASS.

```bash
git add src/platform/seo/canonical.ts src/platform/seo/metadata.ts tests/unit/seo src/app/layout.tsx
git commit -m "feat: generate canonical and route metadata"
```

### Task 3: Implement environment-aware robots, sitemap, and response noindex

**Files:**
- Create: `src/app/robots.ts`
- Create: `src/app/sitemap.ts`
- Create: `src/platform/seo/environment-policy.ts`
- Create: `tests/unit/seo/environment-policy.test.ts`
- Create: `tests/e2e/seo.spec.ts`
- Modify: `next.config.ts`

**Interfaces:**
- Produces: `seoEnvironmentPolicy(mode, deploymentUrl): SeoEnvironmentPolicy`.
- Produces production sitemap exclusively from registry indexable entries.

- [ ] **Step 1: Write failing policy tests**

```ts
import { expect, it } from "vitest";
import { seoEnvironmentPolicy } from "@/platform/seo/environment-policy";

it("forces preview and staging to noindex", () => {
  expect(seoEnvironmentPolicy("staging")).toEqual({ index: false, follow: false, emitSitemap: false });
  expect(seoEnvironmentPolicy("production")).toEqual({ index: true, follow: true, emitSitemap: true });
});
```

E2E asserts `/robots.txt` and `/sitemap.xml` contain only policy-approved URLs.

- [ ] **Step 2: Run to verify failure**

Run: `bun run test:unit -- tests/unit/seo/environment-policy.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement policy, robots, sitemap, and header protection**

`robots.ts` uses the deployment mode. `sitemap.ts` maps only `registry.sitemapEntries()` and uses configured `lastModified` values, never build time. `next.config.ts` adds `X-Robots-Tag: noindex, nofollow` to all paths in staging/preview while production uses per-page metadata.

- [ ] **Step 4: Run unit/build/E2E tests**

Run:

```bash
bun run test:unit -- tests/unit/seo/environment-policy.test.ts
bun run build
bun run test:e2e -- tests/e2e/seo.spec.ts
```

Expected: PASS; legal/private/system routes are absent from sitemap.

- [ ] **Step 5: Commit**

```bash
git add src/app/robots.ts src/app/sitemap.ts src/platform/seo/environment-policy.ts tests/unit/seo/environment-policy.test.ts tests/e2e/seo.spec.ts next.config.ts
git commit -m "feat: add environment-safe robots and sitemap"
```

### Task 4: Add typed, injection-safe structured data

**Files:**
- Create: `src/platform/seo/structured-data.ts`
- Create: `src/components/seo/json-ld.tsx`
- Create: `tests/unit/seo/structured-data.test.ts`

**Interfaces:**
- Produces builders `websiteJsonLd`, `webApplicationJsonLd`, `articleJsonLd`, `breadcrumbJsonLd`, `offerJsonLd`.
- Produces `serializeJsonLd(value): string`.

- [ ] **Step 1: Write failing serialization tests**

```ts
import { expect, it } from "vitest";
import { serializeJsonLd, webApplicationJsonLd } from "@/platform/seo/structured-data";

it("escapes script-breaking user text", () => {
  expect(serializeJsonLd({ name: "</script><script>alert(1)</script>" })).not.toContain("</script>");
});

it("requires visible offer data before emitting price", () => {
  expect(() => webApplicationJsonLd({ name: "Tool", url: "https://example.com", visiblePrice: false, price: "9.00", currency: "USD" })).toThrow("visible offer required");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun run test:unit -- tests/unit/seo/structured-data.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement serializer and accurate builders**

```ts
export function serializeJsonLd(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}
```

Each builder accepts only fields shown on the page. Review/rating fields are absent from v1. FAQ markup is not emitted by default.

- [ ] **Step 4: Run tests and commit**

Run: `bun run test:unit -- tests/unit/seo/structured-data.test.ts`

Expected: PASS.

```bash
git add src/platform/seo/structured-data.ts src/components/seo/json-ld.tsx tests/unit/seo/structured-data.test.ts
git commit -m "feat: add accurate injection-safe JSON-LD"
```

### Task 5: Add internal-link graph validation and navigation primitives

**Files:**
- Create: `src/platform/seo/link-graph.ts`
- Create: `src/components/navigation/site-header.tsx`
- Create: `src/components/navigation/site-footer.tsx`
- Create: `src/components/navigation/breadcrumbs.tsx`
- Create: `src/components/navigation/related-links.tsx`
- Create: `tests/unit/seo/link-graph.test.ts`

**Interfaces:**
- Produces: `validateLinkGraph(registry, links): LinkGraphReport`.

- [ ] **Step 1: Write failing orphan/broken-link tests**

```ts
import { expect, it } from "vitest";
import { validateLinkGraph } from "@/platform/seo/link-graph";

it("reports broken targets and orphan indexable routes", () => {
  const report = validateLinkGraph(
    ["/", "/guide"],
    [{ from: "/", to: "/missing" }],
  );
  expect(report.broken).toEqual(["/missing"]);
  expect(report.orphans).toEqual(["/guide"]);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun run test:unit -- tests/unit/seo/link-graph.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement graph validation and semantic links**

All navigation primitives use Next.js `Link` with real `href`, descriptive anchor text, keyboard focus styles, and explicit `rel` support for `nofollow`, `ugc`, and `sponsored`.

- [ ] **Step 4: Run tests and commit**

Run: `bun run test:unit -- tests/unit/seo/link-graph.test.ts`

Expected: PASS.

```bash
git add src/platform/seo/link-graph.ts src/components/navigation tests/unit/seo/link-graph.test.ts
git commit -m "feat: add internal-link graph and navigation primitives"
```

### Task 6: Build composable homepage and public page shells

**Files:**
- Create: `src/components/landing/landing-page.tsx`
- Create: `src/components/landing/hero-section.tsx`
- Create: `src/components/landing/tool-demo-section.tsx`
- Create: `src/components/landing/use-cases-section.tsx`
- Create: `src/components/landing/how-it-works-section.tsx`
- Create: `src/components/landing/features-section.tsx`
- Create: `src/components/landing/pricing-section.tsx`
- Create: `src/components/landing/faq-section.tsx`
- Create: `src/components/landing/seo-content-section.tsx`
- Create: `src/components/landing/final-cta-section.tsx`
- Move/Modify: `src/app/page.tsx` to `src/app/(marketing)/page.tsx`
- Create: `src/app/(marketing)/pricing/page.tsx`
- Create: `tests/e2e/homepage.spec.ts`

**Interfaces:**
- Produces: `LandingSection` discriminated union and `LandingPage({ sections })`.
- Consumes route registry metadata and project-owned content.

- [ ] **Step 1: Write failing homepage E2E**

```ts
import { expect, test } from "@playwright/test";

test("homepage has server-rendered intent, one H1, meaningful links and no generic claims", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  await expect(page.locator("h1")).toHaveCount(1);
  await expect(page.getByRole("main")).toContainText(/sample product purpose/i);
  await expect(page.locator("a[href='/pricing']")).toBeVisible();
  await expect(page.getByText(/best online tool/i)).toHaveCount(0);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun run test:e2e -- tests/e2e/homepage.spec.ts`

Expected: FAIL.

- [ ] **Step 3: Implement small focused section components**

```ts
export type LandingSection =
  | { type: "hero"; eyebrow?: string; h1: string; body: string; primaryCta: { label: string; href: string }; secondaryCta?: { label: string; href: string } }
  | { type: "tool-demo"; title: string; body: string; render: React.ReactNode }
  | { type: "use-cases"; title: string; items: Array<{ title: string; body: string; href?: string }> }
  | { type: "how-it-works"; title: string; steps: Array<{ title: string; body: string }> }
  | { type: "features"; title: string; items: Array<{ title: string; body: string }> }
  | { type: "pricing"; title: string }
  | { type: "faq"; title: string; items: Array<{ question: string; answer: string }> }
  | { type: "seo-content"; heading: string; body: React.ReactNode }
  | { type: "final-cta"; heading: string; body: string; cta: { label: string; href: string } };
```

The sample homepage is intentionally neutral and visibly marked draft in configuration. It demonstrates component composition without copying Quick I Ching layout, copy, colors, methods, or imagery.

- [ ] **Step 4: Run E2E/build and commit**

Run:

```bash
bun run test:e2e -- tests/e2e/homepage.spec.ts
bun run build
```

Expected: PASS.

```bash
git add src/components/landing src/app/'(marketing)' tests/e2e/homepage.spec.ts
git commit -m "feat: add reusable landing and pricing shells"
```

### Task 7: Define legal facts, validation, and provider cross-checks

**Files:**
- Create: `src/platform/legal/types.ts`
- Create: `src/platform/legal/validate-legal-config.ts`
- Create: `src/config/legal.config.ts`
- Create: `tests/unit/legal/validate-legal-config.test.ts`

**Interfaces:**
- Produces: `validateLegalConfig({ legal, features, processors, products }): LegalConfig`.

- [ ] **Step 1: Write failing cross-check tests**

```ts
import { expect, it } from "vitest";
import { validateLegalConfig } from "@/platform/legal/validate-legal-config";

it("requires disclosures for every enabled provider", () => {
  expect(() =>
    validateLegalConfig({
      features: { google: true, magicLink: true, waffo: true, ga4: true },
      legal: { processors: [] },
    } as never),
  ).toThrow("missing processor disclosure: Google");
});

it("rejects subscription products without cancellation terms", () => {
  expect(() =>
    validateLegalConfig({
      features: { subscriptions: true },
      legal: { subscriptionTerms: null },
    } as never),
  ).toThrow("subscription cancellation terms are required");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun run test:unit -- tests/unit/legal/validate-legal-config.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement legal configuration types and validation**

Types include operator identity, jurisdiction, contacts, minimum age, data categories, auth methods, processors, analytics, payment model (`mor | psp | none`), one-time/subscription/credit rules, refund/cancellation summary, retention rules, account deletion, international transfers, document versions, and review status.

Validation maps enabled Google, Resend, Waffo, GA4, Clarity, Turnstile, hosting, database, storage, and AI providers to required disclosures. It rejects `example.com`, `support@example.com`, `CHANGE_ME`, missing effective dates, and draft review status in production release mode.

- [ ] **Step 4: Run tests and commit**

Run: `bun run test:unit -- tests/unit/legal/validate-legal-config.test.ts`

Expected: PASS.

```bash
git add src/platform/legal src/config/legal.config.ts tests/unit/legal
git commit -m "feat: validate legal facts against enabled services"
```

### Task 8: Implement reusable legal routes and versioned acceptance records

**Files:**
- Create: `src/components/legal/legal-document.tsx`
- Create: `src/components/legal/legal-section.tsx`
- Create: `src/app/(legal)/privacy/page.tsx`
- Create: `src/app/(legal)/terms/page.tsx`
- Create: `src/app/(legal)/acceptable-use/page.tsx`
- Create: `src/app/(legal)/refund-policy/page.tsx`
- Create: `src/app/(legal)/contact/page.tsx`
- Create: `src/app/(legal)/account-deletion/page.tsx`
- Create: `src/platform/database/legal-schema.ts`
- Create: `src/platform/legal/acceptance.ts`
- Create: migration under `drizzle/`
- Create: `tests/integration/legal/acceptance.test.ts`
- Create: `tests/e2e/legal.spec.ts`

**Interfaces:**
- Produces: `recordLegalAcceptance({ userId, document, version, source }): Promise<void>` with unique idempotency key.

- [ ] **Step 1: Write failing legal E2E and acceptance tests**

E2E asserts every legal page returns 200, contains effective date/version, is linked from footer, has `noindex,follow`, and contains no Quick I Ching terms. Integration test records the same acceptance twice and asserts one row exists.

- [ ] **Step 2: Run to verify failure**

Run:

```bash
TEST_DATABASE_URL="$TEST_DATABASE_URL" bun run test:integration -- tests/integration/legal/acceptance.test.ts
bun run test:e2e -- tests/e2e/legal.spec.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement legal page primitives and reviewed document inputs**

Each route builds from project-owned document sections and legal facts. Do not synthesize universal final legal language from feature flags alone. Development/sample copy is marked draft in config; `verify-release` blocks it from production.

- [ ] **Step 4: Implement idempotent acceptance storage**

Schema fields: user ID, document key, version, accepted timestamp, source context, and unique `(user_id, document_key, version)` constraint. Do not store IP by default.

- [ ] **Step 5: Run tests and commit**

Run:

```bash
TEST_DATABASE_URL="$TEST_DATABASE_URL" bun run test:integration -- tests/integration/legal/acceptance.test.ts
bun run test:e2e -- tests/e2e/legal.spec.ts
```

Expected: PASS.

```bash
git add src/components/legal src/app/'(legal)' src/platform/database/legal-schema.ts src/platform/legal/acceptance.ts drizzle tests/integration/legal tests/e2e/legal.spec.ts
git commit -m "feat: add versioned legal document framework"
```

### Task 9: Add automated SEO, accessibility, mobile, and release gates

**Files:**
- Modify: `package.json`
- Modify: `scripts/verify-release.ts`
- Create: `scripts/verify-seo.ts`
- Create: `tests/e2e/accessibility.spec.ts`
- Create: `docs/setup/seo-launch-checklist.md`
- Create: `docs/setup/legal-launch-checklist.md`

**Interfaces:**
- Produces: `bun run verify:seo`.

- [ ] **Step 1: Install accessibility test dependency**

Run: `bun add --dev --exact @axe-core/playwright@latest`

- [ ] **Step 2: Implement release verification**

`verify-seo.ts` imports the route registry and link graph, then fails on duplicate metadata/canonical, missing indexable fields, sitemap mismatch, broken/orphan links, placeholder content, invalid last-modified dates, external canonicals, or private routes marked indexable.

`verify-release.ts` additionally fails if legal review status is draft, enabled providers lack disclosure, subscription/refund/credit configuration conflicts with legal text facts, or production domain/operator/contact values remain examples.

- [ ] **Step 3: Add browser checks**

Representative desktop/mobile tests assert:

- one intended H1;
- initial HTML contains primary content before hydration;
- canonical and robots are correct;
- JSON-LD parses;
- no horizontal overflow at 375px;
- keyboard can reach header, primary CTA, tool form, footer, and consent settings;
- axe reports no serious/critical violations;
- 404 returns 404 rather than a soft success page.

- [ ] **Step 4: Run the full gate**

Run:

```bash
bun run format:check
bun run lint
bun run typecheck
bun run test:unit
TEST_DATABASE_URL="$TEST_DATABASE_URL" bun run test:integration
bun run build
bun run test:e2e -- tests/e2e/seo.spec.ts tests/e2e/homepage.spec.ts tests/e2e/legal.spec.ts tests/e2e/accessibility.spec.ts
bun run verify:seo
bun run verify:release
```

Expected: all commands exit `0` in test mode; production release mode intentionally fails until a real project's SEO/legal facts are supplied.

- [ ] **Step 5: Commit**

```bash
git add package.json bun.lock scripts/verify-seo.ts scripts/verify-release.ts tests/e2e/accessibility.spec.ts docs/setup/seo-launch-checklist.md docs/setup/legal-launch-checklist.md
git commit -m "test: enforce SEO legal accessibility release gates"
```

## SEO/Home/Legal Exit Gate

Before requesting review, prove:

- every route is classified exactly once;
- only approved public routes enter the sitemap;
- indexable pages render primary content in initial HTML;
- unique title, description, canonical, H1, and internal links pass automated checks;
- staging/preview emits layered noindex protection and no production sitemap;
- JSON-LD is injection-safe and mirrors visible facts;
- homepage/public templates contain no Quick I Ching or generic “best tool” copy;
- orphan/broken-link checks pass;
- mobile and accessibility tests pass;
- legal pages are versioned, linked, noindex, and project-configured;
- enabled providers and payment models match legal disclosures;
- production release remains blocked until real keyword, domain, operator, processor, retention, refund, and policy inputs are human-reviewed.

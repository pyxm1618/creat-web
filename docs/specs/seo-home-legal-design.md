# SEO, homepage, and legal foundation design

- Status: proposed for independent review
- Product priority: SEO-first overseas web products
- Principle: technical SEO is built into the starter; keyword strategy and content remain project work

## 1. Decision

SEO is treated as a release policy spanning rendering, crawlability, metadata, URL design, internal links, structured data, mobile usability, performance, and content configuration. It is not reduced to a `title` helper.

The starter will solve three different layers separately:

1. **Technical foundation** — implemented once in creat-web.
2. **Project SEO configuration** — completed for each new product before launch.
3. **Ongoing SEO operations** — performed after launch using real query, content, link, and conversion data.

The starter also provides a reusable homepage shell and legal-document system, but neither ships as generic final copy.

## 2. Practical SEO research position

The design uses Google Search and Next.js documentation as technical authority. Practical material from 哥飞/Web.Cafe is used as product/operation guidance, especially these recurring principles:

- build around real search demand and specific keywords;
- make each page’s title, H1, body, and intent consistent;
- do not rely on client-only rendering for the text search engines need to understand;
- create useful inner pages for distinct search intents rather than forcing every query onto the homepage;
- internal links are part of page discovery and authority distribution;
- external-link acquisition is primarily an operating/growth activity, not something the starter can complete automatically;
- new sites should avoid mass-producing low-value pages merely because generation is technically easy.

These are implemented as safeguards and page requirements, not as promises of ranking.

## 3. Route classification

Every route belongs to exactly one class.

### 3.1 Public and indexable

Examples:

- homepage;
- SEO tool/feature landing pages;
- guides and tutorials;
- use-case pages;
- selected pricing pages;
- blog/article pages where enabled.

Requirements:

- server-rendered or statically generated primary content;
- unique title, description, canonical, and H1;
- valid status code;
- inclusion in sitemap when active;
- at least one meaningful internal link from another discoverable page;
- no private/user-specific content.

### 3.2 Public but noindex

Examples:

- legal pages by default;
- sign-in/sign-up pages;
- checkout return/status pages;
- support forms;
- duplicate utility states not intended for search.

Requirements:

- `noindex,follow` unless a stricter policy is justified;
- excluded from sitemap;
- still accessible and linked where users need them;
- must not be blocked in robots if search engines need to see the `noindex` directive.

### 3.3 Authenticated/private

Examples:

- account;
- billing history;
- saved results;
- subscription portal;
- personal tool output.

Requirements:

- authentication and server-side authorization;
- `noindex,nofollow` or equivalent response policy;
- excluded from sitemap and public navigation;
- no private data in metadata or structured data;
- caching policy appropriate to user-specific content.

### 3.4 System/internal

Examples:

- API routes;
- webhooks;
- cron/worker endpoints;
- health endpoints where not intentionally public;
- preview/staging routes.

Requirements:

- not indexable;
- authenticated or protected according to function;
- excluded from user-facing SEO systems.

## 4. Rendering requirements

For indexable pages:

- primary explanatory text must be present in initial HTML;
- H1 and essential page content must not wait for client-side JavaScript;
- interactive tools may hydrate on the client, but an understandable server-rendered explanation and form shell must remain;
- loading states must not replace indexable content at crawl time;
- dynamic pages need deterministic fallback/error/404 behavior;
- content hidden solely for search engines is prohibited.

React Server Components are the default. Client components are introduced only for interaction.

## 5. Metadata system

### 5.1 Site configuration

Required project-level fields:

```ts
type SiteSeoConfig = {
  siteName: string;
  legalName?: string;
  canonicalOrigin: string;
  defaultLocale: string;
  supportedLocales: string[];
  defaultTitle: string;
  titleTemplate: string;
  defaultDescription: string;
  defaultOgImage: string;
  publisher: PersonOrOrganization;
  socialProfiles?: string[];
};
```

Production validation rejects localhost, HTTP production origins, placeholder names, and missing defaults.

### 5.2 Page configuration

Every indexable page supplies:

```ts
type PageSeo = {
  route: string;
  searchIntent: string;
  primaryKeyword: string;
  secondaryKeywords?: string[];
  title: string;
  description: string;
  h1: string;
  canonical?: string;
  image?: string;
  index: true;
  pageType: PageType;
  relatedRoutes: string[];
  lastModifiedSource: LastModifiedSource;
};
```

The primary keyword and search intent are planning fields. They are not dumped into hidden meta tags or mechanically repeated.

### 5.3 Consistency checks

CI or content tests should flag:

- duplicate titles/descriptions/canonicals;
- missing or multiple H1s where not deliberately designed;
- title/H1/content intent mismatch;
- production placeholder text;
- title or description outside configurable guidance ranges;
- canonical outside the approved origin;
- Open Graph image missing/broken;
- indexable route omitted from sitemap;
- disabled/private route included in sitemap;
- metadata containing user-specific content.

Length checks are editorial warnings, not claims that Google always displays a fixed number of characters.

## 6. Canonical and URL policy

- one canonical production origin;
- HTTPS only in production;
- stable lowercase URL conventions;
- no duplicate trailing-slash behavior;
- query parameters are classified as functional, tracking, filtering, or indexable;
- tracking parameters canonicalize to the clean URL;
- filter/search combinations default to noindex unless explicitly approved as valuable landing pages;
- redirects are centralized and tested;
- deleted content returns 404 or 410 according to policy, not a soft-404 success page;
- canonical must not point to an unrelated page merely to suppress duplicates.

## 7. Robots and environment isolation

### 7.1 Production

`robots.ts` permits normal crawling of public content and disallows crawling of sensitive/system paths where appropriate. Robots rules are not treated as access control.

### 7.2 Staging and previews

Staging/preview deployments must combine:

- environment-level authentication or access control where feasible;
- `X-Robots-Tag: noindex, nofollow` or page-level equivalent;
- robots policy blocking broad crawling;
- non-production canonical/origin safeguards;
- no production sitemap submission;
- no live analytics or live payment products.

A single robots rule is not considered sufficient protection for confidential previews.

## 8. Sitemap design

The sitemap includes only active, canonical, public, indexable URLs.

Rules:

- source routes from explicit registries/content repositories, not naive directory scanning alone;
- use meaningful `lastModified` data from content/product records;
- do not set every page’s update time to the current build time;
- exclude auth, account, legal-noindex, checkout, result, API, and disabled routes;
- split into multiple sitemaps only when volume requires it;
- multilingual variants use consistent locale/canonical/hreflang logic;
- sitemap generation failures block production release.

## 9. Structured data

Provide typed helpers for page-appropriate JSON-LD, initially:

- `WebSite`;
- `Organization` or `Person`;
- `SoftwareApplication` / `WebApplication` when accurate;
- `Article`;
- `BreadcrumbList`;
- `Product` or `Offer` only when price/product facts match visible content;
- FAQ structured data only where current search-engine rules and visible page content justify it.

Rules:

- structured data mirrors visible facts;
- no review/rating markup without real eligible reviews;
- no misleading product/pricing data;
- serialize safely and prevent user content from injecting script-breaking values;
- validate representative pages using supported testing tools before release.

## 10. Internal-link architecture

The starter provides technical components and checks:

- semantic `<a href>` links through Next.js `Link`;
- Header and Footer navigation;
- breadcrumbs;
- related tools/pages/articles section;
- contextual link component with descriptive anchor text;
- optional topic/category hubs;
- orphan-page detection for indexable pages;
- broken internal-link checks;
- link policy for `nofollow`, `ugc`, and `sponsored` where appropriate.

The starter cannot decide the best business/topic link graph automatically. Each project supplies related routes and editorial links based on its keyword/content architecture.

## 11. Mobile, performance, and accessibility

### 11.1 Mobile-first requirements

- responsive single-site design rather than a separate `m.` site;
- equivalent primary content and metadata on mobile and desktop;
- touch-friendly controls;
- no interaction requiring hover only;
- readable typography and appropriate viewport configuration;
- tool input/output usable at common narrow widths;
- no full-screen intrusive interstitial blocking initial use.

### 11.2 Performance budgets

Initial field-performance goals at the 75th percentile:

- LCP at or below 2.5 seconds;
- INP at or below 200 milliseconds;
- CLS at or below 0.1.

Build/lab checks additionally track JavaScript size, image dimensions, font loading, render-blocking resources, and server response. Lab success is not treated as proof of field success.

### 11.3 Technical defaults

- Next.js image/font optimization where suitable;
- explicit image width/height or aspect ratio;
- minimal client JavaScript on SEO pages;
- lazy-load below-the-fold noncritical UI;
- avoid third-party scripts before consent or necessity;
- semantic headings, labels, focus states, keyboard support, and contrast;
- error/loading states that remain accessible.

## 12. Homepage system

### 12.1 What the starter provides

A composable, code-based landing-page shell:

```text
Header
Hero
Primary tool/demo
Trust/proof
Use cases
How it works
Benefits/features
Pricing
FAQ
SEO explanatory content
Final CTA
Footer
```

Each section is optional and reorderable through code/configuration. The shell provides layout, responsive behavior, accessibility, and metadata hooks.

### 12.2 What each project must provide

- brand and visual direction;
- target audience;
- primary keyword and search intent;
- H1/value proposition;
- actual product demo/tool interaction;
- proof and claims that can be substantiated;
- use cases and benefits;
- pricing/product mapping;
- FAQ based on real questions;
- internal links;
- final CTA.

No generic “best online tool” copy may ship to production.

### 12.3 Homepage versus inner SEO pages

The homepage targets the brand and principal product intent. Distinct search intents should receive dedicated inner pages when the content/tool experience genuinely differs. The starter supports route/page templates but does not mass-generate thin keyword variants.

## 13. Reusable page templates

V1 should provide patterns/components for:

- homepage;
- SEO tool landing page;
- content/tutorial page;
- pricing page;
- sign-in/account shell;
- legal page;
- contact/support page;
- 404 and error pages;
- optional blog index/article after blog is enabled.

Templates are structural. Final design and copy remain product-specific.

## 14. Project SEO launch inputs

Before a production launch, the project must supply:

- brand/site name and domain;
- target market and language;
- primary and secondary keyword map;
- search intent per indexable route;
- page titles, H1s, descriptions, and body copy;
- route/canonical map;
- internal-link map;
- index/noindex decisions;
- structured-data type per page;
- real last-modified source;
- Open Graph assets;
- Search Console verification/submission plan;
- analytics measurement plan separate from ranking assumptions.

This is more than filling API keys. The starter makes missing inputs visible and blocks unsafe placeholders, but it cannot invent validated positioning.

## 15. Ongoing SEO operations

Outside the starter’s one-time technical scope:

- keyword and competitor research;
- content creation and updates;
- Search Console query/index monitoring;
- CTR experiments;
- link acquisition and digital PR;
- community distribution;
- conversion analysis;
- pruning/merging weak pages;
- localization quality;
- responding to search-engine changes.

External-link acquisition is primarily an operating activity. The technical starter only supports safe outbound-link attributes and prevents user-generated link abuse.

## 16. Legal-document system

### 16.1 Required pages/capabilities

V1 provides reusable routes/layouts for:

- Privacy Policy;
- Terms of Service;
- Acceptable Use Policy;
- Refund and Cancellation Policy, either standalone or incorporated explicitly;
- Cookie/Analytics Settings;
- Contact/Support;
- Account Deletion and data-rights instructions.

### 16.2 Legal configuration

Required project facts include:

```ts
type LegalConfig = {
  operatorIdentity: OperatorIdentity;
  governingJurisdiction: string;
  supportContact: string;
  privacyContact: string;
  minimumAge: number;
  authMethods: string[];
  dataCategories: string[];
  userContent: boolean;
  aiProcessing: boolean;
  processors: ProcessorDisclosure[];
  analytics: AnalyticsDisclosure[];
  paymentModel: "mor" | "psp" | "none";
  oneTimePurchases: boolean;
  subscriptions: boolean;
  credits: boolean;
  refundPolicy: RefundPolicySummary;
  retentionRules: RetentionRule[];
  accountDeletion: AccountDeletionPolicy;
  internationalTransfers: InternationalTransferDisclosure;
};
```

Feature/service configuration and legal configuration are cross-checked. For example, enabling Google, Resend, Waffo, GA4, Clarity, Turnstile, AI providers, or cloud storage requires corresponding accurate disclosure where applicable.

### 16.3 Reusable versus non-reusable

Reusable:

- legal layout and typography;
- section/table/list components;
- dates and document versions;
- footer/account links;
- document change history;
- optional acceptance record mechanism;
- configuration completeness checks;
- safe metadata and accessibility.

Not safely reusable without review:

- operator identity;
- exact collected data;
- service-provider list;
- retention periods;
- refund/cancellation promises;
- subscription/credit terms;
- AI disclaimers;
- governing law/dispute language;
- consumer-rights statements;
- product-specific risk warnings.

Quick I Ching legal copy must not be copied as a universal policy.

### 16.4 Versioning and acceptance

- every published policy has an effective date and version;
- material changes are recorded;
- explicit acceptance is stored only when product/legal design requires it;
- acceptance record includes user, document/version, timestamp, and source context without excessive tracking;
- policy changes do not silently rewrite historical transaction terms;
- old versions are retained for operator/audit access where needed.

### 16.5 Legal review warning

The starter can produce a complete draft and consistency checklist, not a legal guarantee. Projects with substantial revenue, sensitive data, regulated use cases, broad consumer reach, or nonstandard refund/subscription policies should receive qualified legal review before launch.

## 17. Consent and analytics

- essential authentication/security/payment storage is separated from optional analytics;
- GA4/Clarity or similar optional scripts do not load before required consent;
- rejecting analytics does not block core product use;
- consent can be changed later;
- analytics event schemas prohibit email, private user content, auth tokens, payment details, and generated private results;
- staging analytics is disabled or isolated;
- legal disclosure and actual technical behavior must match.

## 18. Automated test and release checks

### 18.1 Metadata/HTML

- unique title/description/canonical;
- one intended H1;
- correct robots directive;
- server-rendered primary content;
- valid Open Graph data;
- JSON-LD parses and matches visible content;
- no private content in HTML head.

### 18.2 Crawl/link

- sitemap contains exactly approved routes;
- robots and noindex do not contradict policy;
- all indexable pages have inbound internal links;
- no broken internal links;
- redirects terminate without loops;
- 404s return correct status;
- staging has noindex protections.

### 18.3 Performance/accessibility

- Lighthouse or equivalent budgets for representative pages;
- bundle-size thresholds;
- responsive E2E at selected mobile/desktop viewports;
- keyboard navigation and form-label checks;
- no layout shift from required images/fonts/components;
- consent banner does not trap or block normal access.

### 18.4 Legal/configuration

- no placeholder operator/domain/email;
- provider disclosures match enabled integrations;
- refund/subscription/credit wording matches configured product behavior;
- current effective dates and versions;
- all required footer/account links work.

## 19. Acceptance criteria

SEO/home/legal foundation is production-ready only when:

- every public route is classified;
- indexable pages render meaningful initial HTML;
- metadata, canonical, robots, sitemap, and structured data pass automated checks;
- staging cannot be accidentally indexed;
- homepage and page templates contain no generic placeholder claims;
- mobile and performance budgets pass representative tests;
- internal-link/orphan-page checks pass;
- legal configuration matches actual enabled services and commerce behavior;
- a human project review confirms keywords, intent, copy, operator facts, and policy choices.

## 20. References

Technical authority:

- https://nextjs.org/docs
- https://developers.google.com/search/docs
- https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics
- https://developers.google.com/search/docs/appearance/title-link
- https://developers.google.com/search/docs/appearance/snippet
- https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls
- https://developers.google.com/search/docs/crawling-indexing/robots/intro
- https://developers.google.com/search/docs/appearance/structured-data/intro-structured-data
- https://web.dev/articles/vitals

Practical SEO/product references:

- https://new.web.cafe/tutorial/7c36c9a7c6e34d21b8f3efd857d980aa
- https://new.web.cafe/
- 哥飞 material indexed around SEO-friendly rendering, TDK/TDH, canonical, internal links, keyword-driven inner pages, and avoiding low-value bulk page generation

# creat-web v1 master design

- Status: proposed for independent review
- Date: 2026-08-06
- Implementation status: blocked
- Target: private internal starter, with a future path to commercialization

## 1. Executive decision

`creat-web v1` will be a **single Next.js App Router application implemented as a modular monolith**. It will provide a production-grade reusable foundation for overseas, SEO-dependent products without becoming a public visual site builder or a runtime plugin platform.

The starter will include:

- Next.js, TypeScript strict mode, React Server Components by default;
- PostgreSQL and Drizzle migrations;
- technical SEO infrastructure and release checks;
- Google sign-in and magic-link sign-in through Better Auth;
- Waffo one-time payments and subscriptions;
- an internal, provider-independent credit ledger;
- reusable landing-page, account, pricing, and legal-page shells;
- analytics consent, security controls, observability, CI, and staging gates.

Only Waffo and Better Auth are implemented in v1. Their use is isolated behind stable internal boundaries, but v1 will not build a general multi-provider plugin system.

## 2. Immutable boundary

`pyxm1618/quickiching` is a read-only reference repository.

The creat-web project must not:

- modify Quick I Ching;
- create a Quick I Ching refactoring branch;
- move generic code inside Quick I Ching first;
- make Quick I Ching depend on creat-web during v1;
- claim that copied Quick I Ching code is generic without redesign and tests.

Useful patterns may be inspected, then rewritten or parameterized only inside `pyxm1618/creat-web`.

## 3. Goals

### 3.1 Primary goals

1. Launch a new production-grade Next.js product without rebuilding common infrastructure.
2. Keep public SEO pages, tools, account features, and checkout on one domain and in one deployable application.
3. Make each new product primarily a business-logic, content, keyword, and visual-design exercise.
4. Keep authentication, commerce, credits, SEO, analytics, legal pages, and security independently understandable and testable.
5. Preserve a realistic future path to a CLI, shared packages, or commercial starter after several real projects validate the boundaries.

### 3.2 Quality goals

- Smaller feature surface must not mean weaker security.
- Payment fulfillment must be idempotent and recoverable.
- Credit balance must be ledger-derived and transactionally safe.
- Public pages must have correct server-rendered content and metadata.
- Disabled features must not require secrets, expose routes, or appear in sitemaps/navigation.
- The repository must be buildable and testable without production credentials.

## 4. Non-goals for v1

The following are explicitly excluded:

- drag-and-drop page building;
- browser-based content editing;
- public multi-tenant site-building SaaS;
- runtime plugin discovery;
- authentication-provider switching UI;
- implementation of Clerk, Auth.js, Supabase Auth, or other second auth providers;
- implementation of Stripe, Creem, Paddle, Dodo, or other second payment providers;
- multiple databases or ORMs;
- automatic downstream-project upgrades;
- a package publishing pipeline;
- a `create-creat-web` CLI;
- team workspaces, enterprise SSO, SCIM, or complex RBAC;
- automatic legal compliance guarantees;
- automatic SEO keyword strategy or content generation.

These exclusions are essential risk controls, not missing work.

## 5. Architecture decision

### 5.1 Why a modular monolith

A single Next.js application is selected because the initial user is an independent developer and the product pages themselves are SEO acquisition pages. A split `web/app/api` deployment would add cross-domain cookies, multiple Vercel projects, duplicate environment management, analytics coordination, and deployment coupling without a current organizational benefit.

The internal architecture must still enforce module boundaries so that later extraction remains possible.

### 5.2 Dependency rule

Allowed dependencies:

```text
app -> product modules -> platform
app -> platform
```

Forbidden dependency:

```text
platform -X-> product modules
```

Examples:

- the product may ask the credit service to reserve units;
- the credit service must not know whether a unit generates an AI report, processes an image, or unlocks a tool;
- Waffo code must not import a product price table or business result type;
- authentication must not synchronize into a second generic `users` table through an application-specific bridge;
- SEO helpers must receive page data rather than import product copy.

## 6. Proposed repository structure

```text
src/
  app/
    (marketing)/
    (product)/
    (account)/
    (legal)/
    api/
    robots.ts
    sitemap.ts
    layout.tsx

  platform/
    auth/
    database/
    email/
    commerce/
      domain/
      application/
      providers/waffo/
      infrastructure/
    credits/
    analytics/
    consent/
    seo/
    security/
    jobs/
    observability/
    config/

  modules/
    product/
      domain/
      application/
      infrastructure/
      ui/

  components/
    ui/
    landing/
    legal/
    account/

  config/
    site.config.ts
    features.config.ts
    products.config.ts
    seo.config.ts
    legal.config.ts

drizzle/
  platform/
  product/

tests/
  unit/
  integration/
  contract/
  e2e/

docs/
  specs/
  decisions/
  review/
  setup/
  upgrade/
```

This is a logical target, not permission to create empty abstractions. Directories are added only when their first real implementation exists.

## 7. Configuration model

### 7.1 Three different configuration classes

The design separates:

1. **Versioned product configuration** — committed TypeScript values such as enabled features, routes, product identifiers, page modules, and SEO policies.
2. **Secrets and deployment configuration** — environment variables such as client secrets, database URLs, signing secrets, and provider keys.
3. **Operational content** — product copy, keyword plans, legal facts, prices, and provider-dashboard identifiers that vary by project.

Secrets must never be accepted through public configuration objects or committed files.

### 7.2 Feature configuration

Illustrative shape:

```ts
export const features = {
  auth: {
    enabled: true,
    google: true,
    magicLink: true,
    password: false,
  },
  commerce: {
    enabled: true,
    provider: "waffo",
    oneTime: true,
    subscriptions: true,
    credits: true,
  },
  analytics: {
    ga4: true,
    clarity: false,
    consentRequired: true,
  },
  content: {
    blog: false,
    internationalization: false,
  },
} as const;
```

Feature flags are compile-time/product configuration, not a remote feature-flag service.

### 7.3 Configuration invariants

CI must reject contradictions, including:

- magic link enabled while email transport is disabled;
- subscriptions enabled while commerce is disabled;
- credit products configured while the credit module is disabled;
- a route marked indexable while its feature is disabled;
- analytics enabled without a declared consent policy where consent is required;
- a provider enabled without required environment variables in the relevant environment;
- placeholder production values or localhost production origins.

## 8. Core modules

### 8.1 Authentication

V1 implements Better Auth with Google and magic link. Password sign-in is intentionally disabled. Better Auth's user table is the canonical identity table; product tables reference that user ID. No Quick I Ching-style auth bridge is introduced.

Security and account lifecycle are defined in `auth-security-design.md`.

### 8.2 Commerce

Commerce owns local orders, payments, subscriptions, refunds, provider-event processing, reconciliation, and fulfillment dispatch. It does not own product-specific entitlements.

Waffo is the only provider implementation in v1. Redirect success pages are not proof of payment. Signed provider events and reconciliation are authoritative.

### 8.3 Credits

Credits are internal product entitlements, not a payment type. Credits can be granted by a one-time payment, a successful subscription period, an administrative adjustment, or compensation. The ledger supports grant, reserve, commit, release, expire, and revoke operations.

### 8.4 SEO

SEO is a system policy, not a metadata utility alone. The platform owns canonical URL construction, route indexability rules, metadata factories, robots, sitemap generation, structured-data helpers, staging noindex controls, and automated checks. Each product still supplies keywords, intent, copy, internal-link choices, and content quality.

### 8.5 Legal pages

The starter provides page structure, versioning, configuration checks, footer/account entry points, and drafts assembled from actual enabled services. It does not claim that one universal policy is legally sufficient. Product/operator facts and policy decisions remain mandatory project inputs.

### 8.6 Landing page

The starter provides composable sections, not a fixed visual homepage. A project selects and writes its Hero, product demonstration, use cases, explanation, pricing, FAQ, SEO content, CTA, and footer.

## 9. Data ownership

### 9.1 Platform data

Platform migrations may include:

- Better Auth users, sessions, accounts, verifications, and database rate limits;
- commerce products, orders, payments, subscriptions, billing periods, refunds, webhook inbox/outbox, reconciliation state, and fulfillment attempts;
- credit grants/lots, ledger entries, and reservations;
- consent records where persistence is required;
- legal acceptance records where explicit acceptance is required;
- operational jobs and dead-letter records;
- security and audit records with bounded retention.

### 9.2 Product data

Product migrations are separate and may include tool inputs, generated outputs, histories, domain states, or business-specific records.

A platform migration must never introduce a Quick I Ching concept such as casting, hexagram, reading, question lock, or quality-review reason.

## 10. Provider strategy

### 10.1 Practical extensibility

V1 uses interfaces only where they protect a real domain boundary:

- `EmailSender`;
- `PaymentProvider`;
- `OrderFulfillment`;
- optional analytics adapters.

It does not create a dynamic provider registry or force every provider into an unrealistically identical API.

Provider-specific raw identifiers and payload metadata are retained for debugging and reconciliation, while normalized domain facts are used by commerce and fulfillment.

### 10.2 Future provider replacement

A future payment provider is feasible if it can produce the normalized facts required by the commerce domain. Adding it will still require explicit implementation and contract tests; it is not promised as a configuration-only switch.

The same principle applies to authentication. V1's code should not spread Better Auth internals into product modules, but replacing Better Auth later remains a migration project.

## 11. Deployment topology

V1 uses:

- one Next.js deployable application;
- one production PostgreSQL database and separate staging/test databases;
- separate Vercel production and staging projects, or an equivalently isolated deployment topology;
- separate Waffo test and live configuration;
- separate Google OAuth redirect origins and credentials where appropriate;
- environment-specific analytics identifiers;
- production-only secrets with rotation documentation.

Staging must never index in search engines or use live payment products.

## 12. Failure-handling principles

1. Fail closed on authentication and authorization ambiguity.
2. Never fulfill commerce from the browser redirect alone.
3. Store unknown validly signed provider events for later inspection; do not discard them.
4. Process duplicate events idempotently.
5. Use durable retry with bounded backoff and dead-letter state for payment fulfillment.
6. Reconcile local state with provider state on schedule and through an operator action.
7. Never silently create or destroy credits.
8. Never expose secrets, login tokens, full private input, or payment data in logs or analytics.
9. Disabled external integrations degrade explicitly; core pages must still build where the feature is disabled.
10. Production configuration errors block deployment rather than falling back to unsafe defaults.

## 13. Test strategy

Every implementation phase must add tests at the correct boundary:

- unit tests for domain transitions and configuration invariants;
- PostgreSQL integration tests for migrations, transactions, locks, idempotency, and ledger invariants;
- provider contract tests using documented/recorded Waffo fixtures;
- E2E tests for Google test strategy where practical, magic link, sign-out, account deletion, checkout redirection, webhook fulfillment, credit use, and protected pages;
- SEO HTML assertions for title, description, canonical, robots, sitemap, JSON-LD, headings, and internal links;
- production build, dependency boundary, secret scan, and static analysis gates.

No payment or credit implementation is accepted with mocked repositories alone.

## 14. V1 implementation sequence

Implementation remains blocked until review. Once approved, work should be divided into independently reviewable PRs:

1. Repository scaffold, toolchain, dependency rules, environment validation, CI, and empty-database migration harness.
2. Database foundation and production-grade authentication.
3. SEO policy, reusable layout/home/legal shells, and release checks.
4. Commerce core and Waffo one-time purchases.
5. Credit ledger and reservation/commit/release flows.
6. Waffo subscriptions and subscription-period fulfillment.
7. Refund handling, reconciliation, durable retries, and dead-letter operations.
8. Analytics consent, security hardening, observability, and account lifecycle completion.
9. Starter setup documentation, a sample product, and full staging production-readiness verification.

Each PR must leave the repository passing all existing gates.

## 15. Commercialization path

Commercialization is deliberately postponed. The likely path is:

1. use v1 on a second real product;
2. record every changed or deleted platform file;
3. use it on a third product;
4. extract only modules that remained stable;
5. then decide between private packages, a generator CLI, or a commercial starter.

A public product would additionally require licensing, installer/update behavior, support policy, migration compatibility, documentation quality, telemetry choices, and a threat model for untrusted users. None is required for the internal v1.

## 16. Risk register

| Risk | Consequence | Design control |
|---|---|---|
| Over-abstraction | Slow development and brittle generic interfaces | One provider per concern; extract only proven boundaries |
| Authentication account duplication | User data split or account takeover risk | Better Auth canonical user; no custom automatic merges; tested linking rules |
| Serverless rate-limit weakness | Magic-link abuse and email cost | Database-backed rate limits and trusted proxy IP rules |
| Payment redirect trusted as success | Unpaid fulfillment | Signed webhook/API reconciliation only |
| Duplicate or out-of-order events | Duplicate credits or wrong subscription status | Inbox idempotency, monotonic/domain-aware transitions, reconciliation |
| Subscription edge cases | Incorrect access or repeated grants | Explicit state machine and unique period/payment fulfillment keys |
| Refund after credit use | Financial/entitlement inconsistency | Origin-linked grants, revoke unused units only, record unrecovered consumption |
| SEO configuration omissions | Pages fail to index or create duplicates | Required page SEO schema and publish gates |
| Generic legal text mismatch | Misleading or noncompliant policy | Service-derived checklist plus mandatory operator review |
| Template drift across projects | Security fixes missed | Version marker, changelog, upgrade notes, later package extraction |

## 17. Implementation gate

Coding must not begin until all of the following are true:

- this master design and the four specialist designs have been independently reviewed;
- material review findings are resolved in the documents;
- the owner explicitly approves the reviewed design;
- Waffo test account capabilities and current webhook event names are captured from the dashboard/documentation;
- the first implementation PR plan is written with file-level tasks and tests.

Until then, the repository remains design-only.

## 18. Primary references

- Better Auth Google provider: https://better-auth.com/docs/authentication/google
- Better Auth magic link: https://better-auth.com/docs/plugins/magic-link
- Better Auth session management: https://better-auth.com/docs/concepts/session-management
- Better Auth rate limits: https://better-auth.com/docs/concepts/rate-limit
- Waffo documentation: https://docs.waffo.ai/zh/
- Waffo subscriptions: https://docs.waffo.ai/zh/features/subscriptions
- Waffo orders/payments: https://docs.waffo.ai/zh/features/orders-payments
- Next.js documentation: https://nextjs.org/docs
- Google Search documentation: https://developers.google.com/search/docs

# Independent AI review brief

## 1. Review objective

Audit the complete `creat-web v1` design before any application code is written.

Repository: `pyxm1618/creat-web`

Review these documents in order:

1. `docs/specs/creat-web-v1-master-design.md`
2. `docs/specs/auth-security-design.md`
3. `docs/specs/payments-subscriptions-credits-design.md`
4. `docs/specs/seo-home-legal-design.md`
5. `docs/specs/quality-migration-release-design.md`

`pyxm1618/quickiching` is a read-only reference. Do not propose modifying or refactoring Quick I Ching as part of this project.

## 2. Context

The owner is an independent developer who will repeatedly build SEO-dependent overseas products with Next.js. The initial system is private/internal, but the architecture should not block later commercialization.

Hard requirements:

- Next.js and strong technical SEO;
- Google sign-in;
- magic link preferred;
- secure account/session lifecycle;
- Waffo one-time purchases;
- Waffo subscriptions;
- internal credits with reservation/consumption/refund behavior;
- reusable homepage/page shells;
- privacy policy, terms, acceptable use, refund/cancellation, cookie settings, contact/account deletion;
- PostgreSQL/Drizzle, CI, staging, security, and production reliability;
- avoid repeatedly rebuilding common infrastructure.

Constraints:

- do not build a public visual site builder in v1;
- do not implement multiple auth/payment providers in v1;
- do not reduce security/reliability merely because the initial feature surface is smaller;
- avoid over-abstraction and unnecessary monorepo/plugin complexity;
- no application code until design review is resolved.

## 3. Required review method

Do not merely summarize or agree. Attempt to falsify the design.

For each finding, provide:

- severity: `BLOCKING`, `IMPORTANT`, `OPTIONAL`, or `INCORRECT/NOT A FINDING`;
- exact document and section;
- concrete failure scenario;
- why current controls are insufficient;
- recommended design change;
- whether the change increases v1 complexity materially;
- evidence from current official documentation or a reproducible technical argument.

Separate actual implementation blockers from preferences.

## 4. Mandatory audit questions

### 4.1 Scope and architecture

- Is a single Next.js modular monolith the correct initial topology for an SEO-first independent developer?
- Are module/dependency boundaries enforceable and sufficient?
- Does the design accidentally create a framework/plugin system despite saying it will not?
- Is any supposedly generic platform concept still coupled to a specific product?
- Are feature toggles and optional environment validation coherent?
- Is future provider replacement preserved realistically without imposing present overengineering?

### 4.2 Authentication and security

- Is Better Auth’s user table correctly selected as the canonical identity?
- Are Google-first/magic-link-first account-linking and collision cases safe?
- Does the design rely on email equality in a way that could enable account takeover?
- Are magic-link hashing, atomic consumption, callback validation, rate limiting, proxy IP handling, logging, and email enumeration addressed correctly?
- Are session lifetime/freshness and sensitive-action reauthentication appropriate?
- Does account deletion safely coordinate sessions, subscriptions, product data, and legally required commerce records?
- Are authorization controls placed at the server/resource boundary rather than UI/middleware only?
- What auth threat-model items are missing?

### 4.3 Payments and subscriptions

- Are local order, payment, subscription, period, refund, inbox/outbox, and reconciliation concepts complete without being excessive?
- Are Waffo’s current states and capabilities represented accurately?
- Is browser redirect correctly treated as non-authoritative?
- Can duplicate, delayed, missing, and out-of-order events cause duplicate fulfillment or state regression?
- Is reconciliation sufficient to recover missed webhooks?
- Does `past_due`, `canceling`, cancellation, restoration, trial, and period-end access behavior remain coherent?
- Is the design correct to defer upgrade/downgrade while Waffo documents the endpoint as unavailable?
- Are money/currency representation and partial refunds safe?
- Are test/live merchant/store/product boundaries strong enough?
- Are operator/dead-letter controls sufficient for a private starter?

### 4.4 Credits

- Is the grant/ledger/reservation model correct under concurrency?
- Can a reservation consume or release the wrong grant?
- Is earliest-expiring allocation compatible with refund-linked revocation?
- Is the balance derived/auditable without unsafe mutable counters?
- Can expiry race with reservation or consumption?
- Is refund behavior after partial credit consumption financially and operationally defensible?
- Should the design permit negative balances, account debt, suspension, or only unrecovered-consumption records?
- Are subscription renewal grants uniquely keyed and exactly-once in effect?

### 4.5 SEO and content foundation

- Does the design correctly distinguish technical SEO, project inputs, and ongoing operations?
- Are initial HTML, canonical, robots/noindex, sitemap, structured data, status codes, internal links, mobile rendering, and Core Web Vitals covered?
- Is the staging noindex strategy layered enough?
- Are route classes and query/filter URL policies complete?
- Is the page SEO schema useful or excessively bureaucratic for repeated small products?
- Are homepage and inner SEO pages separated correctly?
- Are there risks of thin programmatic pages or generic duplicate copy?
- What can be automated reliably, and what should remain a human release checklist?

### 4.6 Legal and privacy

- Does the design reuse layout/process without pretending one legal document fits every product?
- Are enabled providers and collected data cross-checked against policy disclosures?
- Are subscription, credit, cancellation, refund, retention, analytics consent, account deletion, and AI processing represented?
- Are explicit acceptance/version records required only where justified?
- Does the design make unsupported compliance claims?
- Which product categories/revenue/data conditions should trigger qualified legal review?

### 4.7 Testing and implementation sequencing

- Do unit, PostgreSQL integration, provider contract, E2E, fault-injection, and staging tests prove the important properties?
- Are any gates impossible, redundant, or likely to be skipped because they are vague?
- Does each proposed PR have a coherent scope and independent exit condition?
- Should any phase move earlier or later?
- Does the design provide enough information to create a file-level implementation plan without making material architecture decisions during coding?

## 5. Required final review output

Return:

1. overall verdict: `APPROVE`, `APPROVE WITH CHANGES`, or `REJECT`;
2. top five actual risks;
3. all blocking findings;
4. important findings;
5. optional simplifications/improvements;
6. areas that are already sufficiently designed and should not be expanded;
7. a proposed revised code-start gate;
8. explicit statement on whether implementation may begin.

## 6. Review discipline

- Use current official Better Auth, Next.js, Google Search, Waffo, PostgreSQL/Drizzle, and Vercel documentation for changing facts.
- Do not assume Stripe semantics apply to Waffo.
- Do not infer current Waffo webhook event names from memory; verify them.
- Do not recommend a monorepo, microservices, event bus, Redis, queues, or second provider unless a concrete v1 requirement justifies the added operational cost.
- Do not downgrade security because the system is initially private/internal; end users and payment data are still real.
- Do not propose changing Quick I Ching.
- Prefer a smaller robust v1 over a generic but unverified platform.

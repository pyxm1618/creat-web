# creat-web

Private, SEO-first Next.js starter for repeatedly launching overseas web products.

## Current status

**Design and execution-plan review only. No application code has been approved for implementation.**

The repository contains the architecture, risk-control design, independent-review corrections, and Superpowers executable development plans for `creat-web v1`. Implementation remains blocked until the complete corrected design and plan stack is independently reviewed, blocking/important findings are resolved, and the owner explicitly approves coding.

## Non-negotiable boundary

`pyxm1618/quickiching` is a read-only reference source. This project must not modify, refactor, branch, or commit to Quick I Ching. Any reusable idea is re-designed and implemented only in this repository.

## Binding reading order

Later binding corrections supersede conflicting older statements. The authoritative order is defined by:

- [Corrected master execution plan v3](docs/superpowers/plans/2026-08-06-creat-web-master-execution-plan-v3.md)

No implementation agent may begin from an older phase plan without first reading v3 and every binding correction it references.

## Design documents

- [Master design](docs/specs/creat-web-v1-master-design.md)
- [Authentication and account security](docs/specs/auth-security-design.md)
- [Payments, subscriptions, and credits](docs/specs/payments-subscriptions-credits-design.md)
- [SEO, homepage, and legal foundation](docs/specs/seo-home-legal-design.md)
- [Migration boundaries, quality gates, and release plan](docs/specs/quality-migration-release-design.md)
- [First Gemini review resolution](docs/specs/creat-web-v1-gemini-review-resolution.md)
- [Critical authentication clarifications](docs/specs/creat-web-v1-auth-critical-clarifications.md)
- [Second independent review resolution](docs/specs/creat-web-v1-second-review-resolution.md)

## Superpowers execution plans

Authoritative entrypoint:

- [Corrected master execution plan v3](docs/superpowers/plans/2026-08-06-creat-web-master-execution-plan-v3.md)

Binding supporting documents:

- [Original master execution plan](docs/superpowers/plans/2026-08-06-creat-web-master-execution-plan.md)
- [Original execution preflight](docs/superpowers/plans/2026-08-06-creat-web-execution-preflight.md)
- [First review execution corrections](docs/superpowers/plans/2026-08-06-creat-web-gemini-review-corrections.md)
- [Second review execution corrections](docs/superpowers/plans/2026-08-06-creat-web-second-review-corrections.md)

Phase plans:

- [Foundation](docs/superpowers/plans/2026-08-06-creat-web-foundation-plan.md)
- [Authentication](docs/superpowers/plans/2026-08-06-creat-web-authentication-plan.md)
- [SEO, homepage, and legal](docs/superpowers/plans/2026-08-06-creat-web-seo-home-legal-plan.md)
- [Commerce and one-time payments](docs/superpowers/plans/2026-08-06-creat-web-commerce-one-time-plan.md)
- [Credit ledger](docs/superpowers/plans/2026-08-06-creat-web-credits-plan.md)
- [Subscriptions and refunds](docs/superpowers/plans/2026-08-06-creat-web-subscriptions-plan.md)
- [Security, operations, and release](docs/superpowers/plans/2026-08-06-creat-web-security-operations-release-plan.md)

## Review documents

- [Independent design review brief](docs/review/ai-review-brief.md)
- [Independent execution-plan review brief](docs/review/implementation-plan-review-brief.md)
- [Post-fix verification brief](docs/review/gemini-fix-verification-brief.md)

## Corrected design highlights

The binding corrections require:

- retained non-authentication account subjects for deletion-safe financial records;
- two-step Magic Link and destructive-action confirmation resistant to mail prefetch;
- exact Better Auth session-cookie forwarding;
- side-effect-free optional providers and build-matrix tests;
- Waffo display-string to `BIGINT` minor-unit conversion;
- minimized normalized webhook persistence, encrypted bounded exceptional retention, and purge jobs;
- serialized Credit reserve/commit/release/expiry operations with explicit boundary-time behavior;
- no canonical or sitemap outside production;
- zero third-party analytics requests before consent;
- persisted subscription `past_due` grace deadlines;
- no successful production no-op fulfillment.

## Intended v1

A single Next.js App Router application with strict internal module boundaries, production-grade Google and magic-link authentication, Waffo one-time payments and subscriptions, a general credit ledger, technical SEO foundations, reusable landing/legal shells, PostgreSQL/Drizzle, CI, security controls, and staged production verification.

It is an internal starter, not a visual site builder, public SaaS, plugin marketplace, or multi-provider framework.

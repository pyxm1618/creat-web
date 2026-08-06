# creat-web

Private, SEO-first Next.js starter for repeatedly launching overseas web products.

## Current status

**Design and execution-plan review only. No application code has been approved for implementation.**

The repository contains the architecture, risk-control design, and Superpowers executable development plans for `creat-web v1`. Implementation remains blocked until the design and plans are independently reviewed, blocking/important findings are resolved, and the owner explicitly approves coding.

## Non-negotiable boundary

`pyxm1618/quickiching` is a read-only reference source. This project must not modify, refactor, branch, or commit to Quick I Ching. Any reusable idea is re-designed and implemented only in this repository.

## Design documents

- [Master design](docs/specs/creat-web-v1-master-design.md)
- [Authentication and account security](docs/specs/auth-security-design.md)
- [Payments, subscriptions, and credits](docs/specs/payments-subscriptions-credits-design.md)
- [SEO, homepage, and legal foundation](docs/specs/seo-home-legal-design.md)
- [Migration boundaries, quality gates, and release plan](docs/specs/quality-migration-release-design.md)
- [Independent AI review brief](docs/review/ai-review-brief.md)

## Superpowers execution plans

Start with these two documents:

- [Master execution plan](docs/superpowers/plans/2026-08-06-creat-web-master-execution-plan.md)
- [Binding execution preflight](docs/superpowers/plans/2026-08-06-creat-web-execution-preflight.md)

Phase plans:

- [Foundation](docs/superpowers/plans/2026-08-06-creat-web-foundation-plan.md)
- [Authentication](docs/superpowers/plans/2026-08-06-creat-web-authentication-plan.md)
- [SEO, homepage, and legal](docs/superpowers/plans/2026-08-06-creat-web-seo-home-legal-plan.md)
- [Commerce and one-time payments](docs/superpowers/plans/2026-08-06-creat-web-commerce-one-time-plan.md)
- [Credit ledger](docs/superpowers/plans/2026-08-06-creat-web-credits-plan.md)
- [Subscriptions and refunds](docs/superpowers/plans/2026-08-06-creat-web-subscriptions-plan.md)
- [Security, operations, and release](docs/superpowers/plans/2026-08-06-creat-web-security-operations-release-plan.md)

## Intended v1

A single Next.js App Router application with strict internal module boundaries, production-grade Google and magic-link authentication, Waffo one-time payments and subscriptions, a general credit ledger, technical SEO foundations, reusable landing/legal shells, PostgreSQL/Drizzle, CI, security controls, and staged production verification.

It is an internal starter, not a visual site builder, public SaaS, plugin marketplace, or multi-provider framework.

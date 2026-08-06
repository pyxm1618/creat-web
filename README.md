# creat-web

Private, SEO-first Next.js starter for repeatedly launching overseas web products.

## Current status

**Design review only. No application code has been approved for implementation.**

The repository currently contains the architecture and risk-control design for `creat-web v1`. Implementation remains blocked until the design is independently reviewed and the owner explicitly approves coding.

## Non-negotiable boundary

`pyxm1618/quickiching` is a read-only reference source. This project must not modify, refactor, branch, or commit to Quick I Ching. Any reusable idea is re-designed and implemented only in this repository.

## Design documents

- [Master design](docs/specs/creat-web-v1-master-design.md)
- [Authentication and account security](docs/specs/auth-security-design.md)
- [Payments, subscriptions, and credits](docs/specs/payments-subscriptions-credits-design.md)
- [SEO, homepage, and legal foundation](docs/specs/seo-home-legal-design.md)
- [Migration boundaries, quality gates, and release plan](docs/specs/quality-migration-release-design.md)
- [Independent AI review brief](docs/review/ai-review-brief.md)

## Intended v1

A single Next.js App Router application with strict internal module boundaries, production-grade Google and magic-link authentication, Waffo one-time payments and subscriptions, a general credit ledger, technical SEO foundations, reusable landing/legal shells, PostgreSQL/Drizzle, CI, security controls, and staged production verification.

It is an internal starter, not a visual site builder, public SaaS, plugin marketplace, or multi-provider framework.

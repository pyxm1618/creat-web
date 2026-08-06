# creat-web

Private, SEO-first Next.js starter for repeatedly launching overseas web products.

## Current status

**Design and execution-plan review only. No application code has been approved for implementation.**

The repository contains the architecture, risk-control design, Gemini review corrections, and Superpowers executable development plans for `creat-web v1`. Implementation remains blocked until the corrected design and plans are independently reviewed, blocking/important findings are resolved, and the owner explicitly approves coding.

## Non-negotiable boundary

`pyxm1618/quickiching` is a read-only reference source. This project must not modify, refactor, branch, or commit to Quick I Ching. Any reusable idea is re-designed and implemented only in this repository.

## Binding reading order

Later binding corrections supersede conflicting older statements.

1. Read the five original design documents.
2. Read [Gemini review design resolution](docs/specs/creat-web-v1-gemini-review-resolution.md).
3. Read the [corrected master execution plan](docs/superpowers/plans/2026-08-06-creat-web-master-execution-plan-v2.md).
4. Read the original master plan, original execution preflight, and Gemini execution corrections in the order stated by the corrected master.
5. Read the relevant phase plan.

## Design documents

- [Master design](docs/specs/creat-web-v1-master-design.md)
- [Authentication and account security](docs/specs/auth-security-design.md)
- [Payments, subscriptions, and credits](docs/specs/payments-subscriptions-credits-design.md)
- [SEO, homepage, and legal foundation](docs/specs/seo-home-legal-design.md)
- [Migration boundaries, quality gates, and release plan](docs/specs/quality-migration-release-design.md)
- [Binding Gemini review resolution](docs/specs/creat-web-v1-gemini-review-resolution.md)
- [Independent design review brief](docs/review/ai-review-brief.md)
- [Independent execution-plan review brief](docs/review/implementation-plan-review-brief.md)
- [Post-fix Gemini verification brief](docs/review/gemini-fix-verification-brief.md)

## Superpowers execution plans

Authoritative entrypoint:

- [Corrected master execution plan](docs/superpowers/plans/2026-08-06-creat-web-master-execution-plan-v2.md)

Binding supporting documents:

- [Original master execution plan](docs/superpowers/plans/2026-08-06-creat-web-master-execution-plan.md)
- [Binding execution preflight](docs/superpowers/plans/2026-08-06-creat-web-execution-preflight.md)
- [Binding Gemini review execution corrections](docs/superpowers/plans/2026-08-06-creat-web-gemini-review-corrections.md)

Phase plans:

- [Foundation](docs/superpowers/plans/2026-08-06-creat-web-foundation-plan.md)
- [Authentication](docs/superpowers/plans/2026-08-06-creat-web-authentication-plan.md)
- [SEO, homepage, and legal](docs/superpowers/plans/2026-08-06-creat-web-seo-home-legal-plan.md)
- [Commerce and one-time payments](docs/superpowers/plans/2026-08-06-creat-web-commerce-one-time-plan.md)
- [Credit ledger](docs/superpowers/plans/2026-08-06-creat-web-credits-plan.md)
- [Subscriptions and refunds](docs/superpowers/plans/2026-08-06-creat-web-subscriptions-plan.md)
- [Security, operations, and release](docs/superpowers/plans/2026-08-06-creat-web-security-operations-release-plan.md)

## Corrected design highlights

The binding Gemini resolution adds:

- a retained non-authentication `account_subjects` identity anchor so account deletion cannot cascade-delete or be blocked by financial records;
- two-step Magic Link confirmation resistant to mail-security prefetch;
- side-effect-free optional provider factories and a feature build matrix;
- Waffo display-string to `BIGINT` minor-unit money conversion with reviewed currency exponents;
- no canonical output outside production;
- network-level proof that analytics does not load before consent or on sensitive routes;
- persisted subscription `past_due` grace deadlines;
- test-only recording fulfillment and a production ban on successful no-op fulfillment.

## Intended v1

A single Next.js App Router application with strict internal module boundaries, production-grade Google and magic-link authentication, Waffo one-time payments and subscriptions, a general credit ledger, technical SEO foundations, reusable landing/legal shells, PostgreSQL/Drizzle, CI, security controls, and staged production verification.

It is an internal starter, not a visual site builder, public SaaS, plugin marketplace, or multi-provider framework.

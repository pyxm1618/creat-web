# creat-web v1 Master Execution Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the reviewed `creat-web v1` design as a private, SEO-first, production-grade Next.js starter without modifying Quick I Ching.

**Architecture:** One Next.js App Router application implemented as a modular monolith. Platform modules own authentication, database, commerce, credits, SEO, consent, security, and operations; product modules may depend on platform modules, but platform modules may never depend on product modules. Better Auth and Waffo are the only provider implementations in v1.

**Tech Stack:** Bun, Next.js App Router, React, TypeScript strict mode, PostgreSQL, Drizzle ORM/migrations, Better Auth, Resend, Waffo Pancake SDK, Zod, Vitest, Playwright, ESLint, Prettier, GitHub Actions, Vercel.

## Global Constraints

- `pyxm1618/quickiching` is read-only; never create a branch, commit, refactor, or shared dependency there.
- Application code may begin only after independent design review findings are resolved and the owner approves the reviewed design.
- Use a dedicated Git worktree and branch for every implementation plan.
- Keep one deployable Next.js application; do not introduce a monorepo, runtime plugin loader, CLI generator, or second provider implementation in v1.
- Better Auth `user` is the canonical identity; do not create a second synchronized generic users table.
- Password authentication is disabled in v1; Google and magic link must be production-grade.
- Browser checkout redirects never prove payment; signed Waffo events or trusted reconciliation are authoritative.
- Credits are internal entitlements and must never depend directly on Waffo SDK types.
- Money uses integer minor units or validated decimal strings; never use JavaScript binary floating-point arithmetic for financial comparison.
- Public indexable content must be present in initial server-rendered HTML.
- Staging must be noindex and must never use live Waffo products, live analytics IDs, or production OAuth secrets.
- Every behavior change follows TDD: failing test, observed failure, minimal implementation, observed pass, focused commit.
- PostgreSQL concurrency, migration, lock, idempotency, and ledger claims require real PostgreSQL integration tests.
- Every PR must pass frozen install, format check, lint, typecheck, unit tests, relevant PostgreSQL integration tests, production build, secret scan, and dependency-boundary checks.

---

## Plan Suite

Execute the plans in this order. A later plan may not begin until the previous plan's exit gate is met and reviewed.

1. [`2026-08-06-creat-web-foundation-plan.md`](./2026-08-06-creat-web-foundation-plan.md)
   - Repository scaffold, toolchain, configuration, dependency boundaries, PostgreSQL migration harness, CI, logging/redaction.
2. [`2026-08-06-creat-web-authentication-plan.md`](./2026-08-06-creat-web-authentication-plan.md)
   - Better Auth, Google, magic link, durable rate limits, sessions, authorization, account deletion.
3. [`2026-08-06-creat-web-seo-home-legal-plan.md`](./2026-08-06-creat-web-seo-home-legal-plan.md)
   - Route classification, metadata, canonical, robots, sitemap, JSON-LD, homepage/page shells, legal configuration/versioning.
4. [`2026-08-06-creat-web-commerce-one-time-plan.md`](./2026-08-06-creat-web-commerce-one-time-plan.md)
   - Catalog, orders, payments, webhook inbox/outbox, Waffo one-time checkout, reconciliation, operator inspection.
5. [`2026-08-06-creat-web-credits-plan.md`](./2026-08-06-creat-web-credits-plan.md)
   - Credit grants, immutable ledger, deterministic allocation, reserve/commit/release, expiry, revocation, one-time fulfillment.
6. [`2026-08-06-creat-web-subscriptions-plan.md`](./2026-08-06-creat-web-subscriptions-plan.md)
   - Waffo subscriptions, period fulfillment, past-due/canceling/canceled policies, refunds and restoration.
7. [`2026-08-06-creat-web-security-operations-release-plan.md`](./2026-08-06-creat-web-security-operations-release-plan.md)
   - Consent/analytics, Turnstile, CSP, observability, dead-letter operations, backup/restore/key rotation, clean-project validation and staging release.

## Branch and Review Protocol

For each plan:

- [ ] Create an isolated worktree using `superpowers:using-git-worktrees`.
- [ ] Create a branch named `feat/<plan-short-name>` from the latest reviewed `main`.
- [ ] Execute one task at a time; do not batch unrelated tasks into one commit.
- [ ] Run the exact verification command listed in the task before claiming it passes.
- [ ] Use `superpowers:requesting-code-review` after the plan's final task.
- [ ] Resolve review feedback using `superpowers:receiving-code-review`.
- [ ] Use `superpowers:verification-before-completion` before opening or merging a PR.
- [ ] Open a draft PR and keep it draft until all exit-gate evidence is attached.
- [ ] Merge only after the owner or designated reviewer approves the PR.

## Repository-Level Exit Gate

The starter is complete only when all seven plans have merged and a clean validation run proves:

```bash
bun install --frozen-lockfile
bun run format:check
bun run lint
bun run typecheck
bun run test:unit
bun run test:integration
bun run test:contract
bun run build
bun run test:e2e
bun run verify:architecture
bun run verify:secrets
bun run verify:release
```

Expected: every command exits `0`; PostgreSQL tests use a real isolated database; the staging deployment is noindex; Waffo test-mode one-time and subscription flows complete end to end; duplicate events do not duplicate fulfillment; Quick I Ching names, IDs, copy, and product concepts do not appear in application code or fixtures.

## Design-Review Gate

This plan suite is executable but not yet authorization to code. Before Task 1 of the foundation plan:

- [ ] Independent review of all design documents is complete.
- [ ] Findings are classified as `BLOCKING`, `IMPORTANT`, `OPTIONAL`, or `INCORRECT/NOT A FINDING`.
- [ ] Every blocking and important finding is resolved in the design documents.
- [ ] The owner approves the reviewed design.
- [ ] Current Waffo test-account capabilities, event names, signature requirements, and test/live identifiers are recorded in a reviewed provider note.
- [ ] The assistant states exactly: **“设计已经定稿，现在可以开始写代码。”**

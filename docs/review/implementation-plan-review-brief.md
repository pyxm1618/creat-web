# Independent Review Brief — Superpowers Execution Plans

## Objective

Attempt to falsify the executable development plans before any application code is written.

Repository: `pyxm1618/creat-web`

Quick I Ching remains read-only. Do not propose modifying, refactoring, branching, or packaging code from `pyxm1618/quickiching`.

## Required reading order

1. `docs/specs/creat-web-v1-master-design.md`
2. `docs/specs/auth-security-design.md`
3. `docs/specs/payments-subscriptions-credits-design.md`
4. `docs/specs/seo-home-legal-design.md`
5. `docs/specs/quality-migration-release-design.md`
6. `docs/superpowers/plans/2026-08-06-creat-web-master-execution-plan.md`
7. `docs/superpowers/plans/2026-08-06-creat-web-execution-preflight.md`
8. Every phase plan linked by the master execution plan

The execution preflight supersedes conflicting illustrative snippets in a phase plan.

## Finding format

For each finding provide:

- Severity: `BLOCKING`, `IMPORTANT`, `OPTIONAL`, or `INCORRECT/NOT A FINDING`.
- Exact document, task, and step.
- Concrete failure scenario.
- Whether the issue is in design, ordering, API/type consistency, test coverage, command correctness, provider assumption, security, data integrity, or operations.
- Recommended document change.
- Additional v1 complexity introduced by the fix.
- Evidence from current official documentation or a reproducible technical argument.

Do not treat stylistic preferences as blockers. Do not accept comments such as “add more tests” without naming the missing invariant and exact test level.

## Mandatory review questions

### Coverage and sequencing

- Does every design requirement map to at least one implementation task and exit criterion?
- Can every phase begin from the artifacts produced by the previous phase?
- Does any plan reference a file, type, export, script, migration, route, table, environment value, or test fixture that is never created?
- Does any task require production credentials before its test/staging setup exists?
- Are database migrations introduced in the same PR as code/tests that require them?
- Can every phase be reviewed and rolled back independently?

### TDD and verification

- Does each behavior task start with a test that actually fails for the intended reason?
- Are concurrency, transactions, locks, migrations, idempotency and ledgers tested against real PostgreSQL rather than mocks?
- Are provider fixture tests clearly separated from live test-account verification?
- Are listed commands syntactically valid for Bun, Next.js, Vitest, Playwright, Drizzle, Better Auth and the selected security tools?
- Can the claimed exit gate be proven by the listed commands, or are required checks silently skipped?

### Authentication

- Are Better Auth, adapter and CLI versions mutually compatible and pinned?
- Does generated schema composition work without circular imports or requiring live credentials?
- Are Magic Link tokens explicitly hashed and atomically single-use across instances?
- Are account-linking cases tested without custom email-only merge logic?
- Is durable rate limiting protected from spoofed proxy headers?
- Is account deletion retryable and coordinated with commerce before identity completion?

### SEO, homepage and legal

- Are route-registry fixtures internally coherent?
- Can public indexable pages remain static/cacheable where intended?
- Do canonical, robots, sitemap and noindex rules avoid contradictory behavior?
- Does structured data always match visible facts?
- Are legal page structures reusable without creating false universal legal claims?
- Do release gates block placeholder keywords, operator facts, processors and commerce policies?

### Commerce and Waffo

- Is the provider contract capture sufficient to eliminate guessed event/header/payload behavior?
- Are environment, merchant/store, product version, amount and currency validated before state transition?
- Can duplicate webhooks, reconciliation and worker retry create more than one payment or fulfillment?
- Is raw-body signature verification exact and timing-safe for the observed contract?
- Are unknown valid signed events retained without trusting unsupported semantics?
- Are return pages prevented from acting as proof of payment?

### Credits

- Is there any mutable balance shortcut?
- Does deterministic allocation remain safe under concurrent reservations?
- Are grant, reserve, commit, release, expiry and revoke all source/correlation keyed?
- Can delivered product output ever be followed by automatic credit release because final commit failed?
- Does refund reversal affect only unused units from the originating source?
- Can reconciliation detect and repair output/credit finalization mismatch through domain operations?

### Subscriptions and refunds

- Is each successful paid period uniquely identified and fulfilled once?
- Can out-of-order or stale events move state backward?
- Does `past_due` avoid issuing credits while following an explicit access policy?
- Are canceling, effective cancellation and restoration distinguished?
- Is unsupported in-place plan change absent from UI/API promises?
- Does entitlement reversal occur only after authoritative refund success?
- Can account deletion leave a subscription renewing?

### Security and operations

- Does the route-scoped CSP preserve static SEO pages while applying nonce-based policy to private dynamic routes?
- Are analytics network calls impossible before consent and sensitive fields rejected by type/runtime checks?
- Does Turnstile remain combined with server validation and durable rate limits?
- Are internal job routes cryptographically authenticated and bounded?
- Do health, logs, metrics and alerts avoid sensitive/high-cardinality values?
- Is backup considered complete only after a real isolated restore test?
- Are key rotation and rollback procedures executable and purpose-specific?

### Starter validation

- Can another developer or agent launch the neutral sample from a clean checkout using only committed documentation?
- Does the final verification detect all Quick I Ching product references outside historical design context?
- Does the plan prove internal reuse readiness without claiming public commercial-starter readiness?

## Required conclusion

Conclude with exactly one status:

- `NOT READY TO CODE` — one or more blocking/important plan issues remain.
- `READY AFTER LISTED DOCUMENT FIXES` — all required fixes are explicitly listed and bounded.
- `PLAN SUITE READY FOR OWNER APPROVAL` — no unresolved blocking or important findings remain.

Approval by this review still does not start implementation. The owner must approve the reviewed documents, and the assistant must explicitly state: **“设计已经定稿，现在可以开始写代码。”**

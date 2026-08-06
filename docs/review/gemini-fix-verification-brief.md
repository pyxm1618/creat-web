# Post-Fix Verification Brief — Gemini Review Resolution

## Objective

Verify that the binding design and execution corrections resolve the accepted Gemini findings without introducing new identity, authentication, commerce, SEO, consent, or subscription failures.

Repository: `pyxm1618/creat-web`

Quick I Ching remains read-only.

## Required reading order

1. The five original documents under `docs/specs/`.
2. `docs/specs/creat-web-v1-gemini-review-resolution.md`.
3. `docs/superpowers/plans/2026-08-06-creat-web-master-execution-plan.md`.
4. `docs/superpowers/plans/2026-08-06-creat-web-execution-preflight.md`.
5. `docs/superpowers/plans/2026-08-06-creat-web-gemini-review-corrections.md`.
6. Every phase plan linked by the master execution plan.

The Gemini resolution and execution-corrections documents supersede conflicting older statements.

## Required verdict

Return exactly one:

- `NOT READY TO CODE`
- `READY AFTER LISTED DOCUMENT FIXES`
- `PLAN SUITE READY FOR OWNER APPROVAL`

## Finding format

For each finding:

- severity: `BLOCKING`, `IMPORTANT`, `OPTIONAL`, or `INCORRECT/NOT A FINDING`;
- exact document and section/task;
- concrete failure scenario;
- why the binding correction is insufficient or contradictory;
- exact document change;
- complexity impact;
- official source or reproducible technical argument.

## Mandatory verification questions

### Retained account subject

- Is `account_subjects` clearly non-authentication data rather than an accidental second user system?
- Can Better Auth identity be hard-deleted without cascading or restricting retained commerce records?
- Does a random pseudonymous key avoid retaining an email-derived identifier?
- Can deletion retry after partial failure without duplicate subscription cancellation or credit mutation?
- Is access impossible after session revocation even though retained subject/ledger records survive?

### Magic Link confirmation

- Does an email scanner GET leave the token unused?
- Is the token kept out of the HTTP request URL by using a fragment?
- Can the public POST route safely call Better Auth's reviewed manual verification API without reimplementing token validation?
- Are Origin, callback allowlist, rate limiting, no-store, no-referrer, noindex and logging controls sufficient?
- Are all third-party requests absent from the confirmation page?
- Does the design avoid exposing the token through hydration data, error reporting or browser history?

### Optional integration evaluation

- Can disabled auth, commerce and analytics modules be imported/built without feature secrets?
- Do factories avoid eager SDK construction while preserving clear server composition?
- Does the build matrix test the correct `APP_ENV` combinations without requiring production credentials?

### Money

- Does the design correctly treat documented Waffo amounts as display strings?
- Is `BIGINT` minor-unit storage safe for zero-, two- and three-decimal currencies?
- Is the supported-currency exponent registry explicit, reviewed and fail-closed?
- Are provider display, local snapshot and reconciliation facts compared before fulfillment?

### SEO and analytics

- Does non-production omit canonical rather than self-canonicalize staging?
- Are noindex, robots, access control and no-sitemap controls coherent rather than contradictory?
- Can metadata assets still receive a valid non-production `metadataBase` without producing a canonical?
- Do network-level tests prove zero analytics requests before consent and on sensitive forced-disabled routes?

### Subscription grace

- Is the grace deadline persisted rather than dynamically recomputed?
- Can policy changes or duplicate/out-of-order events extend access unintentionally?
- Does recovery clear past-due fields and grant at most one paid period?
- Does `past_due` avoid new credit grants?

### Execution sequencing

- Are all newly referenced files/types/scripts introduced in a specific phase?
- Does adding `account_subjects` before commerce/credit schema prevent later migration churn?
- Is Waffo contract capture required before adapter implementation but not incorrectly blocking unrelated phases?
- Does any production no-op fulfillment still exist?

## Prohibited review behavior

- Do not repeat the prior Gemini report without checking the corrected documents.
- Do not demand a monorepo, second provider, visual builder or generic plugin system.
- Do not classify a preference as blocking.
- Do not say `READY` if any binding document still references an undefined type or impossible Better Auth/Next.js behavior.

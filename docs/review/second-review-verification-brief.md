# Independent Verification Brief — Complete Corrected Plan Stack

## Objective

Determine whether `creat-web v1` is ready for owner approval before any application code is written.

Repository: `pyxm1618/creat-web`

Quick I Ching remains read-only.

## Mandatory reading order

Follow `docs/superpowers/plans/2026-08-06-creat-web-master-execution-plan-v3.md` exactly. Do not audit only the five original specs.

## Required verdict

Return exactly one:

- `NOT READY TO CODE`
- `READY AFTER LISTED DOCUMENT FIXES`
- `PLAN SUITE READY FOR OWNER APPROVAL`

## Finding format

For each finding provide:

- severity: `BLOCKING`, `IMPORTANT`, `OPTIONAL`, or `INCORRECT/NOT A FINDING`;
- exact binding document, section/task and conflicting lower-precedence text if applicable;
- reproducible failure scenario;
- exact required document change;
- complexity impact;
- official source or rigorous technical argument.

Do not repeat a previously resolved finding unless the higher-precedence correction is itself insufficient.

## Mandatory checks

### Identity/authentication

- retained subject is not a second auth system;
- identity deletion cannot cascade or restrict retained records;
- subject provisioning is idempotent and repairable;
- mail scanner GET cannot consume Magic Link or delete an account;
- explicit POST returns all Better Auth session cookies;
- disabled providers build without their secrets.

### Commerce/privacy

- known successful webhooks store no raw payload;
- normalized payload is a strict allowlist and excludes PII/secrets;
- invalid-signature bodies are not retained;
- exceptional raw retention is authenticated-encrypted, bounded and purgeable;
- purge is concurrency-safe, idempotent and observable;
- legal holds are explicit and reviewed rather than permanent default retention;
- normalized financial records remain sufficient after raw purge.

### Credits

- all credit mutations share a proven serialization scope;
- quantity invariant always holds;
- active reservations are not expired;
- valid reservation can commit after source grant expiry;
- release after source expiry cannot create spendable balance;
- concurrent expiry/commit/release/stale workers are tested on real PostgreSQL;
- no mutable balance shortcut exists.

### SEO/consent/subscriptions

- non-production omits canonical and sitemap;
- zero analytics network calls occur before consent and on forced-disabled routes;
- `past_due` deadline is persisted and cannot be extended by duplicate/stale events;
- no period credits issue without successful payment.

### Plan executability

- every referenced file/type/script is created in a specific owning phase;
- commands are valid and sequencing is coherent;
- Foundation does not require Waffo contract capture;
- Commerce requires the exact Waffo test contract before adapter code;
- each phase has TDD, real PostgreSQL integration tests where required, focused commits and a reviewable exit gate.

## Prohibited review behavior

- Do not request monorepo, microservices, multiple providers, visual builder or public SaaS abstractions.
- Do not classify preferences as blockers.
- Do not approve if you did not read all binding corrections referenced by v3.

# Migration boundaries, quality gates, and release plan

- Status: proposed for independent review
- Source reference: `pyxm1618/quickiching` (read-only)
- Implementation status: blocked until review approval

## 1. Purpose

This document prevents two opposite failures:

1. copying Quick I Ching wholesale and carrying product coupling into the starter;
2. rewriting mature infrastructure from memory and losing already-tested reliability patterns.

The correct approach is evidence-based extraction: inspect the existing pattern, identify its true platform responsibility, redesign the boundary, then implement and test it only in `creat-web`.

## 2. Quick I Ching handling rule

Quick I Ching is never modified by this project.

Allowed:

- read files and tests;
- identify reliable patterns and known failures;
- record behavior and invariants;
- recreate generic implementations in creat-web;
- use non-sensitive test fixtures where licensing/ownership permits.

Forbidden:

- commit or branch in Quick I Ching;
- refactor Quick I Ching first;
- publish a shared package from Quick I Ching;
- move files while preserving product-specific imports;
- change Quick I Ching so that creat-web appears cleaner;
- use production secrets, private user data, or real payment payloads in creat-web fixtures.

## 3. Extraction classification

Each reference is assigned one of four treatments.

### A. Reuse the pattern with light parameterization

Suitable when responsibility is already generic and product coupling is superficial.

Likely candidates:

- TypeScript/Bun/Next.js project quality scripts;
- environment-variable validation primitives;
- security-header/CSP structure, after provider/domain review;
- GitHub Actions structure for lint, typecheck, tests, build, PostgreSQL service, and E2E;
- Waffo SDK client construction and signature-verification approach;
- analytics-consent loading/unloading pattern;
- generic retry/backoff, lease, and dead-letter mechanics;
- health-check and structured-logging patterns.

Even these are reimplemented in creat-web rather than extracted by modifying Quick I Ching.

### B. Parameterize and redesign before reuse

Suitable when the core idea is reusable but the current implementation imports product semantics.

Likely candidates:

- Better Auth production setup: remove Quick I Ching names/email copy and eliminate the application-specific auth bridge;
- session helpers: remove `iching_*` cookies/global names and product repositories;
- Waffo checkout service: separate provider call from fixed reading-credit products;
- webhook Inbox/Outbox repository: preserve idempotency/retry ideas but replace reading-entitlement fulfillment;
- credit batches/reservations: redesign as generic credit grants, ledger entries, and reservations;
- analytics event sanitizer: move product event fields to product configuration;
- consent cookie/event names: derive from site slug;
- legal page components: keep structural components, replace all actual legal facts and product promises;
- configuration loader: split optional module validation instead of requiring every production service.

### C. Reference behavior, then rewrite

Suitable when implementation is deeply coupled but contains valuable lessons.

Likely candidates:

- monolithic production runtime/composition root;
- production server-action boundary;
- payment repository methods that mix generic payment processing with reading entitlements;
- account deletion workflow coupled to readings/questions/credits;
- legal acceptance and retention logic tied to Quick I Ching lifecycle;
- product-specific pricing and fulfillment.

The rewrite must begin from the creat-web domain design, not from line-by-line edits.

### D. Do not migrate

- casting, lines, hexagrams, question locks, method release policy;
- AI reading prompts and result schemas;
- quality-review reasons for readings;
- I Ching safety/risk classification;
- Quick I Ching visual design, homepage copy, method cards, or SEO keywords;
- fixed one/three/five credit products, prices, and expiration promises;
- Quick I Ching legal conclusions and provider descriptions as universal text;
- product-specific database enums/tables;
- global names such as `__ICHING_*`;
- any secret, production ID, customer data, real webhook body, or private support record.

## 4. Reference matrix

| Quick I Ching area | Creat-web treatment | Reason |
|---|---|---|
| `package.json` scripts/toolchain | A | Generic quality workflow, after dependency/version review |
| `.env.example` | B | Useful coverage but currently monolithic and product-specific |
| `src/server/config.ts` | C | Strong validation ideas; wrong all-or-nothing optional-module model |
| auth schema | B | Core Better Auth schema useful; naming and canonical-user decision reviewed |
| `production-auth.ts` | B | Google/Magic Link/Resend useful; brand copy and auth bridge removed |
| auth bridge | D/C | Do not reproduce a second user sync model; reference failure lessons only |
| Waffo client | A/B | Provider boundary is useful; product metadata and config generalized |
| checkout service | B | Split commerce from fixed product/credit definitions |
| Waffo webhook verifier/route | A/B | Preserve raw-body verification and environment checks; schema fixtures refreshed |
| payment dispatcher | C | Hard-coded products replaced by catalog and fulfillment interface |
| payment Postgres repository | C | Reuse transactional patterns, redesign schema/domain ownership |
| entitlement repository/pricing | D/C | Current reading entitlement is product-specific; ledger concepts redesigned |
| analytics consent | B | Generic behavior with configurable IDs, copy, cookie prefix, event schema |
| layout metadata | D/B | Do not copy brand/keywords; metadata system rebuilt from project config |
| homepage | D | Product-specific design and copy; only abstract section taxonomy |
| privacy/terms pages | B/D | Layout and section components reusable; text/facts must be rewritten |
| production runtime/actions | D/C | Product composition not a starter foundation; learn boundary problems |
| DB schema | C/D | Extract only explicitly designed platform records; never copy domain bulk |
| CI workflow | A/B | Keep quality gates, remove product routes/database names |
| `vercel.json` | B | Preserve deployment pattern, replace product cron/routes |
| Next config/security headers | B | Preserve principles, recalculate provider allowlists/CSP |

## 5. Repository initialization policy

The repository remains documentation-only until the code-start gate is satisfied.

When implementation begins:

- create a dedicated implementation branch or PR per phase;
- never create a giant “initial starter” change containing every module;
- introduce no empty interfaces/packages without a first use;
- add migrations and tests in the same PR as the behavior;
- use feature configuration to keep external integrations optional in local/test builds;
- keep `main` releasable after every merged PR.

## 6. Dependency and architecture enforcement

The following must be machine-checked:

- `src/platform/**` cannot import `src/modules/**`;
- product modules access platform modules through documented public entry points;
- server-only modules cannot be imported by client components;
- provider SDK imports are restricted to provider directories;
- database access is not scattered through UI components;
- product code does not import raw Waffo or Better Auth infrastructure types where a platform type exists;
- secrets are read only in server-side configuration/provider modules;
- no circular module dependencies.

Tool choice may be ESLint boundaries, dependency-cruiser, a custom import test, or another maintained approach. The rule matters more than the tool.

## 7. Migration quality gates

### 7.1 Database

Every migration PR must prove:

- installation from an empty PostgreSQL database;
- sequential application of all migrations;
- deterministic schema in CI;
- no reliance on manual dashboard changes for application tables;
- constraints/indexes support documented invariants;
- destructive changes include a data migration and rollback/forward-recovery plan;
- migration works against the supported PostgreSQL version;
- test data and production data are not embedded in migrations.

For Drizzle, production changes use versioned migrations, not schema push as the deployment mechanism.

### 7.2 Configuration

- local/test mode starts without production provider keys when the module is disabled or simulated;
- production mode rejects missing, placeholder, malformed, or cross-environment credentials;
- secret-purpose separation is validated where keys sign/encrypt/hash different data;
- URLs/origins are parsed and normalized;
- enabled-feature contradictions fail at build/startup;
- `.env.example` documents purpose and environment without including usable secrets.

### 7.3 Static quality

Required on every PR:

- dependency install with frozen lockfile;
- formatting/lint;
- TypeScript typecheck;
- unit tests;
- relevant PostgreSQL integration tests;
- production build;
- secret scan;
- dependency-boundary check.

## 8. Testing architecture

### 8.1 Unit tests

Use for pure decisions:

- state machines;
- SEO/configuration validation;
- money parsing;
- product catalog rules;
- credit allocation calculations;
- permission policies;
- redaction/normalization.

Unit tests must not be used as evidence that transactions, locks, migrations, or provider contracts work.

### 8.2 PostgreSQL integration tests

Required for:

- Better Auth adapter/schema behavior;
- concurrent token use;
- rate-limit persistence;
- commerce idempotency;
- worker leasing;
- ledger concurrency;
- account deletion/retention;
- migration history;
- transaction rollback and constraints.

Tests must run against a real PostgreSQL service in CI, not an in-memory database substitute.

### 8.3 Provider contract tests

Waffo tests use:

- official test mode;
- provider-documented payloads;
- recorded and sanitized fixtures from the project’s own test account;
- explicit fixture date/schema version;
- signature success/failure cases;
- feature-capability checks.

The suite must distinguish mocked domain tests from actual provider integration verification.

### 8.4 Browser E2E

Representative journeys:

- public SEO page initial HTML and navigation;
- magic-link sign-in;
- protected account page;
- checkout start/return/processing/fulfillment;
- credit reservation and success/failure;
- subscription account state;
- consent accept/reject/withdraw;
- account deletion;
- mobile navigation and form behavior;
- no private data in rendered metadata.

### 8.5 Fault injection

Infrastructure reliability is tested with controlled failures:

- provider timeout;
- database interruption;
- worker crash and lease expiry;
- duplicate webhook;
- email send failure;
- generation/product fulfillment timeout;
- out-of-order subscription events;
- analytics provider unavailable;
- stale session and revoked session.

## 9. Security gates

Before production:

- threat model covers auth, payment, private user content, operator routes, and webhooks;
- CSRF/origin checks verified;
- trusted proxy/IP configuration verified in actual deployment;
- authorization tests include cross-user access attempts;
- rate limits are durable in serverless topology;
- CSP/security headers tested without broad unnecessary wildcards;
- dependency and secret scanning enabled;
- logs/analytics are reviewed for tokens, email, private content, and billing data;
- backup, restore, and key rotation procedures are documented;
- operator/admin actions use fresh authentication and audit logging;
- account deletion does not destroy required financial evidence or leave active access.

## 10. SEO and release gates

Production release must prove:

- representative indexable pages contain primary content in initial HTML;
- unique title/H1/description/canonical;
- robots and sitemap correct for the environment;
- staging has layered noindex protection;
- structured data parses and matches visible facts;
- no broken internal links or orphan indexable routes;
- mobile/responsive E2E passes;
- agreed performance budgets pass in lab and field monitoring is configured;
- Search Console verification and sitemap submission are documented for the product;
- placeholder keywords/copy/images are absent.

## 11. Legal and operational gates

- operator identity/contact facts completed;
- enabled providers match privacy disclosure;
- actual retention behavior matches policy;
- one-time, subscription, credit, refund, and cancellation terms match code/provider behavior;
- account deletion UI and policy agree;
- consent behavior and analytics disclosure agree;
- support/refund/reconciliation procedure exists;
- legal documents have versions/effective dates;
- high-risk or material-revenue products receive legal review appropriate to risk.

## 12. Implementation PR plan

### PR 0 — design approval

Documents only. Resolve independent review findings. No application code.

### PR 1 — foundation

- Next.js/TypeScript project scaffold;
- package manager and lockfile;
- lint/typecheck/test/build;
- environment validation skeleton;
- dependency-boundary enforcement;
- PostgreSQL CI service and migration test harness;
- basic error/logging/redaction conventions.

Exit: empty application builds and quality gates run.

### PR 2 — database and authentication

- platform migrations for Better Auth/rate limits;
- Better Auth Google and magic link;
- Resend/test email transport;
- sessions, authorization helpers, account settings/deletion state;
- auth integration and E2E tests.

Exit: complete auth security acceptance criteria pass in staging/test.

### PR 3 — SEO, homepage, and legal shell

- site/SEO configuration schemas;
- metadata/canonical/robots/sitemap/JSON-LD;
- route classification;
- Header/Footer and landing sections;
- legal page/config/version framework;
- SEO/accessibility/browser checks.

Exit: sample public site passes technical SEO and no-placeholder gates.

### PR 4 — commerce core and Waffo one-time purchase

- catalog, orders, payments, webhook inbox/outbox;
- Waffo test-mode checkout and verification;
- idempotent fulfillment interface;
- reconciliation and operator inspection basics;
- contract/integration/E2E/fault tests.

Exit: one-time purchase is end-to-end reliable without credits.

### PR 5 — credit ledger

- grants, ledger entries, reservations, expiry, revocation;
- transactional concurrency and reconciliation;
- product fulfillment example;
- one-time credit purchase mapping;
- refund reversal behavior.

Exit: balances remain correct under duplicates/concurrency/failure.

### PR 6 — subscriptions

- subscription and period models;
- Waffo subscription checkout/events/reconciliation;
- active/past-due/canceling/canceled/restore policy;
- period credit grants;
- refund/cancellation support;
- no unsupported upgrade/downgrade promise.

Exit: subscription lifecycle and credit issuance pass real test-mode flows.

### PR 7 — analytics, consent, security, observability

- GA4/optional Clarity consent behavior;
- event allowlists/redaction;
- Turnstile/rate-limit integration completion;
- CSP/security headers;
- health, metrics, alerts, dead-letter visibility;
- backup/restore/key-rotation runbooks.

Exit: operational/security gates pass.

### PR 8 — starter validation

- create a neutral sample product from the starter;
- execute setup documentation from a clean environment;
- deploy isolated staging;
- run full production-readiness checklist;
- record template version and changelog/upgrade notes.

Exit: another agent/developer can launch the sample without undocumented manual code edits.

## 13. Template versioning and downstream projects

V1 does not automate upgrades.

It must still include:

- semantic template version marker;
- changelog;
- migration/setup notes;
- security advisory process for owned projects;
- list of files/modules affected by each significant platform fix;
- instructions for cherry-picking or manually porting a fix;
- no silent history rewriting.

After two or three real products, stable modules may move to private versioned packages. This decision is based on observed repeated changes, not the current design alone.

## 14. Definition of done for the starter

The starter is not done merely because a sample page deploys.

It is done when a clean new project can:

- configure a new site identity/domain;
- configure Google and magic link securely;
- enable/disable one-time payments, subscriptions, and credits coherently;
- connect isolated Waffo test products;
- run migrations from empty PostgreSQL;
- pass all CI gates;
- deploy staging without indexing or live charges;
- complete auth/payment/credit E2E;
- supply required SEO/legal/product configuration without editing platform internals;
- show no Quick I Ching domain names, concepts, IDs, copy, or assumptions.

## 15. Code-start gate

Do not write application code until:

1. another AI or engineer reviews all design documents;
2. findings are classified as blocking, important, optional, or incorrect;
3. blocking and important findings are resolved in the design;
4. the owner approves the reviewed design;
5. PR 1 receives a file-level implementation plan and test list;
6. the assistant explicitly states: **“设计已经定稿，现在可以开始写代码。”**

Until all six conditions hold, only documentation/review changes are permitted.

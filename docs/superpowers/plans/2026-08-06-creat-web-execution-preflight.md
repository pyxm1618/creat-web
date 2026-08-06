# creat-web Execution Preflight and Binding Corrections

> **For all implementation agents:** Read this document after the master plan and before any phase plan. The rules below supersede any conflicting illustrative snippet in the phase plans. They are binding corrections found during the Superpowers plan self-review.

**Status:** implementation remains blocked pending independent design review and owner approval.

## 1. Toolchain baseline

The first foundation branch must begin with these stable baselines, then commit the exact resolved lockfile:

```text
Bun: 1.3.14
Next.js: 16.2.12
React / React DOM: 19.2.8
Better Auth: 1.6.25
@better-auth/drizzle-adapter: 1.6.25
Drizzle ORM: 0.45.2
Drizzle Kit: 0.31.10
Waffo Pancake SDK: 0.16.1, retained initially because it is the already exercised Quick I Ching reference version
```

Do not use `@latest` inside committed implementation instructions. Before installation, verify each version still exists and has no applicable critical advisory. Any version change requires an ADR, frozen lockfile, and full gate before merge.

## 2. Application environment is not `NODE_ENV`

Next.js sets `NODE_ENV=production` during `next build`, including CI builds that must not require real provider credentials. Runtime validation therefore uses a separate variable:

```ts
export type AppEnvironment = "local" | "test" | "staging" | "production";
```

```text
APP_ENV=local       local developer server
APP_ENV=test        CI, unit, integration and browser tests
APP_ENV=staging     isolated deployed staging with test providers
APP_ENV=production  live application
```

Rules:

- `NODE_ENV` controls framework optimization only.
- `APP_ENV` controls origins, credentials, provider mode, analytics, robots and release checks.
- Foundation default feature configuration keeps all external providers disabled.
- The auth, commerce and analytics plans enable their modules only after their own environment/test setup exists.
- `next build` with `APP_ENV=test` must succeed without Google, Resend, Waffo, Turnstile or analytics credentials.
- `APP_ENV=production` fails closed if an enabled module lacks valid production credentials.

Runtime environment fields use explicit unions such as `string | undefined`; do not combine `exactOptionalPropertyTypes` with object literals that explicitly assign `undefined` to optional fields.

## 3. Configuration types are deeply readonly

Committed configuration is declared `as const`. `ProductConfig`, feature configuration and route/legal/product configuration types must accept deeply readonly input. Validation returns a parsed immutable value rather than requiring callers to cast away readonly types.

Use either:

```ts
const config = { /* values */ } as const satisfies ProductConfigInput;
```

or Zod input/output types that preserve read-only public exports.

## 4. Database client and migration rules

`src/platform/database/client.ts` must export both a factory for isolated tests and one server-only singleton for application composition:

```ts
import "server-only";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "@/platform/config/env";
import * as schema from "./schema";

export function createDatabaseClient(url: string) {
  const client = postgres(url, { prepare: false });
  return {
    db: drizzle(client, { schema }),
    close: () => client.end(),
  };
}

const applicationDatabase = createDatabaseClient(env.databaseUrl);
export const db = applicationDatabase.db;
```

Migration rules:

- Define the foundation table in Drizzle schema first.
- Run `drizzle-kit generate`; do not hand-create an isolated SQL file without Drizzle metadata/journal entries.
- Apply generated migrations with the Drizzle migrator.
- Verify the migration history table using the configured Drizzle migration schema/table, not by assuming it exists in `public`.
- The integration test resets an isolated test database/schema, applies the complete migration history, applies it again, and compares the resulting schema to expected invariants.
- Production deployment uses versioned migrations, never `drizzle-kit push`.

## 5. Better Auth composition and Magic Link storage

Use these stable packages and imports:

```ts
import { betterAuth } from "better-auth/minimal";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
```

The auth configuration must explicitly hash magic-link tokens:

```ts
plugins: [
  magicLink({
    expiresIn: 60 * 10,
    storeToken: "hashed",
    sendMagicLink: async ({ email, url }) => sendMagicLinkEmail({ email, url }),
  }),
],
verification: {
  storeIdentifier: "hashed",
  storeInDatabase: true,
},
rateLimit: {
  enabled: true,
  storage: "database",
  modelName: "rateLimit",
},
```

Additional rules:

- Run `bunx auth@1.6.25 generate`, not an unpinned CLI tag.
- Apply the generated Drizzle schema through Drizzle migrations.
- Pass generated tables/relations through the adapter exactly as generated.
- Regeneration must produce no unexpected diff.
- Database verification storage is retained so atomic consume coordinates across instances; do not switch to secondary storage without a tested atomic `getAndDelete` implementation.
- The callback-path allowlist is applied before calling the sign-in method and the generated email URL is revalidated against `APP_ORIGIN` before send.
- Account-linking behavior is not implemented through custom email equality. Test Google-first and Magic-Link-first flows against Better Auth's reviewed account-linking configuration.

## 6. SEO route-registry test corrections

The initial route-registry fixture must be internally coherent:

- Every `relatedRoutes` target exists in the same registry.
- To test duplicate canonical rejection, the duplicate route explicitly sets `canonical: "/"`; merely cloning the homepage under `/duplicate` creates a different canonical and must not be expected to fail.
- Route paths are normalized according to the declared lowercase URL policy; never lowercase arbitrary user/content identifiers after routing semantics are established.
- Static public pages remain eligible for prerendering; security policy must not accidentally force the entire site dynamic.

## 7. Provider contract capture is a hard input, not a placeholder

The Waffo plans begin with test-account contract capture because dashboard headers, event names and capabilities can change. The capture task must commit observed non-secret facts before adapter implementation.

The committed contract is structured data, not prose with angle-bracket placeholders:

```ts
export const waffoContract = {
  capturedAtUtc: "2026-08-06T00:00:00.000Z",
  dashboardEnvironment: "test",
  sdkVersion: "0.16.1",
  environmentHeaderName: "X-Environment",
  environmentHeaderTestValue: "test",
  signatureHeaderName: "the exact observed header name",
  signatureEncoding: "the exact observed encoding",
  selectedEventNames: ["the exact observed event names"],
  customerPortalSupported: false,
  inPlacePlanChangeSupported: false,
} as const;
```

The timestamp and observed strings above are examples of the required shape, not values to copy. The implementation branch must replace the entire example object with test-account observations in the first contract-capture commit; automated validation rejects strings beginning with `the exact observed`.

Adapter code reads contract data:

```ts
const signature = request.headers.get(waffoContract.signatureHeaderName);
```

It never contains a temporary literal header name. Contract capture is complete only when:

- no placeholder marker remains;
- fixture schema hashes match committed fixtures;
- test/live isolation is recorded;
- a reviewer compares the values with the dashboard and sanitized request evidence.

## 8. Commerce type corrections

Define every referenced type before use. In particular:

```ts
export type NormalizedPaymentSnapshot = {
  externalOrderId: string;
  externalPaymentId: string;
  status: "pending" | "succeeded" | "failed" | "canceled";
  amount: Money;
  occurredAt: Date;
};
```

The `payments` table includes `environment`; uniqueness is `(environment, external_payment_id)`. Every provider-derived order, payment, subscription, refund and event carries environment and merchant/store identity through normalization and persistence.

The Waffo signature implementation is written only after the captured contract identifies exact signature input, algorithm and encoding. Do not commit a hex-HMAC implementation while the observed provider contract differs.

## 9. Credit finalization correction

The illustrative `withCreditReservation` helper in the credit plan must not release a reservation after durable product output has already been saved but credit commit temporarily fails. That would deliver the product and return the credit.

Required states:

```text
reserved
work_failed -> released
work_succeeded_pending_commit -> committed
work_succeeded_pending_commit -> retry/dead-letter until committed or explicitly repaired
```

Required flow:

1. Reserve credits transactionally.
2. Execute product work without an open database transaction.
3. If work fails before durable output exists, release idempotently.
4. Persist product output and a `credit_finalization_job` in one transaction, or persist output with an equivalent unique finalization marker.
5. Commit the reservation through an idempotent finalizer.
6. If commit fails after durable output, never release automatically; retry finalization and show delivery/finalization pending according to product policy.
7. Reconciliation detects delivered output with uncommitted reservation and repairs through the same commit operation.

Add fault tests for crash after output persistence, database outage during commit, duplicate finalizer, and dead-letter repair.

## 10. CSP strategy correction

A nonce-based CSP on every route would force all Next.js pages to dynamic rendering, disable static optimization and conflict with the SEO-first requirement. V1 uses route-scoped policies:

### Public static/indexable routes

- Remain statically generated/cacheable where possible.
- Use the documented non-nonce Next.js CSP baseline.
- Production allows the minimum required `'unsafe-inline'` in `script-src` for Next.js bootstrap only; `'unsafe-eval'` is forbidden in production.
- Third-party analytics still loads only after consent and from explicit origins.
- Track removal of `'unsafe-inline'` as future hardening when stable SRI/hash support is production-proven.

### Authenticated/private routes

- Use `src/proxy.ts` to generate a per-request nonce.
- Are dynamically rendered by design.
- Use `script-src 'self' 'nonce-…' 'strict-dynamic'` without production `'unsafe-inline'` or `'unsafe-eval'`.
- Pass the nonce through request headers to layouts/scripts as required by current Next.js documentation.

Tests must prove:

- public indexable routes stay prerenderable;
- private routes receive a fresh nonce per request;
- the nonce policy does not run on static assets/API routes unnecessarily;
- both policy sets permit the required application flows and block an injected inline script fixture;
- any future CSP change is reviewed against SEO rendering/caching consequences.

## 11. Final pre-implementation verification

Before the foundation branch is created, the implementation agent must convert these corrections into the relevant phase-plan checklist and confirm:

```text
[ ] APP_ENV separation adopted
[ ] read-only configuration types adopted
[ ] generated Drizzle migration workflow adopted
[ ] application db singleton and test factory both defined
[ ] Better Auth/adapter/CLI versions pinned together
[ ] magicLink.storeToken = hashed
[ ] verification identifiers hashed in database
[ ] route registry fixtures coherent
[ ] Waffo contract capture format contains no placeholder values
[ ] all normalized commerce types defined
[ ] payment environment persisted
[ ] delivered product can never trigger automatic credit release
[ ] route-scoped CSP preserves static SEO pages
```

If any phase plan conflicts with this document, stop and amend the phase plan or implementation to follow this document before coding.

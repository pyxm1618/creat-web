# creat-web Gemini Review Execution Corrections

> **For all implementation agents:** Read this document after `2026-08-06-creat-web-execution-preflight.md` and before any phase plan. It is binding and supersedes conflicting file maps, interfaces, tasks or test examples in earlier execution plans.

**Status:** implementation remains blocked pending independent review of the corrected plan suite and owner approval.

## 1. Cross-plan file additions

The following files are now required:

```text
src/platform/accounts/account-subject.ts
src/platform/accounts/account-subject-repository.ts
src/platform/database/account-subject-schema.ts
src/platform/auth/magic-link-confirmation.ts
src/app/(account)/auth/magic-link/confirm/page.tsx
src/app/api/auth/magic-link/confirm/route.ts
src/platform/config/runtime-factories.ts
src/platform/commerce/domain/currency-exponents.ts
src/platform/seo/environment-metadata.ts
src/platform/analytics/route-policy.ts
```

Tests added across phases:

```text
tests/integration/accounts/account-deletion-retention.test.ts
tests/integration/auth/magic-link-prefetch.test.ts
tests/e2e/auth-magic-link-confirmation.spec.ts
tests/unit/config/disabled-provider-evaluation.test.ts
tests/build/feature-matrix.test.ts
tests/unit/commerce/currency-exponents.test.ts
tests/unit/seo/environment-metadata.test.ts
tests/e2e/analytics-network-consent.spec.ts
tests/unit/subscriptions/grace-period.test.ts
tests/integration/subscriptions/grace-period-persistence.test.ts
```

## 2. Foundation plan corrections

### 2.1 Environment/build matrix

The foundation plan must introduce a build-matrix test harness rather than a single build command.

Required command interface:

```json
{
  "scripts": {
    "build:test": "APP_ENV=test next build",
    "test:build-matrix": "bun run tests/build/run-feature-matrix.ts"
  }
}
```

The matrix verifies:

1. all external integrations disabled with no provider variables;
2. representative feature-specific configuration fixtures;
3. production-negative fixtures fail because enabled secrets are missing;
4. disabled modules do not instantiate clients or read their own environment keys.

The test may spawn `bun run build:test` in isolated environment maps and assert exit status/output. It must not use real provider credentials.

### 2.2 Side-effect-free module rule

Architecture verification adds these checks:

- provider SDK construction occurs only inside feature-scoped factories or composition functions;
- server-only modules may expose factories, but importing them with the feature disabled must not throw;
- no module-level call to `requireEnv()` exists in optional provider modules;
- no Waffo/Resend/Turnstile/analytics client is exported as an eagerly created singleton;
- database application singleton is allowed because database is mandatory, but isolated factory remains available to tests.

Commit boundary: amend the foundation configuration/architecture task, not a later cleanup PR.

## 3. Authentication plan corrections

### 3.1 Add retained account subject before product foreign keys

After Better Auth schema generation, add a dedicated task:

**Files:**

- Create `src/platform/database/account-subject-schema.ts`
- Create `src/platform/accounts/account-subject.ts`
- Create `src/platform/accounts/account-subject-repository.ts`
- Modify `src/platform/database/schema.ts`
- Add generated Drizzle migration
- Test `tests/integration/accounts/account-subject.test.ts`

**Interface:**

```ts
export type AccountSubjectStatus = "active" | "deletion_pending" | "deleted";

export type AccountSubject = {
  id: string;
  authUserId: string | null;
  status: AccountSubjectStatus;
  pseudonymousKey: string;
  createdAt: Date;
  deletionRequestedAt: Date | null;
  deletedAt: Date | null;
};

export interface AccountSubjectRepository {
  createForAuthUser(authUserId: string): Promise<AccountSubject>;
  getActiveByAuthUserId(authUserId: string): Promise<AccountSubject | null>;
  beginDeletion(subjectId: string): Promise<void>;
  detachAuthIdentity(subjectId: string, authUserId: string): Promise<void>;
  completeDeletion(subjectId: string): Promise<void>;
}
```

The pseudonymous key is `crypto.randomUUID()` or equivalent random value and is not derived from email.

Tests prove unique one-to-one active linking, no credential fields, detach without deleting subject, and idempotent status transitions.

### 3.2 Replace direct magic-link verification with explicit confirmation

The authentication plan's Magic Link tasks are replaced as follows.

**Email generation:**

```ts
export function buildMagicLinkConfirmationUrl(input: {
  appOrigin: string;
  token: string;
  returnTo: string;
}): string {
  const returnTo = assertAllowedRelativeCallback(input.returnTo);
  const url = new URL("/auth/magic-link/confirm", input.appOrigin);
  url.hash = new URLSearchParams({ token: input.token, returnTo }).toString();
  return url.toString();
}
```

The Better Auth direct verification URL is never emailed.

**Confirmation page rules:**

- client component reads fragment once;
- calls `history.replaceState(null, "", pathname)` immediately after safe parsing;
- stores token only in component memory;
- renders no third-party component or script;
- sends POST only after explicit click;
- response headers include `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, and `X-Robots-Tag: noindex, nofollow`.

**POST route input:**

```ts
const confirmMagicLinkSchema = z.object({
  token: z.string().min(32).max(2048),
  returnTo: z.string().max(512),
});
```

The route validates exact Origin, content type, callback allowlist and durable attempt limits, then invokes Better Auth's reviewed server verification function. Do not expose a public GET verification route.

**Required red-green tests:**

1. scanner GET repeated three times, then user POST succeeds;
2. second POST fails as consumed;
3. raw emailed URL does not contain `/api/auth/magic-link/verify` or `/magic-link/verify`;
4. fragment is absent from server access requests;
5. no third-party browser request on confirmation page;
6. malicious `returnTo` and Origin fail;
7. token is absent from logs.

### 3.3 Account deletion orchestration

The deletion workflow now consumes a retained subject ID.

```ts
requestAccountDeletion({ authUserId, subjectId }): Promise<{ requestId: string }>;
processAccountDeletion({ requestId }): Promise<DeletionResult>;
```

Before Better Auth hard deletion, the workflow must:

- block new commerce/credit/product writes;
- coordinate subscription cancellation;
- delete/anonymize product data;
- detach `auth_user_id` from the retained subject.

Only then may it call the Better Auth deletion operation. The workflow retains financial evidence through `subject_id`.

Integration tests inject a failure before and after detach, then retry and prove no duplicate cancellation, no deleted financial record and no `23503` error.

## 4. SEO plan corrections

### 4.1 Environment metadata policy

Add:

```ts
export type EnvironmentMetadataPolicy = {
  metadataBase: URL;
  emitCanonical: boolean;
  emitSitemap: boolean;
  robots: "index-follow" | "noindex-nofollow";
};

export function environmentMetadataPolicy(input: {
  appEnv: AppEnvironment;
  currentOrigin: URL;
  productionOrigin: URL;
}): EnvironmentMetadataPolicy;
```

Expected behavior:

- production: production metadata base, canonical enabled, sitemap enabled;
- local/test/staging: current origin metadata base, canonical disabled, sitemap disabled, noindex/nofollow.

`buildMetadata()` must omit `alternates.canonical` when `emitCanonical=false`; it must not emit `canonical: undefined` if strict optional typing rejects it.

### 4.2 SEO/browser tests

Tests assert:

- production HTML has correct canonical;
- staging HTML has no canonical element, no sitemap link/submission and no production origin in head metadata;
- staging response includes noindex headers/directives;
- robots and access controls remain defense-in-depth.

## 5. Commerce one-time plan corrections

### 5.1 Currency exponent implementation

Replace the small illustrative four-currency map with an audited, versioned supported-currency registry.

```ts
export type SupportedCurrency = "USD" | "EUR" | "GBP" | "JPY" | "BHD";

export const CURRENCY_EXPONENT: Readonly<Record<SupportedCurrency, 0 | 2 | 3>> = {
  USD: 2,
  EUR: 2,
  GBP: 2,
  JPY: 0,
  BHD: 3,
};
```

The actual starter may support fewer currencies initially, but every enabled currency must have a reviewed exponent. Do not silently accept arbitrary ISO codes.

```ts
export type ProviderDisplayMoney = {
  currency: SupportedCurrency;
  display: string;
};

export function providerDisplayToMoney(value: ProviderDisplayMoney): Money;
```

Required tests include:

```text
USD "29.00" -> 2900n
JPY "4500" -> 4500n
BHD "1.250" -> 1250n
USD "29.001" -> reject
JPY "1.00" -> reject unless provider contract explicitly permits canonical equivalent
unknown currency -> reject
negative/scientific/NaN/overflow -> reject
```

Database schemas store `amount_minor BIGINT`, constrained currency and sanitized provider display string. Local snapshot, accepted webhook and reconciliation query must match before transition to fulfilled.

### 5.2 Commerce-only fulfillment

Create `TestRecordingOrderFulfillment` only under test support.

Production composition must throw/release-block when an enabled paid product has no fulfillment binding. A payment can be `succeeded` while fulfillment remains `pending_configuration`; it must never be marked fulfilled by a no-op.

## 6. Credit plan corrections

All credit tables reference `subject_id`, not Better Auth `user_id`.

Account deletion rules:

- no new reserve after `deletion_pending`;
- active reservations are resolved according to product state before completion;
- unused credit policy is explicit and source-linked;
- historical ledger remains immutable where legally/operationally retained;
- user-facing credit access ends immediately when authentication/session is revoked.

The existing execution preflight rule remains binding: once product output is durably delivered, a credit-commit failure creates a repair state and must not automatically release the reservation.

## 7. Subscription/refund plan corrections

### 7.1 Schema additions

Add to `subscriptions`:

```text
past_due_started_at TIMESTAMPTZ NULL
past_due_grace_ends_at TIMESTAMPTZ NULL
grace_policy_version TEXT NULL
```

Constraints/application checks:

- grace end cannot precede past-due start;
- non-`past_due` stable states clear stale grace fields unless transition/reconciliation is in progress;
- policy version references the immutable product/subscription policy snapshot.

### 7.2 State transition API

```ts
export type PastDuePolicy = {
  version: string;
  graceDays: number;
};

export type SubscriptionFact =
  | { type: "payment_failed"; occurredAt: Date; providerGraceEndsAt?: Date }
  | { type: "payment_recovered"; occurredAt: Date; periodStart: Date; periodEnd: Date }
  | /* existing facts */ never;
```

On `payment_failed`, compute and persist the deadline once. Do not recalculate on each authorization request.

```ts
export function subscriptionAccessDecision(snapshot: {
  status: SubscriptionStatus;
  currentPeriodEnd: Date | null;
  pastDueGraceEndsAt: Date | null;
}, now: Date): AccessDecision;
```

The function does not issue credits for `past_due`.

### 7.3 Required tests

- exact grace boundary before/equal/after deadline;
- duplicate failure event keeps the original reviewed deadline unless authoritative newer provider data supersedes it;
- policy configuration changes do not rewrite existing deadline;
- recovery clears grace fields and creates at most one paid period;
- stale/out-of-order events cannot restore expired grace;
- reconciliation can repair a missing/incorrect projection with an audit record.

## 8. Security/operations plan corrections

### 8.1 Analytics route policy

```ts
export type AnalyticsRoutePolicy = "consent_gated" | "forced_disabled";
```

Forced-disabled routes include at minimum:

- magic-link confirmation;
- auth callback/error pages where tokens/codes may appear;
- checkout return/status where provider identifiers may appear;
- account deletion verification;
- private generated-result pages unless explicitly reviewed.

### 8.2 Network-level E2E

Playwright intercepts and records requests matching configured analytics domains.

Required scenarios:

1. first visit/unknown consent: zero analytics requests;
2. reject: zero requests across navigation;
3. accept: expected loader and collection request appears;
4. withdraw then reload/navigate: zero new requests;
5. forced-disabled route after general acceptance: zero requests;
6. initial HTML has no unconditional third-party analytics script/preconnect/prefetch.

## 9. Updated phase gates

### General code-start gate

No application code until:

1. the five original specs plus `creat-web-v1-gemini-review-resolution.md` are independently reviewed;
2. the full plan suite plus this file are independently reviewed;
3. every resulting BLOCKING/IMPORTANT finding is resolved;
4. owner approves;
5. assistant states `设计已经定稿，现在可以开始写代码。`

### Waffo-specific gate

The Waffo contract-capture task is mandatory immediately before Waffo adapter implementation, not before unrelated foundation/auth/SEO phases.

## 10. Verification commands added

```bash
bun run test:build-matrix
bun run test:unit -- tests/unit/config/disabled-provider-evaluation.test.ts
bun run test:integration -- tests/integration/accounts/account-deletion-retention.test.ts
bun run test:integration -- tests/integration/auth/magic-link-prefetch.test.ts
bun run test:e2e -- tests/e2e/auth-magic-link-confirmation.spec.ts
bun run test:unit -- tests/unit/commerce/currency-exponents.test.ts
bun run test:unit -- tests/unit/seo/environment-metadata.test.ts
bun run test:e2e -- tests/e2e/analytics-network-consent.spec.ts
bun run test:unit -- tests/unit/subscriptions/grace-period.test.ts
bun run test:integration -- tests/integration/subscriptions/grace-period-persistence.test.ts
```

Every command is introduced together with its script/config in the phase that first needs it; these commands are not evidence until the implementation creates and runs them successfully.

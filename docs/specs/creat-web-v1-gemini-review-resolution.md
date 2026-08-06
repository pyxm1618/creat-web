# creat-web v1 Gemini Review Resolution

- Date: 2026-08-06
- Status: binding design correction
- Applies to: all five documents under `docs/specs/`
- Implementation status: still blocked pending independent plan review and owner approval

## 1. Precedence

This document is a binding correction to:

1. `creat-web-v1-master-design.md`
2. `auth-security-design.md`
3. `payments-subscriptions-credits-design.md`
4. `seo-home-legal-design.md`
5. `quality-migration-release-design.md`

If any earlier statement conflicts with this document, this document wins. Quick I Ching remains read-only.

## 2. Review disposition

| Finding | Decision | Final severity |
|---|---|---|
| Account deletion vs retained commerce/credit records | Accepted with redesigned retained-subject model | BLOCKING |
| Magic-link prefetch/scanner consumption | Accepted with two-step explicit confirmation | BLOCKING |
| Disabled feature build failure from eager module evaluation | Accepted; narrower root cause | IMPORTANT |
| Waffo amount/minor-unit ambiguity | Accepted with corrected Waffo contract | IMPORTANT |
| Staging canonical behavior | Accepted with revised non-production policy | IMPORTANT |
| Analytics before consent | Existing architecture retained; test gate strengthened | IMPORTANT control |
| `past_due` grace-period ambiguity | Accepted with persisted deadline | IMPORTANT |
| Optional `PageSeo` relaxation | Rejected; discriminated route types already solve it | NOT A FINDING |
| Production `NoopOrderFulfillment` | Rejected; test recorder only | OPTIONAL/test-only |

## 3. Retained account subject and deletion-safe foreign keys

### 3.1 Decision

Better Auth's `user` remains the canonical active authentication identity. Commerce, subscriptions, credits, legal acceptance, account deletion, and other records that may need to survive identity deletion reference a separate retained platform subject.

This retained subject is not a second authentication user table. It stores no credential, password, OAuth token, session token, or sign-in method.

### 3.2 Required table

```text
account_subjects
- id: UUID primary key
- auth_user_id: Better Auth user ID, nullable, unique
- status: active | deletion_pending | deleted
- pseudonymous_key: random irreversible identifier, unique
- created_at
- deletion_requested_at nullable
- deleted_at nullable
```

Rules:

- a subject is created transactionally when or immediately after a Better Auth user is created;
- active product records use `subject_id`, not a direct foreign key to `user.id`;
- `auth_user_id` uses `ON DELETE SET NULL` or is cleared before Better Auth hard deletion;
- `orders`, `payments`, `subscriptions`, `subscription_periods`, `refunds`, `credit_grants`, `credit_ledger_entries`, and legally required acceptance/audit records reference `account_subjects.id`;
- product-private content may reference either subject or user according to its deletion policy, but must not block identity deletion;
- no stable hash of email is used as the retained identifier because it can remain personal data and permits correlation attacks;
- `pseudonymous_key` is randomly generated and cannot be derived from email, OAuth ID, payment ID, or other PII.

### 3.3 Deletion workflow

Deletion is a state machine, not a single cascade:

```text
active -> deletion_pending -> deleted
```

Required sequence:

1. authenticate the current user and require a fresh session or verified deletion link;
2. create/idempotently reuse a deletion request and set the subject to `deletion_pending`;
3. stop new purchases, subscriptions, credit reservations, and product mutations for the subject;
4. revoke all sessions and provider accounts needed for access;
5. cancel or otherwise resolve active renewing subscriptions according to the provider/product policy;
6. release active credit reservations and revoke or expire unused credits according to policy;
7. delete or irreversibly anonymize product-private content according to the documented retention schedule;
8. remove profile/contact PII and clear `account_subjects.auth_user_id`;
9. hard-delete the Better Auth user only after the retained subject is detached and downstream blockers are resolved;
10. retain only the minimum commerce, accounting, dispute, fraud, reconciliation, and security records justified by law/operations;
11. mark the retained subject `deleted` and record an audit event without retaining deleted PII.

Failures are retryable. A partially completed deletion remains `deletion_pending`; it must not silently return to active.

### 3.4 Foreign-key policy

Forbidden:

- `ON DELETE CASCADE` from Better Auth user to financial/credit/subscription records;
- `ON DELETE RESTRICT` chains that make identity deletion impossible;
- using nullable direct `user_id` alone as the only historical owner/correlation key;
- retaining email, full name, OAuth subject, or raw provider profile solely to correlate deleted records.

Required integration tests:

- a paid user can complete account deletion without PostgreSQL `23503` errors;
- Better Auth user/session/account/verification rows are deleted or revoked;
- retained order/payment/refund/subscription records survive and remain internally coherent;
- retained subject contains no direct authentication identity after completion;
- cross-user access is impossible before, during, and after deletion;
- retry after failure at every workflow step is idempotent.

## 4. Magic link two-step explicit confirmation

### 4.1 Problem

Better Auth's magic-link verification endpoint consumes the token atomically on the first verification attempt. Mail gateways and security scanners may fetch links before the user. Therefore the raw Better Auth verification URL must not be placed directly in email.

### 4.2 Required flow

The `sendMagicLink` callback receives the Better Auth token and constructs a neutral confirmation URL:

```text
https://app.example/auth/magic-link/confirm#token=<token>&returnTo=<approved-relative-path>
```

The email link performs no verification and no session creation.

The confirmation page:

- is a client boundary only for reading the URL fragment;
- does not send the token during the initial GET request;
- displays the site name, destination and an explicit `Confirm sign in` button;
- has `noindex,nofollow`, `Cache-Control: no-store`, and `Referrer-Policy: no-referrer`;
- loads no GA4, Clarity, advertising, third-party images, external fonts, customer chat, or other third-party request;
- immediately clears the token from browser history after copying it into memory;
- accepts only an allowlisted relative `returnTo` path.

On explicit user action the page sends:

```text
POST /api/auth/magic-link/confirm
Content-Type: application/json
Origin: exact APP_ORIGIN
Body: { token, returnTo }
```

The server route:

1. validates Origin and content type;
2. validates the relative callback allowlist;
3. applies IP and token-attempt rate limits;
4. calls the reviewed Better Auth server verify API with the token;
5. lets Better Auth atomically consume the hashed database token and establish the session;
6. returns a safe redirect result;
7. never logs the token, URL, cookie, or email.

The implementation may internally invoke Better Auth's documented manual `magicLinkVerify` API, which currently exposes GET-style query input. The public application endpoint remains POST-only; the token is never placed in the public request URL.

### 4.3 Required tests

- email contains only the neutral confirmation URL, never Better Auth's direct verify URL;
- GET confirmation-page requests, including repeated simulated scanner requests, do not consume the token;
- first valid POST succeeds and creates a session;
- second POST fails safely as already used;
- expired token fails safely;
- untrusted Origin, external callback, missing content type, and malformed token are rejected;
- confirmation HTML and browser trace contain no analytics/third-party network request;
- token is absent from server access logs, analytics, browser history after confirmation, and referrer headers.

## 5. Disabled integrations and build-time evaluation

### 5.1 Binding rule

A disabled integration must be absent not only from navigation and routes, but also from eager runtime composition.

Provider/platform modules must not at module top level:

- require feature-specific environment variables;
- construct Better Auth social-provider configuration that requires disabled secrets;
- instantiate Waffo, Resend, Turnstile, GA4, Clarity, or other clients;
- open network/database connections solely for a disabled feature;
- execute provider discovery or capability queries.

Pure type imports and side-effect-free SDK imports are allowed.

### 5.2 Factory/composition pattern

Use feature-scoped factories:

```ts
export function createAuthRuntime(features: AuthFeatureConfig) {
  if (!features.enabled) return null;
  const env = parseAuthEnvironment(features);
  return buildBetterAuthRuntime({ features, env });
}
```

```ts
export function createCommerceRuntime(features: CommerceFeatureConfig) {
  if (!features.enabled) return null;
  const env = parseCommerceEnvironment(features);
  return buildCommerceRuntime({ features, env });
}
```

Environment validation is also feature-scoped. Global environment parsing validates only universally required values plus enabled-module requirements.

### 5.3 Required build matrix

CI builds at least:

1. all external providers disabled, no provider secrets;
2. auth enabled with test transport and no Google provider;
3. Google enabled with test/staging credentials;
4. commerce disabled with no Waffo variables;
5. commerce enabled in test mode with test IDs;
6. analytics disabled with no IDs;
7. production-mode negative fixtures proving missing enabled credentials fail closed.

## 6. Waffo amounts and money representation

### 6.1 Correct provider contract

Current Waffo documentation represents monetary amounts as display-format strings, for example:

```text
USD "29.00"
JPY "4500"
```

The implementation must not assume Waffo returns integer minor units unless the captured test-account contract proves a specific field does so.

### 6.2 Internal representation

```ts
export type Money = {
  currency: SupportedCurrency;
  minor: bigint;
};
```

Database columns:

```text
currency: CHAR(3) or constrained text
amount_minor: BIGINT
provider_amount_display: TEXT
```

Rules:

- the Waffo adapter parses provider display strings using an audited ISO-4217 exponent table;
- unknown or disabled currencies fail closed;
- excess decimal precision fails closed;
- no JavaScript `number` or binary floating point is used for payment comparison, refund arithmetic, price validation or credit fulfillment;
- local product snapshot, webhook fact, and provider reconciliation result must agree on currency and minor amount before fulfillment;
- preserve the sanitized original display string for reconciliation/audit;
- `numeric(12,2)` is not the universal storage model because some currencies have zero or three fractional digits.

Required tests include zero-, two- and three-decimal currencies, leading/trailing zeroes, malformed values, over-precision, negative values, overflow and currency mismatch.

## 7. Non-production canonical and indexing policy

### 7.1 Production

- `metadataBase` uses the validated production origin;
- approved public routes emit production canonicals;
- production sitemap contains only approved canonical indexable routes.

### 7.2 Staging, preview and test

- do not emit a canonical link for normal staging/preview pages;
- `metadataBase` may use the current environment origin only for required absolute assets such as Open Graph images;
- send `X-Robots-Tag: noindex, nofollow` and page-level noindex where appropriate;
- block broad crawling in robots as defense-in-depth;
- do not publish or submit a sitemap;
- use deployment access control where feasible;
- never emit a production canonical from a non-production deployment;
- never self-canonicalize staging as an indexable authority.

Required tests inspect rendered HTML and headers in production and non-production modes.

## 8. Consent-gated analytics network behavior

Analytics adapters remain optional and consent-gated.

Binding requirements:

- no GA4/Clarity remote script, preload, preconnect, DNS-prefetch, pixel, iframe or network request before granted consent;
- root layout may render the consent manager, but it must not unconditionally render remote analytics scripts;
- analytics loaders are client-side and execute only after validated consent state is `granted`;
- rejected/unknown consent does not initialize the provider;
- withdrawal prevents future loading and disables supported provider storage/collection behavior;
- authentication, magic-link confirmation, checkout, private result, deletion and other sensitive pages may apply an explicit analytics-disabled route policy even after general consent;
- event schemas prohibit PII, private content, auth data and billing details.

Browser E2E must intercept requests and prove zero calls to GA4/Clarity domains before consent, after rejection, and on forced-disabled sensitive routes. It must prove loading occurs only after acceptance and stops after withdrawal/reload.

## 9. Persisted subscription grace period

Add to the local subscription projection:

```text
past_due_started_at nullable
past_due_grace_ends_at nullable
grace_policy_version nullable
```

On transition to `past_due`:

1. use an authoritative provider deadline if the captured Waffo contract supplies one;
2. otherwise compute the deadline once from the immutable product/subscription policy snapshot;
3. persist the deadline and policy version in the same transaction as the state transition;
4. do not recompute old subscriptions from a later configuration change.

Access decision:

```text
active or canceling:
  allowed only while now <= current_period_end

past_due:
  allowed only while now <= past_due_grace_ends_at
  never issue new period credits without successful payment

canceled, expired, closed or pending without valid trial/payment:
  no subscription access
```

Successful recovery clears past-due fields and updates the paid period from authoritative facts. Effective cancellation/expiry also clears any stale grace deadline.

Required tests cover entry, boundary time, expiry, recovery, out-of-order events, changed product policy, duplicate events and reconciliation repair.

## 10. Fulfillment boundary during the commerce-only phase

PR 4 may use a `TestRecordingOrderFulfillment` in tests to prove command creation and idempotency.

Production rules:

- no `NoopOrderFulfillment` may report success;
- if a paid product lacks a configured real fulfillment handler, the fulfillment job remains `pending_configuration` or dead-lettered with an alert;
- production release validation rejects enabled paid products without a fulfillment binding;
- payment/order truth remains valid even if entitlement fulfillment is pending.

## 11. Revised code-start gates

### 11.1 Foundation/auth/SEO work may start only after

1. architecture review is complete;
2. this binding correction and the execution-plan correction are independently reviewed;
3. all resulting BLOCKING/IMPORTANT findings are resolved;
4. owner explicitly approves the reviewed design and plan suite;
5. foundation plan remains file-level and test-specific;
6. the assistant states exactly: `设计已经定稿，现在可以开始写代码。`

### 11.2 Commerce/Waffo work has an additional gate

Before the first Waffo adapter implementation task:

- test account/store/product/webhook resources exist;
- exact event names, signature header/encoding, environment/store identifiers, payload fields, amount representation and provider capabilities are captured in reviewed sanitized contract fixtures;
- no event or field is invented from memory.

Waffo contract capture does not block unrelated foundation, authentication or SEO implementation after the general code-start gate passes.

## 12. Primary references

- Better Auth magic link: https://better-auth.com/docs/plugins/magic-link
- Better Auth user/account deletion: https://better-auth.com/docs/concepts/users-accounts
- Better Auth database hooks: https://better-auth.com/docs/concepts/database
- Better Auth verification storage: https://better-auth.com/docs/reference/options
- Next.js environment variables: https://nextjs.org/docs/app/guides/environment-variables
- Next.js metadata: https://nextjs.org/docs/app/api-reference/functions/generate-metadata
- Next.js scripts: https://nextjs.org/docs/app/guides/scripts
- Waffo orders/payments: https://docs.waffo.ai/zh/features/orders-payments
- Waffo subscriptions: https://docs.waffo.ai/zh/features/subscriptions
- Google canonical guidance: https://developers.google.com/search/docs/crawling-indexing/canonicalization

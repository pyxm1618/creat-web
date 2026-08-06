# creat-web Security, Operations, and Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete consent-aware analytics, abuse protection, security headers, operational workers, health/alerting, backup/restore/key rotation, template versioning, clean-project validation, and isolated staging production-readiness verification.

**Architecture:** Optional analytics load only through a versioned consent manager. Turnstile and durable rate limits protect sensitive unauthenticated endpoints. Security headers are generated from enabled integrations without broad wildcards. Durable database jobs are processed through authenticated internal routes/scripts with observable retry/dead-letter state. Final validation creates and deploys a neutral sample product from a clean checkout.

**Tech Stack:** Next.js, Cloudflare Turnstile siteverify API, GA4, optional Microsoft Clarity, PostgreSQL durable jobs, Vercel Cron/internal routes, Playwright, Vitest, `pg_dump`/`pg_restore`, GitHub Actions.

## Global Constraints

- Execute only after the subscriptions/refunds plan exit gate passes.
- Optional analytics must not load before required consent and must stop loading after withdrawal on the next navigation/reload.
- Rejecting analytics must not block authentication, payments, credits, account deletion, or core product use.
- Analytics events may never include email, private user content, auth/session tokens, payment details, generated private results, full IPs, or provider payloads.
- Turnstile is defense-in-depth and never replaces server-side authorization, validation, or durable rate limits.
- CSP/security headers must be tested and may not use `*` or unnecessary `unsafe-eval`; exceptions require a documented ADR and automated regression test.
- Internal cron/worker/operator routes require cryptographic authentication and fail closed.
- Health endpoints reveal no secrets, connection strings, user counts, order IDs, or provider details.
- Backup/restore is not complete until a restore into an isolated database passes migrations and smoke tests.
- Production release remains blocked if sample/placeholder SEO/legal/product values remain.
- The final clean-project validation may not require undocumented edits to platform internals.

---

## File Map

- `src/platform/consent/types.ts` — consent categories/version.
- `src/platform/consent/cookie.ts` — validated preference persistence.
- `src/platform/consent/consent-manager.tsx` — accessible UI/context.
- `src/platform/analytics/types.ts` — allowlisted event contract.
- `src/platform/analytics/ga4.ts`, `src/platform/analytics/clarity.ts` — delayed loaders/adapters.
- `public/analytics/ga4-loader.js`, `public/analytics/clarity-loader.js` — self-hosted loaders compatible with CSP.
- `src/platform/security/turnstile.ts` — server verification.
- `src/platform/security/headers.ts` — CSP and security header generation.
- `src/platform/security/request-origin.ts` — trusted proxy/origin rules.
- `src/app/api/internal/jobs/*` — authenticated bounded job runners.
- `src/platform/jobs/authenticate-internal-request.ts` — cron signature/secret checks.
- `src/app/api/health/live/route.ts`, `src/app/api/health/ready/route.ts` — minimal health.
- `src/platform/observability/metrics.ts`, `src/platform/observability/alerts.ts` — operational signals.
- `scripts/inspect-dead-letters.ts`, `scripts/retry-dead-letter.ts` — operator recovery.
- `vercel.json` — reviewed schedules only.
- `docs/runbooks/*` — incidents, backup/restore, key rotation, release/rollback.
- `src/config/template-version.ts`, `CHANGELOG.md`, `SECURITY.md` — owned-project versioning/advisory process.
- `examples/neutral-product/*` or config fixture — clean sample product inputs without duplicating platform code.
- `tests/unit/consent/*`, `tests/unit/security/*`, `tests/integration/operations/*`, `tests/e2e/consent.spec.ts`, `tests/e2e/security.spec.ts`, `tests/e2e/release.spec.ts`.

### Task 1: Implement versioned consent preferences and accessible settings UI

**Files:**
- Create: `src/platform/consent/types.ts`
- Create: `src/platform/consent/cookie.ts`
- Create: `src/platform/consent/consent-manager.tsx`
- Create: `src/components/consent/consent-banner.tsx`
- Create: `src/components/consent/consent-settings.tsx`
- Create: `tests/unit/consent/cookie.test.ts`
- Create: `tests/e2e/consent.spec.ts`
- Modify: `src/app/layout.tsx`
- Modify: legal cookie/settings route

**Interfaces:**
- Produces `ConsentPreferences = { version: 1; analytics: boolean; updatedAt: string }`.
- Produces `readConsentCookie`, `writeConsentCookie`, `clearConsentCookie`.
- Produces client hook `useConsent()` with `acceptAnalytics`, `rejectAnalytics`, `withdrawAnalytics`.

- [ ] **Step 1: Write failing cookie validation tests**

```ts
import { expect, it } from "vitest";
import { decodeConsent, encodeConsent } from "@/platform/consent/cookie";

it("round-trips a versioned analytics preference", () => {
  const value = { version: 1 as const, analytics: true, updatedAt: "2026-08-06T00:00:00.000Z" };
  expect(decodeConsent(encodeConsent(value))).toEqual(value);
});

it("rejects malformed, unsupported-version and extra-category input", () => {
  expect(decodeConsent("not-json")).toBeNull();
  expect(decodeConsent(btoa(JSON.stringify({ version: 2, analytics: true })))).toBeNull();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun run test:unit -- tests/unit/consent/cookie.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement strict preference encoding**

Use URL-safe base64 of validated JSON. Cookie attributes: `Path=/`, `SameSite=Lax`, `Secure` outside local development, one-year max age, product-specific name derived from site slug. The cookie is not a security credential and contains no user ID.

- [ ] **Step 4: Implement accessible banner/settings**

Banner presents equally visible “Accept analytics” and “Reject analytics”, does not block core page interaction, traps no focus, and links to privacy/cookie information. Settings allow later withdrawal. Necessary storage is explained separately and cannot be falsely toggled off while authenticated/payment functions are used.

- [ ] **Step 5: Write/run E2E**

E2E asserts first visit shows banner, reject hides it and preserves core navigation/sign-in/pricing, settings can accept then withdraw, keyboard navigation works, and no analytics request is made before acceptance.

Run:

```bash
bun run test:unit -- tests/unit/consent/cookie.test.ts
bun run test:e2e -- tests/e2e/consent.spec.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/platform/consent src/components/consent src/app/layout.tsx src/app/'(legal)' tests/unit/consent tests/e2e/consent.spec.ts
git commit -m "feat: add accessible versioned analytics consent"
```

### Task 2: Add consent-gated GA4 and optional Clarity adapters

**Files:**
- Create: `src/platform/analytics/types.ts`
- Create: `src/platform/analytics/sanitize-event.ts`
- Create: `src/platform/analytics/analytics-provider.tsx`
- Create: `src/platform/analytics/ga4.ts`
- Create: `src/platform/analytics/clarity.ts`
- Create: `public/analytics/ga4-loader.js`
- Create: `public/analytics/clarity-loader.js`
- Create: `tests/unit/analytics/sanitize-event.test.ts`
- Modify: `tests/e2e/consent.spec.ts`

**Interfaces:**
- Produces `track(event: AllowedAnalyticsEvent): void`.
- Produces an explicit event union; arbitrary key/value analytics calls are forbidden.

- [ ] **Step 1: Write failing sanitizer tests**

```ts
import { expect, it } from "vitest";
import { sanitizeAnalyticsEvent } from "@/platform/analytics/sanitize-event";

it("allows only declared non-sensitive fields", () => {
  expect(sanitizeAnalyticsEvent({ name: "checkout_started", productKey: "starter_monthly", source: "pricing" })).toEqual({
    name: "checkout_started",
    productKey: "starter_monthly",
    source: "pricing",
  });
});

it("rejects email, token, private content and payment identifiers", () => {
  expect(() => sanitizeAnalyticsEvent({ name: "checkout_started", email: "u@example.com" } as never)).toThrow("forbidden analytics field");
  expect(() => sanitizeAnalyticsEvent({ name: "tool_completed", result: "private text" } as never)).toThrow("forbidden analytics field");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun run test:unit -- tests/unit/analytics/sanitize-event.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement allowlisted event union and delayed loaders**

```ts
export type AllowedAnalyticsEvent =
  | { name: "page_view"; route: string }
  | { name: "primary_cta_clicked"; route: string; target: string }
  | { name: "sign_in_started"; method: "google" | "magic_link" }
  | { name: "checkout_started"; productKey: string; source: "pricing" | "account" }
  | { name: "checkout_returned"; state: "processing" | "paid" | "canceled" }
  | { name: "consent_updated"; analytics: boolean };
```

The provider inserts external scripts only after consent and only when the matching feature/ID is enabled. Self-hosted loader files initialize providers without inline script so CSP can remain strict. Withdrawal disables future calls and removes locally created analytics cookies where provider-supported/declared; it cannot guarantee deletion of already transmitted data and legal text must say so accurately.

- [ ] **Step 4: Extend network E2E**

Intercept `googletagmanager.com`, `google-analytics.com`, `clarity.ms` and assert zero requests before consent/rejection, requests after acceptance only for enabled providers, and no new requests after withdrawal/reload. Assert event payloads never contain seeded email/private/payment values.

- [ ] **Step 5: Run tests and commit**

Run:

```bash
bun run test:unit -- tests/unit/analytics/sanitize-event.test.ts
bun run test:e2e -- tests/e2e/consent.spec.ts
```

Expected: PASS.

```bash
git add src/platform/analytics public/analytics tests/unit/analytics tests/e2e/consent.spec.ts
git commit -m "feat: load analytics only after valid consent"
```

### Task 3: Implement Turnstile verification for sensitive unauthenticated actions

**Files:**
- Create: `src/platform/security/turnstile.ts`
- Create: `src/components/security/turnstile-widget.tsx`
- Create: `tests/unit/security/turnstile.test.ts`
- Create: `tests/integration/security/turnstile.test.ts`
- Modify: magic-link send action/route
- Modify: `.env.example`

**Interfaces:**
- Produces `verifyTurnstile({ token, remoteIp?, expectedAction }): Promise<TurnstileDecision>`.

- [ ] **Step 1: Write failing response-validation tests**

Tests cover success with matching hostname/action, missing token, timeout/duplicate token, hostname mismatch, action mismatch, provider timeout, malformed response, and test bypass allowed only in `NODE_ENV=test` with a dedicated test token.

- [ ] **Step 2: Run to verify failure**

Run: `bun run test:unit -- tests/unit/security/turnstile.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement server verification**

POST form data to `https://challenges.cloudflare.com/turnstile/v0/siteverify` with secret, response token, optional trusted remote IP and idempotency key. Validate `success`, expected action, allowed hostname, challenge timestamp age and error codes. Log only decision category/correlation ID; never the token.

```ts
export type TurnstileDecision = { allowed: true } | { allowed: false; reason: "missing" | "provider_rejected" | "mismatch" | "unavailable" };
```

- [ ] **Step 4: Integrate with magic-link send without weakening rate limits**

Required order:

1. schema validation;
2. IP/email durable rate-limit precheck;
3. Turnstile verification where enabled;
4. generic magic-link response;
5. durable send accounting.

Provider outage policy is explicit: fail closed for abnormal/high-risk traffic; ordinary production behavior follows reviewed threat model and never bypasses durable limits.

- [ ] **Step 5: Run tests and commit**

Run:

```bash
bun run test:unit -- tests/unit/security/turnstile.test.ts
TEST_DATABASE_URL="$TEST_DATABASE_URL" bun run test:integration -- tests/integration/security/turnstile.test.ts tests/integration/auth/rate-limit.test.ts
```

Expected: PASS.

```bash
git add src/platform/security/turnstile.ts src/components/security/turnstile-widget.tsx tests/unit/security/turnstile.test.ts tests/integration/security/turnstile.test.ts src/platform/auth .env.example
git commit -m "feat: protect sensitive public actions with Turnstile"
```

### Task 4: Add trusted-origin/proxy rules and strict security headers

**Files:**
- Create: `src/platform/security/request-origin.ts`
- Create: `src/platform/security/headers.ts`
- Create: `tests/unit/security/request-origin.test.ts`
- Create: `tests/unit/security/headers.test.ts`
- Create: `tests/e2e/security.spec.ts`
- Modify: `next.config.ts`

**Interfaces:**
- Produces `resolveClientIp(headers, trustedProxyPolicy): string | null`.
- Produces `securityHeaders(features, environment): HeaderDefinition[]`.

- [ ] **Step 1: Write failing spoofed-proxy and CSP tests**

Tests assert direct attacker `x-forwarded-for` is ignored unless request comes through the configured topology, multiple-hop selection follows documented rule, CSP contains only enabled analytics/payment origins, no `*`, no `unsafe-eval`, HSTS only production HTTPS, frame ancestors deny embedding, and permissions policy disables unused sensors.

- [ ] **Step 2: Run to verify failure**

Run: `bun run test:unit -- tests/unit/security`

Expected: FAIL.

- [ ] **Step 3: Implement explicit header set**

Required production headers:

```text
Content-Security-Policy
Strict-Transport-Security: max-age=31536000; includeSubDomains
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: camera=(), microphone=(), geolocation=()
Cross-Origin-Opener-Policy: same-origin-allow-popups
X-Frame-Options: DENY (or rely on frame-ancestors with compatibility decision)
```

CSP starts with:

```text
default-src 'self';
base-uri 'self';
object-src 'none';
frame-ancestors 'none';
form-action 'self';
script-src 'self' <enabled analytics script origins>;
connect-src 'self' <enabled analytics API origins> <Turnstile origins>;
img-src 'self' data: blob: <enabled analytics image origins>;
style-src 'self' 'unsafe-inline';
font-src 'self';
upgrade-insecure-requests;
```

Any retained `'unsafe-inline'` for styles is documented; scripts do not use it.

- [ ] **Step 4: Run unit/build/browser tests**

Run:

```bash
bun run test:unit -- tests/unit/security
bun run build
bun run test:e2e -- tests/e2e/security.spec.ts tests/e2e/consent.spec.ts tests/e2e/auth.spec.ts
```

Expected: PASS with no browser CSP violations for enabled flows.

- [ ] **Step 5: Commit**

```bash
git add src/platform/security/request-origin.ts src/platform/security/headers.ts tests/unit/security tests/e2e/security.spec.ts next.config.ts
git commit -m "feat: enforce trusted proxy rules and security headers"
```

### Task 5: Add authenticated bounded internal job routes

**Files:**
- Create: `src/platform/jobs/authenticate-internal-request.ts`
- Create: `src/platform/jobs/run-bounded-job.ts`
- Create: `src/app/api/internal/jobs/commerce/route.ts`
- Create: `src/app/api/internal/jobs/reconcile/route.ts`
- Create: `src/app/api/internal/jobs/credit-expiry/route.ts`
- Create: `src/app/api/internal/jobs/account-deletion/route.ts`
- Create: `tests/integration/operations/internal-jobs.test.ts`
- Create: `vercel.json`
- Modify: `.env.example`

**Interfaces:**
- Produces `authenticateInternalRequest(request): void`.
- Produces `runBoundedJob({ name, limit, maxRuntimeMs, worker }): JobRunResult`.

- [ ] **Step 1: Write failing authentication/boundary tests**

Tests assert missing/wrong bearer secret returns 401, correct secret runs at most configured batch size, concurrent requests lease different rows, max runtime stops fetching new work, job failure returns non-sensitive summary while durable rows retain retry state, and public search engines cannot index routes.

- [ ] **Step 2: Run to verify failure**

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" bun run test:integration -- tests/integration/operations/internal-jobs.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement internal request authentication**

Use a purpose-specific `CRON_SECRET` of sufficient entropy and timing-safe comparison of `Authorization: Bearer <secret>`. Do not reuse Better Auth, webhook, encryption or hash secrets. Reject query-string secrets.

- [ ] **Step 4: Implement bounded routes and schedules**

Routes call existing lease/process functions with small batches and maximum runtime below platform timeout. `vercel.json` schedules reviewed cadences, for example:

```json
{
  "crons": [
    { "path": "/api/internal/jobs/commerce", "schedule": "*/5 * * * *" },
    { "path": "/api/internal/jobs/reconcile", "schedule": "17 * * * *" },
    { "path": "/api/internal/jobs/credit-expiry", "schedule": "31 * * * *" },
    { "path": "/api/internal/jobs/account-deletion", "schedule": "47 * * * *" }
  ]
}
```

If the deployed Vercel plan does not support a cadence, adjust the committed schedule and runbook before release; do not claim a job runs when it does not.

- [ ] **Step 5: Run tests and commit**

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" bun run test:integration -- tests/integration/operations/internal-jobs.test.ts`

Expected: PASS.

```bash
git add src/platform/jobs src/app/api/internal/jobs tests/integration/operations/internal-jobs.test.ts vercel.json .env.example
git commit -m "feat: run durable jobs through authenticated bounded routes"
```

### Task 6: Add minimal health, metrics, alerts, and dead-letter operations

**Files:**
- Create: `src/app/api/health/live/route.ts`
- Create: `src/app/api/health/ready/route.ts`
- Create: `src/platform/observability/metrics.ts`
- Create: `src/platform/observability/alerts.ts`
- Create: `scripts/inspect-dead-letters.ts`
- Create: `scripts/retry-dead-letter.ts`
- Create: `tests/integration/operations/health-alerts.test.ts`
- Create: `docs/runbooks/dead-letters.md`

**Interfaces:**
- Produces safe health responses and alert events.
- Produces operator scripts requiring explicit environment, record ID and reason.

- [ ] **Step 1: Write failing health/alert tests**

Tests assert liveness never touches DB/providers and returns only `{ status: "ok" }`; readiness performs bounded DB/migration checks and returns generic degraded code; response contains no URLs/IDs/counts. Alert tests cover dead-letter created, magic-link volume spike, webhook invalid-signature spike, reconciliation mismatch, job backlog/lease age and repeated provider outage.

- [ ] **Step 2: Run to verify failure**

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" bun run test:integration -- tests/integration/operations/health-alerts.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement metrics/alerts**

Use structured log/metric events with bounded labels; never label by user/order/payment/session ID. Alert delivery may initially be provider-neutral logging plus configured email destination, but release requires a tested destination and documented escalation path.

- [ ] **Step 4: Implement dead-letter scripts**

`inspect-dead-letters.ts` is read-only and redacted. `retry-dead-letter.ts` requires `--environment`, `--id`, `--reason`, `--confirm`, fresh operator credentials/allowlist where invoked through UI, and records immutable audit event. It requeues through repository domain methods; it does not patch business state directly.

- [ ] **Step 5: Run tests and commit**

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" bun run test:integration -- tests/integration/operations/health-alerts.test.ts`

Expected: PASS.

```bash
git add src/app/api/health src/platform/observability scripts/inspect-dead-letters.ts scripts/retry-dead-letter.ts tests/integration/operations/health-alerts.test.ts docs/runbooks/dead-letters.md
git commit -m "feat: add safe health alerting and dead-letter operations"
```

### Task 7: Create and verify backup, restore, key rotation and rollback runbooks

**Files:**
- Create: `docs/runbooks/database-backup-restore.md`
- Create: `docs/runbooks/key-rotation.md`
- Create: `docs/runbooks/release-rollback.md`
- Create: `scripts/verify-restored-database.ts`
- Create: `tests/integration/operations/restored-database.test.ts`

**Interfaces:**
- Produces reproducible restore verification and purpose-specific rotation procedures.

- [ ] **Step 1: Write restored-database smoke test**

Test validates migration history, Better Auth tables, commerce/credit/subscription constraints, no duplicate idempotency keys, ledger reconciliation, and synthetic owner-scoped reads against `RESTORED_DATABASE_URL`.

- [ ] **Step 2: Document exact backup/restore commands**

The runbook contains tested commands:

```bash
pg_dump "$DATABASE_URL" --format=custom --no-owner --no-acl --file=creat-web.dump
createdb creat_web_restore_test
pg_restore --dbname="$RESTORED_DATABASE_URL" --no-owner --no-acl creat-web.dump
RESTORED_DATABASE_URL="$RESTORED_DATABASE_URL" bun scripts/verify-restored-database.ts
```

For managed providers, also document dashboard/PITR steps, retention and responsible operator. No production dump is committed or copied into tests.

- [ ] **Step 3: Document separate key rotations**

Cover Better Auth secret, Google client secret, Resend key, Waffo private key, Waffo webhook secret, Turnstile secret, cron secret, database credentials and analytics IDs. For each: create new, overlap/dual validation where supported, deploy, verify, revoke old, rollback, incident evidence. Never reuse one secret for another purpose.

- [ ] **Step 4: Execute a real isolated restore drill**

Use synthetic/staging data only. Run dump/restore/smoke test and record date/result in the PR. Intentionally invalidate a disposable key in staging, follow rotation/rollback, and verify service recovery.

- [ ] **Step 5: Commit**

```bash
git add docs/runbooks/database-backup-restore.md docs/runbooks/key-rotation.md docs/runbooks/release-rollback.md scripts/verify-restored-database.ts tests/integration/operations/restored-database.test.ts
git commit -m "docs: verify backup restore rotation and rollback"
```

### Task 8: Add template versioning, security advisory and upgrade tracking

**Files:**
- Create: `src/config/template-version.ts`
- Create: `CHANGELOG.md`
- Create: `SECURITY.md`
- Create: `docs/upgrade/owned-project-upgrades.md`
- Create: `tests/unit/release/template-version.test.ts`
- Modify: `README.md`

**Interfaces:**
- Produces `TEMPLATE_VERSION` and an owned-project manual update process.

- [ ] **Step 1: Write failing version test**

```ts
import { expect, it } from "vitest";
import { TEMPLATE_VERSION } from "@/config/template-version";

it("uses semantic version format", () => {
  expect(TEMPLATE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun run test:unit -- tests/unit/release/template-version.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement version and owned-project update rules**

Start at `0.1.0`. Every security/platform fix records affected modules/files, migrations, required environment/provider changes, verification commands and whether owned projects require manual port/cherry-pick. `SECURITY.md` contains private reporting contact, supported owned-project versions, severity handling and no public disclosure promises that cannot be met.

- [ ] **Step 4: Run tests and commit**

Run: `bun run test:unit -- tests/unit/release/template-version.test.ts`

Expected: PASS.

```bash
git add src/config/template-version.ts CHANGELOG.md SECURITY.md docs/upgrade/owned-project-upgrades.md tests/unit/release/template-version.test.ts README.md
git commit -m "chore: version and track the private starter"
```

### Task 9: Validate a neutral product from a clean checkout

**Files:**
- Create: `examples/neutral-product/site.config.ts`
- Create: `examples/neutral-product/features.config.ts`
- Create: `examples/neutral-product/products.config.ts`
- Create: `examples/neutral-product/seo.config.ts`
- Create: `examples/neutral-product/routes.config.ts`
- Create: `examples/neutral-product/legal.config.ts`
- Create: `scripts/apply-example-config.ts`
- Create: `scripts/verify-clean-setup.ts`
- Create: `tests/e2e/release.spec.ts`
- Create: `docs/setup/new-product.md`

**Interfaces:**
- Produces a documented copy/configuration workflow without a public CLI or platform-code duplication.

- [ ] **Step 1: Define neutral sample inputs**

The example uses a non-I-Ching fictional utility, synthetic operator/contact facts explicitly marked test-only, one one-time credit product, one monthly subscription credit product, Google/magic link enabled, GA4 disabled, Clarity disabled. No production release claim is made from sample facts.

- [ ] **Step 2: Implement deterministic config application**

`apply-example-config.ts` copies only versioned config/content assets into the working tree after verifying target paths and refusing to overwrite modified files without `--confirm`. It never copies platform code and is not published as a CLI.

- [ ] **Step 3: Write clean setup verification script**

The script creates a temporary clone/worktree, applies sample config, writes test-only environment values, starts a fresh PostgreSQL database, runs migrations and the complete offline gate:

```bash
bun install --frozen-lockfile
bun run db:migrate
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
bun run verify:release --mode=test
```

It fails on any undocumented manual file edit or Quick I Ching reference.

- [ ] **Step 4: Execute from a clean environment**

A different agent/developer follows `docs/setup/new-product.md` from the repository README without prior context. Record every ambiguity; fix docs/scripts and rerun from a new clean checkout until it passes without oral guidance.

- [ ] **Step 5: Commit**

```bash
git add examples/neutral-product scripts/apply-example-config.ts scripts/verify-clean-setup.ts tests/e2e/release.spec.ts docs/setup/new-product.md
git commit -m "test: validate starter setup from a clean checkout"
```

### Task 10: Deploy isolated staging and execute the production-readiness checklist

**Files:**
- Create: `docs/releases/v0.1.0-staging-verification.md`
- Modify: `scripts/verify-release.ts`
- Modify: `README.md`

**Interfaces:**
- Produces final evidence for `creat-web v0.1.0` internal starter readiness.

- [ ] **Step 1: Provision isolated staging**

Use a separate Vercel project, staging PostgreSQL database, Google OAuth credentials/origin, Resend sender/config, Waffo test merchant/store/products/webhook, Turnstile test/staging keys, analytics IDs disabled or isolated, cron secret, and alert destination. No production key appears in staging.

- [ ] **Step 2: Run all staging journeys**

Verify:

- public SEO pages initial HTML/metadata/canonical/robots/sitemap/JSON-LD/internal links;
- staging layered noindex and no production sitemap submission;
- mobile/accessibility/performance representative checks;
- Google and magic-link sign-in, atomic link reuse failure, session controls;
- one-time Waffo test checkout, processing return, signed webhook, one credit grant;
- credit reserve/commit/release/expiry/reconciliation;
- subscription activation/period grant/past_due policy/cancel/restore/canceled;
- refund success/failure and source-bounded reversal;
- consent reject/accept/withdraw and network behavior;
- Turnstile/rate-limit abuse paths;
- job schedules, reconciliation, dead-letter retry and alerts;
- account deletion with subscription cancellation and financial retention;
- backup/restore and key rotation drills.

- [ ] **Step 3: Run complete final command gate**

```bash
bun install --frozen-lockfile
bun run format:check
bun run lint
bun run typecheck
bun run test:unit
TEST_DATABASE_URL="$TEST_DATABASE_URL" bun run test:integration
bun run test:contract
bun run build
bun run test:e2e
bun run verify:architecture
bun run verify:secrets
bun run verify:release --mode=staging
```

Expected: every command exits `0` with no skipped required suite.

- [ ] **Step 4: Perform forbidden-reference and secret scan**

Run repository-wide scans for Quick I Ching names/concepts/IDs/domains, test/live card/private keys, webhook bodies, emails and placeholders. Historical design documents may mention Quick I Ching only as the read-only source boundary; application/config/fixtures may not.

- [ ] **Step 5: Record evidence and unresolved limits**

`docs/releases/v0.1.0-staging-verification.md` lists exact commit, dependency versions, migration count, commands/results, staging checks, provider capabilities, known unsupported features (including in-place plan changes), operational owners, and any optional future work. Do not mark production-ready if any blocking check is absent.

- [ ] **Step 6: Commit**

```bash
git add docs/releases/v0.1.0-staging-verification.md scripts/verify-release.ts README.md
git commit -m "docs: record creat-web v0.1.0 staging verification"
```

## Security/Operations/Release Exit Gate

Before requesting final review, prove:

- analytics makes zero network requests before consent/rejection and sends only allowlisted fields after acceptance;
- withdrawal prevents new analytics loads and legal text matches actual behavior;
- Turnstile validation checks action/hostname and remains combined with durable limits;
- trusted proxy/IP logic resists spoofed forwarded headers;
- CSP/security headers pass browser flows without broad wildcard or unsafe script exceptions;
- internal job routes reject unauthenticated requests and process bounded leased work;
- liveness/readiness leak no sensitive data;
- alerts and dead-letter inspection/retry are tested and audited;
- backup restore into an isolated database passes smoke/reconciliation tests;
- all purpose-specific key rotation and rollback procedures have been drilled in staging;
- a different agent launches the neutral sample from a clean checkout without undocumented edits;
- isolated staging passes auth, payment, credit, subscription, refund, consent, security, job, deletion and SEO journeys;
- all final commands exit `0` and no Quick I Ching product code/copy/IDs or secrets appear in application code/fixtures;
- the reviewer agrees `creat-web v0.1.0` is ready for internal reuse, not public commercialization.
